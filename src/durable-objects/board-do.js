import * as Y from "yjs";
import { YjsRoom } from "./yjs-room.js";
import {
  applyCardSummaryToYMap,
  createEmptyBoardDoc,
  generateColumnId,
  materializeBoard,
} from "../lib/materialize.js";
import {
  rankAppend,
  rankInsertBefore,
  renumberRanks,
  sortByRankThenId,
} from "../lib/rank.js";
import { BOARD_NAME_MAX } from "../lib/constants.js";
import { readJson } from "../lib/json.js";
import { safeDecode } from "../lib/path.js";
import {
  clampAssignee,
  clampColumnName,
  clampDue,
  clampLabels,
  clampStoredTitle,
} from "../lib/fields.js";

export class BoardDO extends YjsRoom {
  constructor(ctx, env) {
    super(ctx, env, {
      createDoc: () => createEmptyBoardDoc(null),
      clientUpdates: false,
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path.endsWith("/revoke-sockets")) {
      return super.fetch(request);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const gate = await this.requireReady();
      if (gate) return gate;
      return super.fetch(request);
    }

    if (request.method === "POST" && path.endsWith("/init")) {
      return this.handleInit(request);
    }

    const gate = await this.requireReady();
    if (gate) return gate;

    if (request.method === "GET" && path.endsWith("/snapshot")) {
      return Response.json(materializeBoard(this.doc));
    }

    if (request.method === "PATCH" && path.endsWith("/meta")) {
      return this.handlePatchMeta(request);
    }

    if (request.method === "POST" && path.endsWith("/columns/order")) {
      return this.handleReorderColumns(request);
    }

    const columnMatch = path.match(/\/columns\/([^/]+)$/);
    if (columnMatch) {
      const columnId = safeDecode(columnMatch[1]);
      if (columnId == null) {
        return Response.json({ error: "Invalid path encoding" }, { status: 400 });
      }
      if (request.method === "PATCH") return this.handleRenameColumn(request, columnId);
      if (request.method === "DELETE") return this.handleDeleteColumn(columnId);
    }

    if (request.method === "POST" && path.endsWith("/columns")) {
      return this.handleAddColumn(request);
    }

    if (request.method === "POST" && path.endsWith("/cards/summary")) {
      return this.handleSyncCardSummary(request);
    }

    const cardMove = path.match(/\/cards\/([^/]+)\/move$/);
    if (cardMove && request.method === "POST") {
      const cardId = safeDecode(cardMove[1]);
      if (cardId == null) {
        return Response.json({ error: "Invalid path encoding" }, { status: 400 });
      }
      return this.handleMoveCard(request, cardId);
    }

    const cardDelete = path.match(/\/cards\/([^/]+)$/);
    if (cardDelete && request.method === "DELETE") {
      const cardId = safeDecode(cardDelete[1]);
      if (cardId == null) {
        return Response.json({ error: "Invalid path encoding" }, { status: 400 });
      }
      return this.handleDeleteCard(cardId);
    }

    if (request.method === "POST" && path.endsWith("/cards")) {
      return this.handleInsertCard(request);
    }

    return super.fetch(request);
  }

  async requireReady() {
    if (!(await this.isReady())) {
      return Response.json({ error: "Board not found" }, { status: 404 });
    }
    await this.ensureDoc();
    return null;
  }

  async handleInit(request) {
    if (await this.isReady()) {
      return Response.json({ error: "Board already exists" }, { status: 409 });
    }

    const { body, error } = await readJson(request);
    if (error) return error;
    if (!body.id || typeof body.id !== "string") {
      return Response.json({ error: "id is required" }, { status: 400 });
    }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, BOARD_NAME_MAX) : "";
    if (!name) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }

    await this.ensureDoc();
    this.doc.transact(() => {
      const meta = this.doc.getMap("meta");
      meta.set("id", body.id);
      meta.set("name", name);
      meta.set("archived", false);
    });
    await this.markReady();

    const synced = await this.syncToCatalog({
      id: body.id,
      name,
      archived: false,
      createdAt: new Date().toISOString(),
    });
    if (!synced) {
      return Response.json({ error: "Failed to sync catalog" }, { status: 500 });
    }

