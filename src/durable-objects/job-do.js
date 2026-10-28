import * as Y from "yjs";
import { ALARM_CHANGELOG, YjsRoom, mergeIntegratedUpdates } from "./yjs-room.js";
import { createEmptyCardDoc, materializeCard } from "../lib/materialize.js";
import { diffCardSnapshots } from "../lib/changelog.js";
import {
  CHANGELOG_DEBOUNCE_MS,
  CHANGELOG_MAX_ENTRIES,
  ROLE_RANK,
} from "../lib/constants.js";
import { readJson } from "../lib/json.js";
import {
  clampLabels,
  clampLiveAssignee,
  clampLiveDue,
  clampLiveTitle,
  clampStoredTitle,
  sameLabels,
} from "../lib/fields.js";
import {
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  captureRemoteUpdates,
  decodeRoomMessage,
  encodeSyncUpdate,
} from "../lib/ws-sync.js";

const STORAGE_KEY_CHANGELOG_ACTOR = "changelog:actor";

// Board-card summary fields; columnId and rank are owned by BoardDO placement.
const SUMMARY_FIELDS = new Set(["title", "due", "assignee", "labels", "archived"]);

export class JobDO extends YjsRoom {
  constructor(ctx, env) {
    super(ctx, env, {
      createDoc: () => createEmptyCardDoc(null, null),
    });
    this.changelogReady = false;
    this.lastSnapshot = null;
    /** In-flight flushChangelog promise, so export can wait for its rows. */
    this.changelogFlight = null;
    this.suspendChangelog = false;
    /** Email for the in-flight debounce batch (flushed when the actor changes). */
    this.pendingActor = null;
  }

  readActor(request) {
    const email = request.headers.get("X-TK-Actor");
    return email && email.trim() ? email.trim() : "system";
  }

  async ensureDoc() {
    const doc = await super.ensureDoc();
    if (!this.changelogReady) {
      this.changelogReady = true;
      // One-shot leftover: old card-snapshot key; drop once each JobDO has booted.
      try {
        await this.ctx.storage.delete("snapshot:latest");
      } catch (err) {
        console.error("Failed to drop legacy card snapshot", err);
      }
      await this.initChangelogTable();
      this.lastSnapshot = materializeCard(doc);
      this.wireChangelog(doc);
    }
    return doc;
  }

  resetInMemoryDoc() {
    super.resetInMemoryDoc();
    this.changelogReady = false;
    this.lastSnapshot = null;
  }

  async requireReady() {
    if (await this.isTombstoned()) {
      return Response.json({ error: "Card not found" }, { status: 404 });
    }
    if (!(await this.isReady())) {
      return Response.json({ error: "Card not found" }, { status: 404 });
    }
    await this.ensureDoc();
    return null;
  }

  wireChangelog(doc) {
    const onChange = () => {
      if (this.suspendChangelog) return;
      this.scheduleChangelog(this.pendingActor);
    };
    doc.getMap("fields").observeDeep(onChange);
    doc.getArray("labels").observe(onChange);
    doc.getText("body").observe(onChange);
  }

