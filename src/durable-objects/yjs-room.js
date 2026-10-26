import * as Y from "yjs";
import { DurableObject } from "cloudflare:workers";

const STORAGE_KEY_STATE = "ydoc:state";

/**
 * Shared Yjs-over-WebSocket room logic for hibernatable Durable Objects.
 * Persists encoded state to DO storage and relays binary updates to peers.
 */
export class YjsRoom extends DurableObject {
  constructor(ctx, env, options = {}) {
    super(ctx, env);
    this.doc = null;
    this.options = options;
  }

  async ensureDoc() {
    if (this.doc) return this.doc;

    const storedState = await this.ctx.storage.get(STORAGE_KEY_STATE);

    this.doc = new Y.Doc();

    if (storedState) {
      Y.applyUpdate(this.doc, new Uint8Array(storedState));
    } else if (this.options.createDoc) {
      this.doc = this.options.createDoc();
      await this.persistState();
    }

    this.doc.on("update", (update, origin) => {
      if (origin === "remote") return;
      void this.persistState();
      for (const peer of this.ctx.getWebSockets()) {
        peer.send(update);
      }
    });

    return this.doc;
  }

  async persistState() {
    if (!this.doc) return;
    const state = Y.encodeStateAsUpdate(this.doc);
    await this.ctx.storage.put(STORAGE_KEY_STATE, state);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade();
    }

    if (request.method === "GET" && url.pathname.endsWith("/history")) {
      return this.handleHistoryRequest(url);
    }

    return new Response("Not found", { status: 404 });
  }

  async handleWebSocketUpgrade() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.ensureDoc();
    this.ctx.acceptWebSocket(server);

    const snapshot = Y.encodeStateAsUpdate(this.doc);
    server.send(snapshot);

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleHistoryRequest(url) {
    await this.initChangelogTable();
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const rows = await this.ctx.storage.sql
      .exec(
        "SELECT ts, author, field, prev, next FROM changelog ORDER BY ts DESC LIMIT ?",
        limit,
      )
      .toArray();

    const entries = rows.map((row) => ({
      ts: row.ts,
      author: row.author,
      field: row.field,
      prev: row.prev,
      next: row.next,
    }));

    return Response.json({ entries });
  }

  async webSocketMessage(ws, message) {
    await this.ensureDoc();

    const update =
      typeof message === "string"
        ? new TextEncoder().encode(message)
        : new Uint8Array(message);

    Y.applyUpdate(this.doc, update, "remote");
    this.options.onUpdateApplied?.(update);

    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) {
        peer.send(update);
      }
    }

    await this.persistState();
  }

  async webSocketClose(_ws, _code, _reason, _wasClean) {
    // Hibernatable — no cleanup needed for stateless relay.
  }

  async initChangelogTable() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS changelog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT 'system',
        field TEXT NOT NULL,
        prev TEXT,
        next TEXT
      )
    `);
  }

  async appendChangelog(entry) {
    await this.initChangelogTable();
    this.ctx.storage.sql.exec(
      "INSERT INTO changelog (ts, author, field, prev, next) VALUES (?, ?, ?, ?, ?)",
      entry.ts ?? new Date().toISOString(),
      entry.author,
      entry.field,
      entry.prev,
      entry.next,
    );
  }
}
