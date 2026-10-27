import * as Y from "yjs";
import { YjsRoom } from "./yjs-room.js";
import { createEmptyCardDoc, materializeCard } from "../lib/materialize.js";
import { diffCardSnapshots } from "../lib/changelog.js";
import { ROLE_RANK, SNAPSHOT_ALARM_MS } from "../lib/constants.js";
import { readJson } from "../lib/json.js";
import {
  clampLabels,
  clampLiveAssignee,
  clampLiveDue,
  clampLiveTitle,
  clampStoredTitle,
  sameLabels,
} from "../lib/fields.js";

const CHANGELOG_DEBOUNCE_MS = 400;

// Board-card summary fields; columnId and rank are owned by BoardDO placement.
const SUMMARY_FIELDS = new Set(["title", "due", "assignee", "labels", "archived"]);

export class JobDO extends YjsRoom {
  constructor(ctx, env) {
    super(ctx, env, {
      createDoc: () => createEmptyCardDoc(null, null),
    });
    this.changelogReady = false;
    this.lastSnapshot = null;
    this.changelogTimer = null;
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
      await this.initChangelogTable();
      this.lastSnapshot = materializeCard(doc);
      this.wireChangelog(doc);
    }
    return doc;
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
      void this.scheduleSnapshotAlarm();
    };
    doc.getMap("fields").observeDeep(onChange);
    doc.getArray("labels").observe(onChange);
    doc.getText("body").observe(onChange);
  }

  /**
   * Debounce changelog writes for one actor. Callers flush a different actor
   * before applying that person's edit. The timer closes over `nextActor` so a
   * later request cannot relabel this batch.
   */
  scheduleChangelog(actor) {
    const nextActor = actor || this.pendingActor || "system";
    this.pendingActor = nextActor;
    if (this.changelogTimer) clearTimeout(this.changelogTimer);
    this.changelogTimer = setTimeout(() => {
      this.changelogTimer = null;
      void this.flushChangelog(nextActor);
    }, CHANGELOG_DEBOUNCE_MS);
  }

  /** Flush a debounced batch when `nextActor` is about to write as someone else. */
  async flushPendingActor(nextActor) {
    if (!this.changelogTimer || !this.pendingActor || this.pendingActor === nextActor) return;
    const previous = this.pendingActor;
    clearTimeout(this.changelogTimer);
    this.changelogTimer = null;
    await this.flushChangelog(previous);
  }

  async flushChangelog(author) {
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
      await this.syncCardToBoard(next);
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
    if (!snapshot.id || !snapshot.boardId) return false;
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
      if (!response.ok) {
        console.error(`Card sync failed for ${snapshot.id}: ${response.status}`);
        return false;
      }
      return true;
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

    if (request.method === "GET" && path.endsWith("/history")) {
      return this.handleHistoryRequest(url);
    }

    return super.fetch(request);
  }

  async webSocketMessage(ws, message) {
    if (typeof message === "string") return;
    const attachment = ws.deserializeAttachment() || {};
    // Viewers may subscribe but inbound updates are dropped.
    if ((ROLE_RANK[attachment.role] ?? 0) < ROLE_RANK.editor) return;
    if (await this.isTombstoned()) return;
    if (!(await this.isReady())) return;

    const actor = attachment.email || "system";
    await this.flushPendingActor(actor);
    await this.ensureDoc();
    this.pendingActor = actor;

    const before = this.captureProtected();
    this.suspendChangelog = true;
    try {
      // Inlined from YjsRoom so the changelog diff is taken before the next
      // await. super.webSocketMessage persists first, and another editor can
      // land inside that gap.
      const update = new Uint8Array(message);
      Y.applyUpdate(this.doc, update, "remote");
      for (const peer of this.ctx.getWebSockets()) {
        if (peer !== ws) peer.send(update);
      }
      this.reconcileRemote(before);
    } finally {
      this.suspendChangelog = false;
    }

    const persisted = this.persistState();
    const logged = this.flushChangelog(actor);
    await logged;
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

  /** Put protected keys back and clamp title, assignee, due, and labels. */
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
      return;
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
    });
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
    await this.flushChangelog(actor);

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

    const synced = await this.syncCardToBoard(next);
    if (!synced) {
      return Response.json({ error: "Failed to sync board" }, { status: 500 });
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

  async scheduleSnapshotAlarm() {
    const when = Date.now() + SNAPSHOT_ALARM_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > when) {
      await this.ctx.storage.setAlarm(when);
    }
  }

  async alarm() {
    if (await this.isTombstoned() || !(await this.isReady())) return;
    await this.ensureDoc();
    const snapshot = materializeCard(this.doc);
    await this.ctx.storage.put("snapshot:latest", snapshot);
    console.log(`Card ${snapshot.id} snapshot materialized`);
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