    return Response.json({ ok: true, id: body.id, name }, { status: 201 });
  }

  async handlePatchMeta(request) {
    const { body, error } = await readJson(request);
    if (error) return error;

    const meta = this.doc.getMap("meta");
    const id = meta.get("id");
    if (!id) {
      return Response.json({ error: "Board not found" }, { status: 404 });
    }

    if (body.name !== undefined && typeof body.name !== "string") {
      return Response.json({ error: "name must be a string" }, { status: 400 });
    }
    if (body.archived !== undefined && typeof body.archived !== "boolean") {
      return Response.json({ error: "archived must be a boolean" }, { status: 400 });
    }
    const name =
      typeof body.name === "string" ? body.name.trim().slice(0, BOARD_NAME_MAX) : null;
    if (body.name !== undefined && !name) {
      return Response.json({ error: "name must not be empty" }, { status: 400 });
    }

    this.doc.transact(() => {
      if (name) meta.set("name", name);
      if (typeof body.archived === "boolean") meta.set("archived", body.archived);
    });

    const synced = await this.syncToCatalog({
      id,
      name: meta.get("name"),
      archived: Boolean(meta.get("archived")),
    });
    if (!synced) {
      return Response.json({ error: "Failed to sync catalog" }, { status: 500 });
    }

    return Response.json({
      ok: true,
      id,
      name: meta.get("name"),
      archived: Boolean(meta.get("archived")),
    });
  }

  async handleAddColumn(request) {
    const { body, error } = await readJson(request);
    if (error) return error;
    const name = clampColumnName(body.name);
    if (!name) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }
    const column = { id: generateColumnId(), name };
    this.doc.transact(() => {
      this.doc.getArray("columns").push([column]);
    });

    return Response.json(column, { status: 201 });
  }

  async handleRenameColumn(request, columnId) {
    const { body, error } = await readJson(request);
    if (error) return error;
    const name = clampColumnName(body.name);
    if (!name) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }
    const columns = this.doc.getArray("columns");
    const idx = columns.toArray().findIndex((c) => c?.id === columnId);
    if (idx < 0) {
      return Response.json({ error: "Column not found" }, { status: 404 });
    }

    this.doc.transact(() => {
      columns.delete(idx, 1);
      columns.insert(idx, [{ id: columnId, name }]);
    });

    return Response.json({ id: columnId, name });
  }

  async handleDeleteColumn(columnId) {
    const columns = this.doc.getArray("columns");
    const list = columns.toArray();
    if (list.length <= 1) {
      return Response.json({ error: "Cannot delete the last column" }, { status: 400 });
    }

    const idx = list.findIndex((c) => c?.id === columnId);
    if (idx < 0) {
      return Response.json({ error: "Column not found" }, { status: 404 });
    }

    const hasCards = [...this.doc.getMap("cards").values()].some(
      (card) => card instanceof Y.Map && card.get("columnId") === columnId,
    );
    if (hasCards) {
      return Response.json({ error: "Column still has cards" }, { status: 400 });
    }

    this.doc.transact(() => {
      columns.delete(idx, 1);
    });

    return Response.json({ ok: true });
  }

  async handleReorderColumns(request) {
    const { body, error } = await readJson(request);
    if (error) return error;
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return Response.json({ error: "ids array is required" }, { status: 400 });
    }
    const columns = this.doc.getArray("columns");
    const current = columns.toArray();
    const currentIds = new Set(current.map((c) => c.id));
    if (body.ids.length !== current.length) {
      return Response.json({ error: "ids must match the current columns exactly" }, { status: 400 });
    }

    const seen = new Set();
    const byId = new Map(current.map((c) => [c.id, c]));
    const next = [];
    for (const id of body.ids) {
      if (!currentIds.has(id) || seen.has(id)) {
        return Response.json({ error: "ids must match the current columns exactly" }, { status: 400 });
      }
      seen.add(id);
      const col = byId.get(id);
      next.push({ id: col.id, name: col.name });
    }

    this.doc.transact(() => {
      columns.delete(0, columns.length);
      columns.push(next);
    });

    return Response.json({ ok: true, columns: next });
  }

  async handleInsertCard(request) {
    const { body, error } = await readJson(request);
    if (error) return error;
    if (!body.id || typeof body.id !== "string") {
      return Response.json({ error: "id is required" }, { status: 400 });
    }

    const columns = this.doc.getArray("columns").toArray();
    if (columns.length === 0) {
      return Response.json({ error: "Board has no columns" }, { status: 400 });
    }

    const columnId = body.columnId ?? columns[0].id;
    if (!columns.some((c) => c.id === columnId)) {
      return Response.json({ error: "Unknown column" }, { status: 400 });
    }

    const cards = this.doc.getMap("cards");
    if (cards.has(body.id)) {
      return Response.json({ error: "Card already on board" }, { status: 409 });
    }

    const ordered = this.cardsInColumn(columnId);
    const lastRank = ordered.length ? ordered[ordered.length - 1].rank : null;
    const rank = rankAppend(lastRank);

    this.doc.transact(() => {
      const card = new Y.Map();
      card.set("id", body.id);
      card.set("title", clampStoredTitle(body.title ?? "Untitled"));
      card.set("columnId", columnId);
      card.set("rank", rank);
      card.set("due", clampDue(body.due));
      card.set("assignee", clampAssignee(body.assignee ?? ""));
      card.set("labels", clampLabels(body.labels));
      card.set("archived", body.archived === true);
      card.set("updatedAt", new Date().toISOString());
      cards.set(body.id, card);
    });

    return Response.json({ ok: true, id: body.id, columnId, rank }, { status: 201 });
  }

  async handleMoveCard(request, cardId) {
    const { body, error } = await readJson(request);
    if (error) return error;
    if (!body.columnId || typeof body.columnId !== "string") {
      return Response.json({ error: "columnId is required" }, { status: 400 });
    }
    const columns = this.doc.getArray("columns").toArray();
    if (!columns.some((c) => c.id === body.columnId)) {
      return Response.json({ error: "Unknown column" }, { status: 400 });
    }

    const cards = this.doc.getMap("cards");
    const card = cards.get(cardId);
    if (!(card instanceof Y.Map)) {
      return Response.json({ error: "Card not on board" }, { status: 404 });
    }

    const beforeId = body.beforeId ?? null;
    if (beforeId && beforeId === cardId) {
      return Response.json({ error: "beforeId cannot be the moved card" }, { status: 400 });
    }

    const columnId = body.columnId;
    const placed = this.placeCard(cardId, card, columnId, beforeId);
    if (!placed.ok) {
      return Response.json({ error: placed.error }, { status: placed.status });
    }

    return Response.json({ ok: true, id: cardId, columnId, rank: placed.rank });
  }

  /**
   * Set columnId + rank for a card. Renumbers the column when the gap collapses.
   * @returns {{ok: true, rank: number} | {ok: false, error: string, status: number}}
   */
  placeCard(cardId, card, columnId, beforeId) {
    const others = this.cardsInColumn(columnId).filter((c) => c.id !== cardId);

    if (beforeId) {
      const beforeIdx = others.findIndex((c) => c.id === beforeId);
      if (beforeIdx < 0) {
        return { ok: false, error: "beforeId not in column", status: 400 };
      }

      const prevRank = beforeIdx > 0 ? others[beforeIdx - 1].rank : null;
      const beforeRank = others[beforeIdx].rank;
      let rank = rankInsertBefore(prevRank, beforeRank);

      if (rank == null) {
        const orderedIds = others.map((c) => c.id);
        orderedIds.splice(beforeIdx, 0, cardId);
        const ranks = renumberRanks(orderedIds);
        this.doc.transact(() => {
          for (const [id, nextRank] of ranks) {
            const entry = this.doc.getMap("cards").get(id);
            if (!(entry instanceof Y.Map)) continue;
            if (id === cardId) this.stampCard(entry, columnId, nextRank);
            else entry.set("rank", nextRank);
          }
        });
        return { ok: true, rank: ranks.get(cardId) };
      }

      this.doc.transact(() => this.stampCard(card, columnId, rank));
      return { ok: true, rank };
    }

    const lastRank = others.length ? others[others.length - 1].rank : null;
    const rank = rankAppend(lastRank);
    this.doc.transact(() => this.stampCard(card, columnId, rank));
    return { ok: true, rank };
  }

  stampCard(card, columnId, rank) {
    card.set("columnId", columnId);
    card.set("rank", rank);
    card.set("updatedAt", new Date().toISOString());
  }

  async handleDeleteCard(cardId) {
    const cards = this.doc.getMap("cards");
    if (!cards.has(cardId)) {
      return Response.json({ error: "Card not on board" }, { status: 404 });
    }

    this.doc.transact(() => {
      cards.delete(cardId);
    });

    return Response.json({ ok: true });
  }

  async handleSyncCardSummary(request) {
    const { body, error } = await readJson(request);
    if (error) return error;
    if (!body.id || typeof body.id !== "string") {
      return Response.json({ error: "Missing id" }, { status: 400 });
    }
    const cards = this.doc.getMap("cards");
    const card = cards.get(body.id);
    if (!(card instanceof Y.Map)) {
      return Response.json({ error: "Card not on board" }, { status: 404 });
    }

    this.doc.transact(() => {
      applyCardSummaryToYMap(card, body);
    });

    return Response.json({ ok: true });
  }

  cardsInColumn(columnId) {
    const list = [];
    this.doc.getMap("cards").forEach((value, id) => {
      if (!(value instanceof Y.Map)) return;
      if (value.get("columnId") !== columnId) return;
      list.push({ id, rank: value.get("rank") ?? 0 });
    });
    return sortByRankThenId(list);
  }

  async syncToCatalog(summary) {
    try {
      const stub = this.env.CATALOG_DO.get(this.env.CATALOG_DO.idFromName("catalog"));
      const response = await stub.fetch(
        new Request("https://do.internal/boards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(summary),
        }),
      );
      return response.ok;
    } catch (err) {
      console.error(`Catalog sync failed for ${summary.id}`, err);
      return false;
    }
  }
}
