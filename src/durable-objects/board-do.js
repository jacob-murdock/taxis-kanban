import * as Y from "yjs";
import { YjsRoom } from "./yjs-room.js";
import { materializeBoardCards } from "../lib/materialize.js";

function createEmptyBoardDoc() {
  const doc = new Y.Doc();
  doc.getArray("cards");
  return doc;
}

export class BoardDO extends YjsRoom {
  constructor(ctx, env) {
    super(ctx, env, {
      createDoc: createEmptyBoardDoc,
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.endsWith("/snapshot")) {
      await this.ensureDoc();
      return Response.json({ cards: materializeBoardCards(this.doc) });
    }

    if (request.method === "POST" && url.pathname.endsWith("/cards")) {
      return this.handleUpsertCard(request);
    }

    return super.fetch(request);
  }

  /** Insert or update a card summary, keyed by job id. Idempotent. */
  async handleUpsertCard(request) {
    const body = await request.json();
    if (!body.id) {
      return Response.json({ error: "Missing id" }, { status: 400 });
    }

    await this.ensureDoc();
    const cards = this.doc.getArray("cards");
    const existingIdx = cards.toArray().findIndex((c) => c?.id === body.id);
    const base = existingIdx >= 0 ? cards.get(existingIdx) : {};

    const card = {
      id: body.id,
      slug: body.slug ?? base.slug ?? "",
      title: body.title ?? base.title ?? "",
      clientName: body.clientName ?? base.clientName ?? "",
      due: body.due ?? base.due ?? null,
      status: body.status ?? base.status ?? "lead",
      updatedAt: new Date().toISOString(),
    };

    // Mutation fires the doc "update" handler, which persists + relays to peers.
    this.doc.transact(() => {
      if (existingIdx >= 0) {
        cards.delete(existingIdx, 1);
        cards.insert(existingIdx, [card]);
      } else {
        cards.push([card]);
      }
    });

    return Response.json({ ok: true }, { status: 201 });
  }
}