  hasChangelogAlarm() {
    this.ensureSchema();
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 AS ok FROM room_alarms WHERE kind = ? LIMIT 1", ALARM_CHANGELOG)
        .toArray()[0] != null
    );
  }

  /**
   * Debounce changelog writes for one actor via the shared DO alarm clock.
   * Survives hibernation (unlike setTimeout). Callers flush a different actor
   * before applying that person's edit.
   */
  scheduleChangelog(actor) {
    const nextActor = actor || this.pendingActor || "system";
    this.pendingActor = nextActor;
    this.ctx.waitUntil(this.armChangelogAlarm(nextActor));
  }

  /**
   * Trailing debounce for one actor. The alarm row is written before the first
   * await: a second editor who arrives during `storage.put` must already see
   * it and flush this batch as `actor`. The actor is stored after that, and
   * only while this call is still the pending one (a later editor won the race).
   */
  async armChangelogAlarm(actor) {
    if (this.tombstoned) return;
    this.clearRoomAlarm(ALARM_CHANGELOG);
    await this.scheduleRoomAlarm(ALARM_CHANGELOG, Date.now() + CHANGELOG_DEBOUNCE_MS);
    if (this.tombstoned || this.pendingActor !== actor) return;
    await this.ctx.storage.put(STORAGE_KEY_CHANGELOG_ACTOR, actor);
  }

  async clearChangelogAlarm() {
    this.clearRoomAlarm(ALARM_CHANGELOG);
    try {
      await this.ctx.storage.delete(STORAGE_KEY_CHANGELOG_ACTOR);
    } catch {
      /* storage may already be cleared on tombstone */
    }
    await this.syncAlarmClock();
  }

  async readChangelogActor() {
    if (this.pendingActor) return this.pendingActor;
    const stored = await this.ctx.storage.get(STORAGE_KEY_CHANGELOG_ACTOR);
    return typeof stored === "string" && stored ? stored : "system";
  }

  /** Flush a debounced batch when `nextActor` is about to write as someone else. */
  async flushPendingActor(nextActor) {
    if (!this.pendingActor || this.pendingActor === nextActor) return;
    if (!this.hasChangelogAlarm() && !this.changelogFlight) return;
    const previous = this.pendingActor;
    await this.clearChangelogAlarm();
    await this.flushChangelog(previous);
  }

  flushChangelog(author) {
    const run = this.applyChangelog(author);
    const tracked = run.finally(() => {
      if (this.changelogFlight === tracked) this.changelogFlight = null;
    });
    this.changelogFlight = tracked;
    return tracked;
  }

  /** Finish a debounced or in-flight batch so a reader sees those rows. */
  async drainChangelog() {
    for (let pass = 0; pass < 3; pass++) {
      if (this.changelogFlight) {
        await this.changelogFlight;
        continue;
      }
      if (!this.hasChangelogAlarm()) return;
      const author = await this.readChangelogActor();
      await this.clearChangelogAlarm();
      await this.flushChangelog(author);
    }
  }

  async alarm() {
    // Clear and flush before super.alarm() so a past changelog row cannot
    // become the soonest deadline again and spin the DO alarm.
    this.ensureSchema();
    const now = Date.now();
    const changelogDue =
      this.ctx.storage.sql
        .exec(
          "SELECT 1 AS ok FROM room_alarms WHERE kind = ? AND at <= ? LIMIT 1",
          ALARM_CHANGELOG,
          now,
        )
        .toArray()[0] != null;
    if (changelogDue) {
      const author = await this.readChangelogActor();
      // The row goes before the flush. The edit is already in the Yjs log, so
      // a crash here, or a flush that throws, skips this changelog batch
      // instead of leaving a due row that would fire again immediately.
      await this.clearChangelogAlarm();
      try {
        await this.ensureDoc();
        await this.flushChangelog(author);
      } catch (err) {
        console.error("Changelog flush failed", err);
      }
    }
    return super.alarm();
  }

  async applyChangelog(author) {
    if (this.suspendChangelog || !this.doc || !this.lastSnapshot) return;
    // Capture before the first await. A Durable Object can run another request
    // at that await, and this batch must keep the actor it already belongs to.
    const credited = author || this.pendingActor || "system";
    const next = materializeCard(this.doc);
    const changes = diffCardSnapshots(this.lastSnapshot, next);
    if (changes.length === 0) return;
    this.lastSnapshot = next;

    if (await this.isTombstoned()) return;
    await this.recordChanges(changes, credited);

    if (changes.some((c) => SUMMARY_FIELDS.has(c.field))) {
      // Don't publish a summary the card might forget if the Yjs write failed.
      if (!(await this.awaitPersisted())) {
        console.error(`Card summary skipped; persist failed for ${next.id}`);
        return;
      }
      try {
        await this.syncReplica("card-summary", summaryPayload(next));
      } catch (err) {
        console.error(`Card summary enqueue failed for ${next.id}`, err);
      }
    }
  }

  async recordChanges(changes, author = "system") {
    for (const change of changes) {
      await this.appendChangelog({
        author,
        field: change.field,
        prev: change.prev,
        next: change.next,
      });
    }
  }

  /** Push summary fields to the board; leaves columnId and rank alone. */
  async syncCardToBoard(snapshot) {
    if (!snapshot?.id || !snapshot.boardId) {
      console.error("Card sync dropped: missing id or boardId");
      return true;
    }
    try {
      const stub = this.env.BOARD_DO.get(this.env.BOARD_DO.idFromName(snapshot.boardId));
      const response = await stub.fetch(
        new Request("https://do.internal/cards/summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: snapshot.id,
            title: snapshot.title,
            due: snapshot.due,
            assignee: snapshot.assignee,
            labels: snapshot.labels,
            archived: snapshot.archived,
          }),
        }),
      );
      return this.settleOutboundResponse(response, `Card sync failed for ${snapshot.id}`);
    } catch (err) {
      console.error(`Card sync failed for ${snapshot.id}`, err);
      return false;
    }
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
      const boardId = url.searchParams.get("boardId");
      if (!boardId || this.doc.getMap("fields").get("boardId") !== boardId) {
        return Response.json({ error: "Card does not belong to this board" }, { status: 403 });
      }
      return super.fetch(request);
    }

    if (request.method === "POST" && path.endsWith("/init")) {
      return this.handleInit(request);
    }

    if (request.method === "DELETE" && path.endsWith("/destroy")) {
      return this.handleDelete();
    }

    const gate = await this.requireReady();
    if (gate) return gate;

    if (request.method === "POST" && path.endsWith("/column")) {
      return this.handleSetColumn(request);
    }

    if (request.method === "POST" && path.endsWith("/archive")) {
      return this.handleArchive(request);
    }

    if (request.method === "GET" && path.endsWith("/snapshot")) {
      return Response.json(materializeCard(this.doc));
    }

    if (request.method === "GET" && path.endsWith("/export")) {
      return this.handleExport();
    }

    if (request.method === "GET" && path.endsWith("/history")) {
      return this.handleHistoryRequest(url);
    }

    return super.fetch(request);
  }

  /** Viewers publish presence too; a deleted card does not. */
  async awarenessPermitted() {
    if (await this.isTombstoned()) return false;
    return this.isReady();
  }

  async webSocketMessage(ws, message) {
    if (typeof message === "string") return;
    if (await this.relayAwareness(ws, message)) return;
    if (await this.isTombstoned()) return;
    if (!(await this.isReady())) return;

    const parsed = decodeRoomMessage(message);
    if (!parsed) return;

    await this.ensureDoc();

    // Viewers (and everyone) may run the state-vector handshake.
    if (parsed.syncType === SYNC_STEP1) {
      this.replySyncStep1(ws, parsed.payload);
      return;
    }

    if (parsed.syncType !== SYNC_STEP2 && parsed.syncType !== SYNC_UPDATE) return;

    const attachment = ws.deserializeAttachment() || {};
    // Viewers may subscribe but inbound document updates are dropped.
    if ((ROLE_RANK[attachment.role] ?? 0) < ROLE_RANK.editor) return;

    const actor = attachment.email || "system";
    await this.flushPendingActor(actor);
    this.pendingActor = actor;

    const before = this.captureProtected();
    const update = parsed.payload;
    const doc = this.doc;
    this.suspendChangelog = true;
    let outbound = null;
    let correction = null;
    try {
      // Inlined from YjsRoom so the changelog diff is taken before the next
      // await. super.webSocketMessage persists first, and another editor can
      // land inside that gap.
      //
      // Apply, then reconcile, then forward one net update. Relaying the raw
      // client bytes first lets peers flash forged id/boardId/columnId (or
      // unclamped fields) until a second correction frame arrives.
      // The bytes are whatever `"update"` emitted. Re-encoding from the state
      // vector before apply would include the whole delete set and look like a
      // change after any deletion, including on a no-op step-2 reply.
      let invalid = false;
      const appliedParts = captureRemoteUpdates(doc, () => {
        try {
          Y.applyUpdate(doc, update, "remote");
        } catch (err) {
          console.error("Invalid Yjs update", err);
          invalid = true;
          this.resetInMemoryDoc();
          try {
            ws.close(1003, "invalid update");
          } catch {
            /* already closing */
          }
        }
      });
      if (invalid) return;

      const correctionParts = captureRemoteUpdates(doc, () => {
        this.reconcileRemote(before);
      });
      correction = mergeIntegratedUpdates(correctionParts);
      outbound = mergeIntegratedUpdates(appliedParts.concat(correctionParts));
      if (outbound) {
        const frame = encodeSyncUpdate(outbound);
        for (const peer of this.ctx.getWebSockets()) {
          if (peer !== ws) peer.send(frame);
        }
      }
      if (correction) {
        try {
          ws.send(encodeSyncUpdate(correction));
        } catch {
          /* already closing */
        }
      }
    } finally {
      this.suspendChangelog = false;
    }

    const persisted = outbound ? this.appendUpdate(outbound) : Promise.resolve();
    if (outbound) this.scheduleChangelog(actor);
    await persisted;
  }

  captureProtected() {
    const fields = this.doc.getMap("fields");
    return {
      id: fields.get("id"),
      boardId: fields.get("boardId"),
      columnId: fields.get("columnId"),
      title: fields.get("title"),
      assignee: fields.get("assignee"),
      due: fields.get("due"),
      archived: fields.get("archived"),
    };
  }

  /**
   * Put protected keys back and clamp title, assignee, due, and labels.
   * Returns true when the doc changed. Uses origin "remote" so the room
   * listener does not persist or broadcast this fix-up on its own.
   */
  reconcileRemote(before) {
    const fields = this.doc.getMap("fields");
    const labels = this.doc.getArray("labels");
    const currentLabels = labels.toArray();
    const nextLabels = clampLabels(currentLabels);
    const nextTitle = clampLiveTitle(fields.get("title"), before.title);
    const nextAssignee = clampLiveAssignee(fields.get("assignee"), before.assignee);
    const nextDue = clampLiveDue(fields.get("due"), before.due);
    const archived = fields.get("archived");
    const nextArchived = typeof archived === "boolean" ? archived : before.archived;

    const idDrift = fields.get("id") !== before.id;
    const boardDrift = fields.get("boardId") !== before.boardId;
    const columnDrift = fields.get("columnId") !== before.columnId;
    const titleDrift = fields.get("title") !== nextTitle;
    const assigneeDrift = fields.get("assignee") !== nextAssignee;
    const dueDrift = fields.get("due") !== nextDue;
    const archivedDrift = archived !== nextArchived;
    const labelsDrift = !sameLabels(currentLabels, nextLabels);
    if (
      !idDrift &&
      !boardDrift &&
      !columnDrift &&
      !titleDrift &&
      !assigneeDrift &&
      !dueDrift &&
      !archivedDrift &&
      !labelsDrift
    ) {
      return false;
    }

    this.doc.transact(() => {
      if (idDrift) fields.set("id", before.id);
      if (boardDrift) fields.set("boardId", before.boardId);
      if (columnDrift) fields.set("columnId", before.columnId);
      if (titleDrift) fields.set("title", nextTitle);
      if (assigneeDrift) fields.set("assignee", nextAssignee);
      if (dueDrift) fields.set("due", nextDue);
      if (archivedDrift) fields.set("archived", nextArchived);
      if (labelsDrift) {
        if (labels.length) labels.delete(0, labels.length);
        if (nextLabels.length) labels.push(nextLabels);
      }
    }, "remote");
    return true;
  }

  /**
   * Seed the card doc. Writes changelog only — BoardDO insert owns the card
   * summary, so we must not sync to the board here.
   */
  async handleInit(request) {
    if (await this.isTombstoned()) {
      return Response.json({ error: "Card not found" }, { status: 404 });
    }
    if (await this.isReady()) {
      return Response.json({ error: "Card already exists" }, { status: 409 });
    }

    const { body, error } = await readJson(request);
    if (error) return error;
    if (!body.id || !body.boardId) {
      return Response.json({ error: "id and boardId are required" }, { status: 400 });
    }

    await this.ensureDoc();
    this.pendingActor = this.readActor(request);
    this.suspendChangelog = true;
    try {
      this.doc.transact(() => {
        const fields = this.doc.getMap("fields");
        fields.set("id", body.id);
        fields.set("boardId", body.boardId);
        if (body.title !== undefined) fields.set("title", clampStoredTitle(body.title));
        if (body.columnId !== undefined) fields.set("columnId", body.columnId);
      });

      const next = materializeCard(this.doc);
      const changes = diffCardSnapshots(this.lastSnapshot, next);
      this.lastSnapshot = next;
      await this.recordChanges(changes, this.pendingActor);
      await this.markReady();
    } finally {
      this.suspendChangelog = false;
    }

    return Response.json({ ok: true }, { status: 201 });
  }

  async handleSetColumn(request) {
    const { body, error } = await readJson(request);
    if (error) return error;
    if (!body.columnId || typeof body.columnId !== "string") {
      return Response.json({ error: "columnId is required" }, { status: 400 });
    }

    const boardCheck = this.requireBoard(body.boardId);
    if (boardCheck) return boardCheck;

    const actor = this.readActor(request);
    await this.flushPendingActor(actor);
    this.pendingActor = actor;

    this.doc.transact(() => {
      this.doc.getMap("fields").set("columnId", body.columnId);
    });
    // wireChangelog arms the shared changelog alarm (trailing debounce).
    // BoardDO drops the retry row on 200. The column has to be durable first.
    if (!(await this.awaitPersisted())) {
      return Response.json({ error: "Failed to persist" }, { status: 500 });
    }

    return Response.json({ ok: true });
  }

  async handleArchive(request) {
    const { body, error } = await readJson(request);
    if (error) return error;
    if (typeof body.archived !== "boolean") {
      return Response.json({ error: "archived boolean is required" }, { status: 400 });
    }

    const boardCheck = this.requireBoard(body.boardId);
    if (boardCheck) return boardCheck;

    const actor = this.readActor(request);
    await this.flushPendingActor(actor);
    this.pendingActor = actor;

    let next;
    this.suspendChangelog = true;
    try {
      this.doc.transact(() => {
        this.doc.getMap("fields").set("archived", body.archived);
      });
      next = materializeCard(this.doc);
      const changes = diffCardSnapshots(this.lastSnapshot, next);
      this.lastSnapshot = next;
      await this.recordChanges(changes, actor);
    } finally {
      this.suspendChangelog = false;
    }

    if (!(await this.awaitPersisted())) {
      return Response.json({ error: "Failed to persist" }, { status: 500 });
    }

    try {
      await this.syncReplica("card-summary", summaryPayload(next));
    } catch (err) {
      console.error(`Card summary enqueue failed for ${next.id}`, err);
    }

    return Response.json({ ok: true, archived: body.archived });
  }

  async handleDelete() {
    if (await this.isTombstoned()) {
      return Response.json({ error: "Card not found" }, { status: 404 });
    }

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "deleted");
      } catch {
        // ignore
      }
    }

    this.changelogReady = false;
    this.lastSnapshot = null;
    await this.markTombstoned();
    return Response.json({ ok: true });
  }

  /** Reject when the request's boardId does not match the stored card. */
  requireBoard(boardId) {
    if (!boardId || typeof boardId !== "string") {
      return Response.json({ error: "boardId is required" }, { status: 400 });
    }
    const stored = this.doc.getMap("fields").get("boardId");
    if (stored !== boardId) {
      return Response.json({ error: "Card does not belong to this board" }, { status: 403 });
    }
    return null;
  }

  migrateDoc(doc, fromVersion) {
    if (fromVersion < 1) {
      const fields = doc.getMap("fields");
      if (!fields.has("title")) fields.set("title", "Untitled");
      if (!fields.has("archived")) fields.set("archived", false);
      if (!fields.has("assignee")) fields.set("assignee", "");
      if (!fields.has("due")) fields.set("due", null);
      doc.getArray("labels");
      doc.getText("body");
    }
  }

  async runOutboundSync(kind, payload) {
    if (kind === "card-summary") return this.syncCardToBoard(payload);
    console.error(`JobDO: unknown outbound kind ${kind}`);
    return true;
  }

  async handleExport() {
    try {
      await this.drainChangelog();
    } catch (err) {
      console.error("Export changelog flush failed", err);
      return Response.json({ error: "Failed to export card" }, { status: 500 });
    }
    await this.initChangelogTable();
    const rows = await this.ctx.storage.sql
      .exec("SELECT id, ts, author, field, prev, next FROM changelog ORDER BY id ASC")
      .toArray();
    const changelog = rows.map((row) => ({
      id: Number(row.id),
      ts: row.ts,
      author: row.author,
      field: row.field,
      prev: row.prev,
      next: row.next,
    }));
    return Response.json({ ...materializeCard(this.doc), changelog });
  }

  async handleHistoryRequest(url) {
    const parsed = parseHistoryQuery(url);
    if (parsed.error) return parsed.error;

    await this.initChangelogTable();
    const rows =
      parsed.before == null
        ? await this.ctx.storage.sql
            .exec(
              "SELECT id, ts, author, field, prev, next FROM changelog ORDER BY id DESC LIMIT ?",
              parsed.limit,
            )
            .toArray()
        : await this.ctx.storage.sql
            .exec(
              "SELECT id, ts, author, field, prev, next FROM changelog WHERE id < ? ORDER BY id DESC LIMIT ?",
              parsed.before,
              parsed.limit,
            )
            .toArray();

    const entries = rows.map((row) => ({
      id: Number(row.id),
      ts: row.ts,
      author: row.author,
      field: row.field,
      prev: row.prev,
      next: row.next,
    }));

    return Response.json({ entries });
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
    this.trimChangelog();
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
    this.trimChangelog();
  }

  trimChangelog() {
    this.ctx.storage.sql.exec(
      "DELETE FROM changelog WHERE id < (SELECT id FROM changelog ORDER BY id DESC LIMIT 1 OFFSET ?)",
      CHANGELOG_MAX_ENTRIES - 1,
    );
  }
}

function summaryPayload(snapshot) {
  return {
    id: snapshot.id,
    boardId: snapshot.boardId,
    title: snapshot.title,
    due: snapshot.due,
    assignee: snapshot.assignee,
    labels: snapshot.labels,
    archived: snapshot.archived,
  };
}

function parseHistoryQuery(url) {
  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw != null && limitRaw !== "") {
    if (!/^-?\d+$/.test(limitRaw)) {
      return { error: Response.json({ error: "Invalid limit" }, { status: 400 }) };
    }
    limit = Math.min(200, Math.max(1, Number(limitRaw)));
  }

  const beforeRaw = url.searchParams.get("before");
  let before = null;
  if (beforeRaw != null && beforeRaw !== "") {
    if (!/^\d+$/.test(beforeRaw) || Number(beforeRaw) < 1) {
      return { error: Response.json({ error: "Invalid before" }, { status: 400 }) };
    }
    before = Number(beforeRaw);
  }

  return { limit, before, error: null };
}
