import * as Y from "yjs";
import { DurableObject } from "cloudflare:workers";
import {
  AWARENESS_ROOM_LIMIT,
  AWARENESS_ROOM_WINDOW_MS,
  AWARENESS_SOCKET_LIMIT,
  AWARENESS_SOCKET_WINDOW_MS,
  AWARENESS_SOCKETS_PER_EMAIL,
  DOC_SCHEMA_VERSION,
  OUTBOUND_BACKOFF_MAX_MS,
  OUTBOUND_BACKOFF_MS,
  WS_CLOSE_REVOKED,
  YJS_COMPACT_ALARM_MS,
  YJS_COMPACT_EVERY,
} from "../lib/constants.js";
import {
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  allocateAwarenessClientId,
  bumpRateWindow,
  captureRemoteUpdates,
  classifyAwarenessFrame,
  decodeRoomMessage,
  encodeAwarenessFrame,
  encodeAwarenessLeave,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  presencePublishAllowed,
  sanitizeAwarenessUpdate,
} from "../lib/ws-sync.js";

const STORAGE_KEY_STATE = "ydoc:state";
const STORAGE_KEY_READY = "ready";
export const STORAGE_KEY_TOMBSTONE = "tombstone";

/** Alarm kinds that share the Durable Object alarm clock via `room_alarms`. */
const ALARM_COMPACT = "yjs-compact";
const ALARM_OUTBOUND = "outbound-sync";
/** JobDO: debounced changelog flush (survives hibernation). */
export const ALARM_CHANGELOG = "changelog";
const KNOWN_ROOM_ALARMS = [ALARM_COMPACT, ALARM_OUTBOUND, ALARM_CHANGELOG];

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
    /** Serializes replica sends so an older in-flight write cannot clobber a newer one. */
    this.outboundTail = Promise.resolve();
    /** In-memory room-wide awareness budget. A flood keeps the object awake, so this holds. */
    this.awRoomWindow = 0;
    this.awRoomCount = 0;
  }

  /** Load the doc once; concurrent callers share the same promise. */
  ensureDoc() {
    this.docReady ??= this.loadDoc().catch((err) => {
      this.docReady = null;
      throw err;
    });
    return this.docReady;
  }

  /** Drop the in-memory doc so the next ensureDoc reloads from SQLite. */
  resetInMemoryDoc() {
    this.doc = null;
    this.docReady = null;
  }

  async loadDoc() {
    this.ensureSchema();
    const legacy = await this.ctx.storage.get(STORAGE_KEY_STATE);
    const snap = this.ctx.storage.sql
      .exec("SELECT state, schema_version FROM yjs_snapshot WHERE id = 1")
      .toArray()[0];
    const updates = this.ctx.storage.sql
      .exec("SELECT bytes FROM yjs_updates ORDER BY id")
      .toArray();

    const fromVersion = snap?.schema_version != null ? Number(snap.schema_version) : 0;

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

    const needsMigrate = hasState && fromVersion < DOC_SCHEMA_VERSION;
    let migrationUpdate = null;
    if (needsMigrate) {
      const before = Y.encodeStateVector(this.doc);
      this.doc.transact(() => {
        this.migrateDoc(this.doc, fromVersion);
      });
      if (!sameBytes(before, Y.encodeStateVector(this.doc))) {
        // Hibernated sockets already have the pre-migration doc. The listener
        // is not attached yet, so this diff is not stored a second time.
        migrationUpdate = Y.encodeStateAsUpdate(this.doc, before);
      }
    }

    // Fold a legacy blob, or rewrite after migrate, before the update listener exists.
    const needsRewrite = (legacy != null && snap?.state == null) || needsMigrate;
    if (needsRewrite) {
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
      sendToPeers(this.ctx, encodeSyncUpdate(update));
    });

    if (migrationUpdate) sendToPeers(this.ctx, encodeSyncUpdate(migrationUpdate));

    if (this.pendingUpdateCount() > 0) {
      await this.scheduleRoomAlarm(ALARM_COMPACT, Date.now() + YJS_COMPACT_ALARM_MS);
    }
    await this.scheduleOutboundAlarm();

    return this.doc;
  }

  /**
   * Bring a loaded doc from `fromVersion` up to DOC_SCHEMA_VERSION.
   * Runs inside a transaction before the update listener is attached.
   * Connected sockets receive a diff when the doc actually changes.
   * Subclasses override; default is a no-op. Step every older version
   * forward — the caller stamps the snapshot with DOC_SCHEMA_VERSION.
   */
  migrateDoc(_doc, _fromVersion) {}

  ensureSchema() {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS yjs_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state BLOB NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS yjs_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_alarms (
        kind TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbound_sync (
        kind TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        gen INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL
      );
    `);
    // One-shot leftover: tables created before schema_version existed.
    this.ensureColumn("yjs_snapshot", "schema_version", "INTEGER NOT NULL DEFAULT 0");
    // Drop alarms this process no longer handles (the old card snapshot clock).
    // A past row left behind is the soonest deadline and the DO alarm spins.
    this.ctx.storage.sql.exec(
      `DELETE FROM room_alarms WHERE kind NOT IN (${KNOWN_ROOM_ALARMS.map(() => "?").join(", ")})`,
      ...KNOWN_ROOM_ALARMS,
    );
    this.schemaReady = true;
  }

  ensureColumn(table, column, spec) {
    try {
      const rows = this.ctx.storage.sql.exec(`PRAGMA table_info(${table})`).toArray();
      if (rows.some((row) => String(row.name) === column)) return;
    } catch {
      // PRAGMA unavailable; try ALTER and ignore a duplicate-column error.
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
    } catch {
      // Column already present.
    }
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
    this.ensureSchema();
    const state = Y.encodeStateAsUpdate(this.doc);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO yjs_snapshot (id, state, schema_version) VALUES (1, ?, ?)",
      state,
      DOC_SCHEMA_VERSION,
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

  /**
   * Wait until Yjs writes queued so far have finished. False means a replica
   * ack must fail so the retry row stays: a 200 would drop it.
   * When the latest write failed and nothing newer is queued, fold memory
   * into one snapshot so a retry can succeed without a fresh update.
   */
  async awaitPersisted() {
    const tail = this.persistTail;
    try {
      await tail;
    } catch (err) {
      console.error("Yjs persist failed", err);
      if (this.tombstoned || !this.doc || this.persistTail !== tail) return false;
      try {
        this.ensureSchema();
        this.ctx.storage.transactionSync(() => {
          this.writeSnapshotFromDoc(null);
          this.ctx.storage.sql.exec("DELETE FROM room_alarms WHERE kind = ?", ALARM_COMPACT);
        });
        if (this.persistTail === tail) this.persistTail = Promise.resolve();
        return true;
      } catch (snapErr) {
        console.error("Yjs snapshot fallback failed", snapErr);
        return false;
      }
    }
    return !this.tombstoned;
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
   * the soonest row in `room_alarms` (Yjs compaction and outbound replicas).
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
   * (outbound retry) finds a log waiting. Returns the kinds that were due.
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

    if (due.includes(ALARM_OUTBOUND) || this.hasDueOutbound(now)) {
      await this.flushOutbound();
    }

    await this.syncAlarmClock();
    return due;
  }

  /**
   * Store `payload` as the latest replica write for `kind` and send it now.
   * Callers still succeed locally if the replica fails: the row stays and the
   * outbound alarm retries with backoff. 4xx responses are dropped, except
   * 408 and 429. The alarm is armed before the send so a crash mid-fetch
   * still wakes the retry.
   */
  async syncReplica(kind, payload) {
    if (this.tombstoned) return;
    this.writeOutbound(kind, JSON.stringify(payload));
    try {
      await this.scheduleRoomAlarm(ALARM_OUTBOUND, Date.now() + OUTBOUND_BACKOFF_MS);
    } catch (err) {
      console.error(`Outbound alarm failed for ${kind}`, err);
    }
    if (this.tombstoned) return;
    await this.enqueueOutboundFlush(kind);
  }

  /** Subclasses send `payload` to the replica. Return true to drop the row. */
  async runOutboundSync(_kind, _payload) {
    return true;
  }

  writeOutbound(kind, payloadJson) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT INTO outbound_sync (kind, payload, gen, attempts, next_at)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT(kind) DO UPDATE SET
         payload = excluded.payload,
         gen = outbound_sync.gen + 1,
         attempts = 0,
         next_at = excluded.next_at`,
      kind,
      payloadJson,
      Date.now(),
    );
    const row = this.ctx.storage.sql
      .exec("SELECT gen FROM outbound_sync WHERE kind = ?", kind)
      .toArray()[0];
    return Number(row?.gen ?? 1);
  }

  getOutbound(kind) {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT kind, payload, gen, attempts, next_at FROM outbound_sync WHERE kind = ?",
          kind,
        )
        .toArray()[0] ?? null
    );
  }

  clearOutbound(kind) {
    this.ctx.storage.sql.exec("DELETE FROM outbound_sync WHERE kind = ?", kind);
  }

  clearOutboundIf(kind, gen) {
    this.ctx.storage.sql.exec("DELETE FROM outbound_sync WHERE kind = ? AND gen = ?", kind, gen);
  }

  bumpOutbound(kind) {
    const row = this.getOutbound(kind);
    if (!row) return;
    const attempts = Number(row.attempts) + 1;
    this.ctx.storage.sql.exec(
      "UPDATE outbound_sync SET attempts = ?, next_at = ? WHERE kind = ?",
      attempts,
      Date.now() + outboundBackoffMs(attempts),
      kind,
    );
  }

  hasDueOutbound(now = Date.now()) {
    const row = this.ctx.storage.sql
      .exec("SELECT 1 AS ok FROM outbound_sync WHERE next_at <= ? LIMIT 1", now)
      .toArray()[0];
    return row != null;
  }

  enqueueOutboundFlush(kind) {
    const run = this.outboundTail.catch(() => {}).then(() => this.flushOutboundKind(kind));
    this.outboundTail = run;
    return run;
  }

  async flushOutboundKind(kind) {
    try {
      if (this.tombstoned) return;
      let row = this.getOutbound(kind);
      while (row && !this.tombstoned) {
        if (Number(row.next_at) > Date.now()) return;
        const gen = Number(row.gen);
        let payload;
        try {
          payload = JSON.parse(String(row.payload));
        } catch {
          this.clearOutbound(kind);
          return;
        }
        let ok = false;
        try {
          ok = await this.runOutboundSync(kind, payload);
        } catch (err) {
          console.error(`Outbound ${kind} threw`, err);
          ok = false;
        }
        if (this.tombstoned) return;
        let current;
        try {
          current = this.getOutbound(kind);
        } catch (err) {
          if (this.tombstoned) return;
          throw err;
        }
        if (!current) return;
        if (Number(current.gen) !== gen) {
          row = current;
          continue;
        }
        if (ok) {
          this.clearOutboundIf(kind, gen);
          return;
        }
        this.bumpOutbound(kind);
        return;
      }
    } finally {
      await this.scheduleOutboundAlarm();
    }
  }

  async flushOutbound() {
    if (this.tombstoned) return;
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec("SELECT kind FROM outbound_sync WHERE next_at <= ?", Date.now())
      .toArray();
    for (const row of rows) {
      await this.enqueueOutboundFlush(String(row.kind));
    }
    await this.scheduleOutboundAlarm();
  }

  /**
   * Point the outbound alarm at MIN(next_at). Unlike upsertRoomAlarm this
   * replaces a sooner stale deadline after backoff.
   */
  async scheduleOutboundAlarm() {
    if (this.tombstoned) return;
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec("SELECT MIN(next_at) AS at FROM outbound_sync")
      .toArray()[0];
    this.clearRoomAlarm(ALARM_OUTBOUND);
    if (row?.at != null) this.upsertRoomAlarm(ALARM_OUTBOUND, Number(row.at));
    await this.syncAlarmClock();
  }

  /**
   * 2xx succeeds. 4xx is dropped (retry will not help). 5xx and network errors retry.
   */
  async settleOutboundResponse(response, label) {
    if (response.ok) {
      await response.body?.cancel();
      return true;
    }
    const { status } = response;
    await response.body?.cancel();
    if (status === 408 || status === 429) {
      console.error(`${label}: ${status}`);
      return false;
    }
    if (status >= 400 && status < 500) {
      console.error(`${label}: ${status} (dropping)`);
      return true;
    }
    console.error(`${label}: ${status}`);
    return false;
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
    const awarenessClientId = allocateAwarenessClientId(this.awarenessClientIds());
    server.serializeAttachment({ email, role, awarenessClientId });

    // Client initiates with SyncStep1; we reply with the missing diff (step 2)
    // plus our own step 1. Do not push a full snapshot here.

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

  /**
   * Boards and the catalog have no extra presence gate. JobDO overrides this
   * so a tombstoned card does not keep relaying.
   */
  async awarenessPermitted() {
    return true;
  }

  /** Client ids already bound to open sockets. */
  awarenessClientIds() {
    const used = new Set();
    for (const peer of this.ctx.getWebSockets()) {
      const id = peer.deserializeAttachment()?.awarenessClientId;
      if (Number.isInteger(id)) used.add(id);
    }
    return used;
  }

  /**
   * Handle a presence frame. Returns true when `message` is awareness (relayed
   * or dropped). The sender's client id and email are replaced with the values
   * stored on the socket at upgrade — the session email, and an id this socket
   * alone holds — so a member cannot impersonate, clear, or multiply peers.
   */
  async relayAwareness(ws, message) {
    const kind = classifyAwarenessFrame(message);
    if (kind == null) return false;
    // Huge frames are dropped before decode. Over-budget sockets are dropped
    // before the storage read in awarenessPermitted.
    if (kind === "oversize" || !this.allowSocketAwareness(ws)) return true;
    if (!(await this.awarenessPermitted())) return true;
    if (!this.publishesPresence(ws)) return true;

    const parsed = decodeRoomMessage(message);
    const attachment = ws.deserializeAttachment() || {};
    const update =
      parsed?.type === "awareness"
        ? sanitizeAwarenessUpdate(parsed.payload, {
            clientId: attachment.awarenessClientId,
            email: attachment.email,
          })
        : null;
    if (!update || !this.allowRoomAwareness()) return true;

    const frame = encodeAwarenessFrame(update);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(frame);
      } catch {
        /* already closing */
      }
    }
    return true;
  }

  /** Per-socket budget, persisted on the attachment so hibernation does not reset it. */
  allowSocketAwareness(ws) {
    const attachment = ws.deserializeAttachment() || {};
    const next = bumpRateWindow(
      Date.now(),
      attachment.awWindow,
      attachment.awCount,
      AWARENESS_SOCKET_LIMIT,
      AWARENESS_SOCKET_WINDOW_MS,
    );
    if (!next.allowed) return false;
    ws.serializeAttachment({
      ...attachment,
      awWindow: next.windowStart,
      awCount: next.count,
    });
    return true;
  }

  allowRoomAwareness() {
    const next = bumpRateWindow(
      Date.now(),
      this.awRoomWindow,
      this.awRoomCount,
      AWARENESS_ROOM_LIMIT,
      AWARENESS_ROOM_WINDOW_MS,
    );
    if (!next.allowed) return false;
    this.awRoomWindow = next.windowStart;
    this.awRoomCount = next.count;
    return true;
  }

  publishesPresence(ws) {
    const self = ws.deserializeAttachment() || {};
    const entries = [];
    for (const peer of this.ctx.getWebSockets()) {
      const att = peer.deserializeAttachment() || {};
      entries.push({ email: att.email, clientId: att.awarenessClientId });
    }
    return presencePublishAllowed(
      entries,
      self.email,
      self.awarenessClientId,
      AWARENESS_SOCKETS_PER_EMAIL,
    );
  }

  /** Answer SyncStep1: the bytes this client is missing, then our state vector. */
  replySyncStep1(ws, stateVector) {
    try {
      ws.send(encodeSyncStep2(this.doc, stateVector));
      ws.send(encodeSyncStep1(this.doc));
    } catch {
      /* already closing */
    }
  }

  async webSocketMessage(ws, message) {
    // Yjs sync/awareness frames are binary; a text frame is never valid.
    if (typeof message === "string") return;
    if (await this.relayAwareness(ws, message)) return;

    const parsed = decodeRoomMessage(message);
    if (!parsed) return;

    await this.ensureDoc();

    if (parsed.syncType === SYNC_STEP1) {
      this.replySyncStep1(ws, parsed.payload);
      return;
    }

    // Board/catalog rooms are read-only over the socket; mutations go through HTTP.
    // Drop SyncStep2 (handshake reply) and Update — clients initiate sync, and an
    // empty step-2 reply is normal; forged step-2 must not mutate the doc.
    if (this.options.clientUpdates === false) return;
    if (parsed.syncType !== SYNC_STEP2 && parsed.syncType !== SYNC_UPDATE) return;

    const update = parsed.payload;
    const doc = this.doc;
    let integrated = null;
    try {
      const parts = captureRemoteUpdates(doc, () => {
        Y.applyUpdate(doc, update, "remote");
      });
      integrated = mergeIntegratedUpdates(parts);
    } catch (err) {
      console.error("Invalid Yjs update", err);
      this.resetInMemoryDoc();
      try {
        ws.close(1003, "invalid update");
      } catch {
        /* already closing */
      }
      return;
    }
    this.options.onUpdateApplied?.(update);

    // Nothing integrated (a step-2 reply the doc already has, including one
    // that is only the historical delete set) is not relayed or logged.
    if (!integrated) return;
    const frame = encodeSyncUpdate(integrated);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(frame);
    }
    await this.appendUpdate(integrated);
  }

  async webSocketClose(ws) {
    // A quiet awareness client otherwise lingers about 30 seconds. Tell peers
    // this socket left so its presence drops with the connection.
    this.broadcastAwarenessLeave(ws);
  }

  broadcastAwarenessLeave(ws) {
    let clientId;
    try {
      clientId = ws.deserializeAttachment()?.awarenessClientId;
    } catch {
      return;
    }
    if (!Number.isInteger(clientId)) return;
    let frame;
    try {
      frame = encodeAwarenessLeave(clientId);
    } catch {
      return;
    }
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(frame);
      } catch {
        /* already closing */
      }
    }
  }
}

/** One update for peers. Empty when the doc integrated nothing. */
export function mergeIntegratedUpdates(parts) {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return Y.mergeUpdates(parts);
}

function sendToPeers(ctx, update) {
  for (const peer of ctx.getWebSockets()) {
    try {
      peer.send(update);
    } catch {
      /* already closing */
    }
  }
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function outboundBackoffMs(attempts) {
  const exp = Math.min(Math.max(attempts, 1) - 1, 8);
  return Math.min(OUTBOUND_BACKOFF_MS * 2 ** exp, OUTBOUND_BACKOFF_MAX_MS);
}

/** SQLite blobs come back as ArrayBuffer. Copy views so the binding stores just the update. */
function asBytes(value) {
  if (value instanceof Uint8Array) {
    if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) return value;
    return new Uint8Array(value);
  }
  return new Uint8Array(value);
}
