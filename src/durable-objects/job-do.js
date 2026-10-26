import { YjsRoom } from "./yjs-room.js";
import { createEmptyJobDoc, materializeJob } from "../lib/materialize.js";
import { diffJobSnapshots } from "../lib/changelog.js";
import { GIT_FLUSH_ALARM_MS, JOB_STATUSES, WORKSPACE_ID } from "../lib/constants.js";

const CHANGELOG_DEBOUNCE_MS = 400;

// Card summary fields mirrored to the board; changes to these trigger a board sync.
const SUMMARY_FIELDS = new Set(["title", "status", "slug", "due", "client.name"]);

export class JobDO extends YjsRoom {
  constructor(ctx, env) {
    super(ctx, env, {
      createDoc: () => createEmptyJobDoc(null),
    });
    this.changelogReady = false;
    this.lastSnapshot = null;
    this.changelogTimer = null;
  }

  async ensureDoc() {
    const doc = await super.ensureDoc();
    if (!this.changelogReady) {
      this.changelogReady = true;
      await this.initChangelogTable();
      this.lastSnapshot = materializeJob(doc);
      this.wireChangelog(doc);
    }
    return doc;
  }

  wireChangelog(doc) {
    // Any change (local, remote, or server-side) projects to the changelog and
    // schedules the debounced git-mirror flush.
    const onChange = () => {
      this.scheduleChangelog();
      void this.scheduleGitFlush();
    };
    doc.getMap("fields").observeDeep(onChange);
    doc.getText("body").observe(onChange);
  }

  scheduleChangelog() {
    if (this.changelogTimer) clearTimeout(this.changelogTimer);
    this.changelogTimer = setTimeout(() => {
      this.changelogTimer = null;
      void this.flushChangelog();
    }, CHANGELOG_DEBOUNCE_MS);
  }

  async flushChangelog() {
    if (!this.doc || !this.lastSnapshot) return;

    const next = materializeJob(this.doc);
    const changes = diffJobSnapshots(this.lastSnapshot, next);
    if (changes.length === 0) return;
    this.lastSnapshot = next;

    for (const change of changes) {
      await this.appendChangelog({
        author: "editor",
        field: change.field,
        prev: change.prev,
        next: change.next,
      });
    }

    if (changes.some((c) => SUMMARY_FIELDS.has(c.field))) {
      await this.syncCardToBoard(next);
    }
  }

  /** Push this job's summary to the board so the card reflects field edits. */
  async syncCardToBoard(snapshot) {
    if (!snapshot.id) return;
    try {
      const stub = this.env.BOARD_DO.get(this.env.BOARD_DO.idFromName(WORKSPACE_ID));
      await stub.fetch(
        new Request("https://do.internal/cards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: snapshot.id,
            slug: snapshot.slug,
            title: snapshot.title,
            clientName: snapshot.client.name,
            due: snapshot.due,
            status: snapshot.status,
          }),
        }),
      );
    } catch (err) {
      console.error(`Card sync failed for ${snapshot.id}`, err);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/init")) {
      return this.handleInit(request);
    }

    if (request.method === "POST" && url.pathname.endsWith("/status")) {
      return this.handleSetStatus(request);
    }

    if (request.method === "GET" && url.pathname.endsWith("/snapshot")) {
      await this.ensureDoc();
      return Response.json(materializeJob(this.doc));
    }

    return super.fetch(request);
  }

  async handleInit(request) {
    const body = await request.json();

    await this.ensureDoc();
    // Mutating fields fires the doc "update" handler, which persists state.
    this.doc.transact(() => {
      const fields = this.doc.getMap("fields");
      fields.set("id", body.id);
      fields.set("slug", body.slug);
      fields.set("title", body.title);
    });
    await this.flushChangelog();

    return Response.json({ ok: true }, { status: 201 });
  }

  /** Set status from a board drag/drop. JobDO remains the source of truth. */
  async handleSetStatus(request) {
    const { status } = await request.json();
    if (!JOB_STATUSES.includes(status)) {
      return Response.json({ error: "Invalid status" }, { status: 400 });
    }

    await this.ensureDoc();
    this.doc.transact(() => this.doc.getMap("fields").set("status", status));
    await this.flushChangelog();

    return Response.json({ ok: true });
  }

  /** Debounced alarm for materialized snapshot + git mirror flush. */
  async scheduleGitFlush() {
    const when = Date.now() + GIT_FLUSH_ALARM_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > when) {
      await this.ctx.storage.setAlarm(when);
    }
  }

  async alarm() {
    await this.ensureDoc();
    const snapshot = materializeJob(this.doc);
    await this.ctx.storage.put("snapshot:latest", snapshot);
    console.log(`Job ${snapshot.id} snapshot materialized (${snapshot.status})`);
  }
}
