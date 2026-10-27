import * as Y from "yjs";
import { DurableObject } from "cloudflare:workers";
import { WS_CLOSE_REVOKED } from "../lib/constants.js";

const STORAGE_KEY_STATE = "ydoc:state";
const STORAGE_KEY_READY = "ready";
export const STORAGE_KEY_TOMBSTONE = "tombstone";

/**
 * Shared Yjs-over-WebSocket room logic for hibernatable Durable Objects.
 * Persists encoded state to DO storage and relays binary updates to peers.
 */
export class YjsRoom extends DurableObject {
  constructor(ctx, env, options = {}) {
    super(ctx, env);
    this.doc = null;
    this.docReady = null;
    this.options = options;
    /** Cached tombstone flag; avoids a storage read on every persist. */
    this.tombstoned = false;
  }

  /** Load the doc once; concurrent callers share the same promise. */
  ensureDoc() {
    this.docReady ??= this.loadDoc().catch((err) => {
      this.docReady = null;
      throw err;
    });
    return this.docReady;
  }

  async loadDoc() {
    const storedState = await this.ctx.storage.get(STORAGE_KEY_STATE);

    this.doc = new Y.Doc();

    if (storedState) {
      Y.applyUpdate(this.doc, new Uint8Array(storedState));
    } else if (this.options.createDoc) {
      // In memory only. Callers persist via markReady() once the doc is real.
      this.doc = this.options.createDoc();
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

  async isReady() {
    return (await this.ctx.storage.get(STORAGE_KEY_READY)) === true;
  }

  async isTombstoned() {
    if (this.tombstoned) return true;
    this.tombstoned = (await this.ctx.storage.get(STORAGE_KEY_TOMBSTONE)) === true;
    return this.tombstoned;
  }

  async markTombstoned() {
    this.tombstoned = true;
    this.doc = null;
    this.docReady = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put(STORAGE_KEY_TOMBSTONE, true);
  }

  /** Persist the doc and mark it visible to handlers and sockets. */
  async markReady() {
    await this.persistState();
    await this.ctx.storage.put(STORAGE_KEY_READY, true);
  }

  async persistState() {
    if (!this.doc || this.tombstoned) return;
    const state = Y.encodeStateAsUpdate(this.doc);
    await this.ctx.storage.put(STORAGE_KEY_STATE, state);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/revoke-sockets")) {
      return this.handleRevokeSockets(request);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async handleWebSocketUpgrade(request) {
    const email = request.headers.get("X-TK-Actor") || "";
    const role = request.headers.get("X-TK-Role") || "";
    if (!email || !role) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.ensureDoc();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ email, role });

    const snapshot = Y.encodeStateAsUpdate(this.doc);
    server.send(snapshot);

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleRevokeSockets(request) {
    const body = await request.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email : "";
    if (!email) {
      return Response.json({ error: "email is required" }, { status: 400 });
    }

    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() || {};
      if (attachment.email === email) {
        try {
          ws.close(WS_CLOSE_REVOKED, "revoked");
          closed += 1;
        } catch {
          /* already closing */
        }
      }
    }
    return Response.json({ ok: true, closed });
  }

  async webSocketMessage(ws, message) {
    // Board/catalog rooms are read-only over the socket; mutations go through HTTP.
    if (this.options.clientUpdates === false) return;

    // Yjs updates are binary; a text frame is never a valid update.
    if (typeof message === "string") return;

    await this.ensureDoc();
    const update = new Uint8Array(message);

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
}
