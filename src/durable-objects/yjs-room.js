import * as Y from "yjs";
import { DurableObject } from "cloudflare:workers";
import { WS_CLOSE_REVOKED, YJS_COMPACT_ALARM_MS, YJS_COMPACT_EVERY } from "../lib/constants.js";

const STORAGE_KEY_STATE = "ydoc:state";
const STORAGE_KEY_READY = "ready";
export const STORAGE_KEY_TOMBSTONE = "tombstone";

/** Alarm kind: fold the update log. Other kinds (card snapshot) share this clock. */
const ALARM_COMPACT = "yjs-compact";

/**
 * Shared Yjs-over-WebSocket room logic for hibernatable Durable Objects.
 * Appends each update to SQLite and compacts the log into one snapshot.
 */
export class YjsRoom extends DurableObject {
  constructor(ctx, env, options = {}) {
    super(ctx, env);
    this.doc = null;
    this.docReady = null;
    this.options = options;
    /** Cached tombstone flag; avoids a storage read on every persist. */
    this.tombstoned = false;
    this.schemaReady = false;
    /** Serializes update inserts so compaction cannot drop a write still in flight. */
    this.persistTail = Promise.resolve();
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
    this.ensureSchema();
    const legacy = await this.ctx.storage.get(STORAGE_KEY_STATE);
    const snap = this.ctx.storage.sql
      .exec("SELECT state FROM yjs_snapshot WHERE id = 1")
      .toArray()[0];
    const updates = this.ctx.storage.sql
      .exec("SELECT bytes FROM yjs_updates ORDER BY id")
      .toArray();

    this.doc = new Y.Doc();
    const base = snap?.state != null ? snap.state : legacy;
    let hasState = false;
    if (base != null) {
      Y.applyUpdate(this.doc, asBytes(base));
      hasState = true;
    }
    for (const row of updates) {
      Y.applyUpdate(this.doc, asBytes(row.bytes));
      hasState = true;
    }
    if (!hasState && this.options.createDoc) {
      // In memory only. Callers persist via markReady() once the doc is real.
      this.doc = this.options.createDoc();
    }

    // Old rooms stored one full encode on `ydoc:state`. Fold that into the snapshot
    // once; a later load must not apply the legacy blob on top of the snapshot.
    if (legacy != null && snap?.state == null) {
      this.ctx.storage.transactionSync(() => {
        this.writeSnapshotFromDoc(null);
      });
    }
    if (legacy != null) {
      await this.ctx.storage.delete(STORAGE_KEY_STATE);
    }

    this.doc.on("update", (update, origin) => {
      if (origin === "remote") return;
      this.ctx.waitUntil(this.appendUpdate(update));
      for (const peer of this.ctx.getWebSockets()) {
        peer.send(update);
      }
    });

    if (this.pendingUpdateCount() > 0) {
      await this.scheduleRoomAlarm(ALARM_COMPACT, Date.now() + YJS_COMPACT_ALARM_MS);
    }

    return this.doc;
  }

