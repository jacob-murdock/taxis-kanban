import * as Y from "yjs";
import { YjsRoom } from "./yjs-room.js";
import { materializeCatalog } from "../lib/materialize.js";

function createEmptyCatalogDoc() {
  const doc = new Y.Doc();
  doc.getMap("boards");
  return doc;
}

export class CatalogDO extends YjsRoom {
  constructor(ctx, env) {
    super(ctx, env, {
      createDoc: createEmptyCatalogDoc,
      clientUpdates: false,
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.endsWith("/snapshot")) {
      await this.ensureDoc();
      return Response.json({ boards: materializeCatalog(this.doc) });
    }

    if (request.method === "POST" && url.pathname.endsWith("/boards")) {
      return this.handleUpsertBoard(request);
    }

    return super.fetch(request);
  }

  migrateDoc(doc, fromVersion) {
    if (fromVersion < 1) doc.getMap("boards");
  }

  /** Insert or update a board summary. Called by BoardDO on name/archive changes. */
  async handleUpsertBoard(request) {
    const body = await request.json();
    if (!body?.id || typeof body.id !== "string") {
      return Response.json({ error: "Missing id" }, { status: 400 });
    }

    await this.ensureDoc();
    const boards = this.doc.getMap("boards");
    let created = false;

    this.doc.transact(() => {
      let entry = boards.get(body.id);
      if (!(entry instanceof Y.Map)) {
        created = true;
        entry = new Y.Map();
        boards.set(body.id, entry);
        entry.set("id", body.id);
        entry.set("name", body.name ?? "Untitled board");
        entry.set("archived", Boolean(body.archived ?? false));
        entry.set("createdAt", body.createdAt ?? new Date().toISOString());
        return;
      }

      if (body.name !== undefined) entry.set("name", body.name);
      if (body.archived !== undefined) entry.set("archived", Boolean(body.archived));
    });

    // BoardDO drops the retry row on 200. The catalog row has to be durable first.
    if (!(await this.awaitPersisted())) {
      return Response.json({ error: "Failed to persist" }, { status: 500 });
    }

    return Response.json({ ok: true }, { status: created ? 201 : 200 });
  }
}
