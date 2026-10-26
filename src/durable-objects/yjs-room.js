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
    this.docReady = null;
    this.options = options;
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
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade();
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

  async webSocketMessage(ws, message) {
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