  ensureSchema() {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS yjs_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS yjs_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_alarms (
        kind TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      );
    `);
    this.schemaReady = true;
  }

  pendingUpdateCount() {
    const row = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM yjs_updates").toArray()[0];
    return Number(row?.n ?? 0);
  }

  maxUpdateId() {
    const row = this.ctx.storage.sql.exec("SELECT MAX(id) AS maxId FROM yjs_updates").toArray()[0];
    return row?.maxId == null ? null : Number(row.maxId);
  }

  /**
   * Replace the snapshot with the in-memory doc and drop the log rows it covers.
   * `maxId` null deletes the whole log (legacy migration, nothing else is queued).
   */
  writeSnapshotFromDoc(maxId) {
    if (!this.doc) return;
    const state = Y.encodeStateAsUpdate(this.doc);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO yjs_snapshot (id, state) VALUES (1, ?)",
      state,
    );
    if (maxId == null) {
      this.ctx.storage.sql.exec("DELETE FROM yjs_updates");
    } else {
      this.ctx.storage.sql.exec("DELETE FROM yjs_updates WHERE id <= ?", maxId);
    }
  }

  /**
   * Queue `task` behind earlier persists. Callers that need durability await the
   * returned promise; the chain itself keeps going after a failure.
   */
  enqueuePersist(task) {
    const run = this.persistTail.catch(() => {}).then(() => task());
    this.persistTail = run;
    return run;
  }

  /** Append one Yjs update. Compacts when the log reaches YJS_COMPACT_EVERY. */
  appendUpdate(update) {
    if (!(update instanceof Uint8Array) || update.byteLength === 0) return Promise.resolve();
    const bytes = new Uint8Array(update);
    return this.enqueuePersist(() => this.writeUpdate(bytes));
  }

  async writeUpdate(update) {
    if (this.tombstoned || !this.doc) return;
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      // createDoc() runs before the update listener, so the first stored blob has
      // to be a full snapshot. Later writes are deltas against that snapshot.
      if (!this.hasSnapshot()) {
        this.writeSnapshotFromDoc(null);
        this.ctx.storage.sql.exec("DELETE FROM room_alarms WHERE kind = ?", ALARM_COMPACT);
        return;
      }
      this.ctx.storage.sql.exec("INSERT INTO yjs_updates (bytes) VALUES (?)", update);
      if (this.pendingUpdateCount() >= YJS_COMPACT_EVERY) {
        this.writeSnapshotFromDoc(this.maxUpdateId());
        this.ctx.storage.sql.exec("DELETE FROM room_alarms WHERE kind = ?", ALARM_COMPACT);
      } else {
        this.upsertRoomAlarm(ALARM_COMPACT, Date.now() + YJS_COMPACT_ALARM_MS);
      }
    });
    await this.syncAlarmClock();
  }

  hasSnapshot() {
    return (
      this.ctx.storage.sql.exec("SELECT id FROM yjs_snapshot WHERE id = 1").toArray()[0] != null
    );
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
    await this.persistTail.catch(() => {});
    this.schemaReady = false;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put(STORAGE_KEY_TOMBSTONE, true);
  }

  /**
   * Wait until queued writes finish, store a full snapshot, then mark the doc
   * visible. Init builds part of the doc before the update listener exists.
   */
  async markReady() {
    await this.persistTail.catch((err) => {
      console.error("Yjs persist failed before markReady", err);
    });
    if (this.tombstoned || !this.doc) return;
    this.ensureSchema();
    this.ctx.storage.transactionSync(() => {
      this.writeSnapshotFromDoc(null);
      this.ctx.storage.sql.exec("DELETE FROM room_alarms WHERE kind = ?", ALARM_COMPACT);
    });
    await this.syncAlarmClock();
    await this.ctx.storage.put(STORAGE_KEY_READY, true);
  }

  /**
   * Remember a deadline. A Durable Object has one alarm, so the clock is always
   * the soonest row in `room_alarms` (Yjs compaction and the card snapshot).
   * An existing future deadline for `kind` is kept when it is sooner.
   */
  upsertRoomAlarm(kind, when) {
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec("SELECT at FROM room_alarms WHERE kind = ?", kind)
      .toArray()[0];
    if (row && Number(row.at) > Date.now() && Number(row.at) <= when) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO room_alarms (kind, at) VALUES (?, ?)
       ON CONFLICT(kind) DO UPDATE SET at = excluded.at`,
      kind,
      when,
    );
    return true;
  }

  clearRoomAlarm(kind) {
    if (this.tombstoned) return;
    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM room_alarms WHERE kind = ?", kind);
  }

  minAlarmAt() {
    const row = this.ctx.storage.sql.exec("SELECT MIN(at) AS at FROM room_alarms").toArray()[0];
    return row?.at == null ? null : Number(row.at);
  }

  async scheduleRoomAlarm(kind, when) {
    if (this.tombstoned) return;
    const wrote = this.upsertRoomAlarm(kind, when);
    if (!wrote) {
      const existing = await this.ctx.storage.getAlarm();
      if (this.tombstoned || existing != null) return;
    }
    await this.syncAlarmClock();
  }

  /**
   * Set or clear the DO alarm so it matches `room_alarms`. Re-reads after the
   * await: another write can change the soonest deadline while we wait.
   */
  async syncAlarmClock() {
    if (this.tombstoned) return;
    this.ensureSchema();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.tombstoned) return;
      const at = this.minAlarmAt();
      const current = await this.ctx.storage.getAlarm();
      if (this.tombstoned || this.minAlarmAt() !== at) continue;
      if (at == null) {
        if (current == null) return;
        await this.ctx.storage.deleteAlarm();
        if (this.minAlarmAt() == null) return;
        continue;
      }
      if (current === at) return;
      await this.ctx.storage.setAlarm(at);
      if (this.minAlarmAt() === at) return;
    }
  }

  /**
   * Compact when this wake is the compaction alarm, or when another alarm
   * (card snapshot) finds a log waiting. Returns the kinds that were due.
   */
  async alarm() {
    if (await this.isTombstoned()) return [];
    this.ensureSchema();
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec("SELECT kind FROM room_alarms WHERE at <= ?", now)
      .toArray()
      .map((row) => String(row.kind));

    if (due.includes(ALARM_COMPACT) || this.pendingUpdateCount() > 0) {
      await this.ensureDoc();
      await this.enqueuePersist(() => {
        if (this.tombstoned || !this.doc) return;
        const maxId = this.maxUpdateId();
        this.ctx.storage.transactionSync(() => {
          if (maxId != null) this.writeSnapshotFromDoc(maxId);
          this.ctx.storage.sql.exec("DELETE FROM room_alarms WHERE kind = ?", ALARM_COMPACT);
        });
      });
    }

    await this.syncAlarmClock();
    return due;
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

    await this.appendUpdate(update);
  }

  async webSocketClose(_ws, _code, _reason, _wasClean) {
    // Hibernatable — no cleanup needed for stateless relay.
  }
}

/** SQLite blobs come back as ArrayBuffer. Copy views so the binding stores just the update. */
function asBytes(value) {
  if (value instanceof Uint8Array) {
    if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) return value;
    return new Uint8Array(value);
  }
  return new Uint8Array(value);
}
