import { DurableObject } from "cloudflare:workers";
import {
  AUTH_PURGE_ALARM_MS,
  BOARD_ROLES,
  INVITE_ROLES,
  INVITE_TTL_MS,
  MAGIC_LINK_TTL_MS,
  RATE_LIMIT_EMAIL,
  RATE_LIMIT_IP,
  RATE_LIMIT_WINDOW_MS,
} from "../lib/constants.js";

/**
 * Singleton auth store: magic links, session generation counters, rate limits,
 * memberships, and invites. Bound as AUTH_DO, idFromName("auth").
 */
export class AuthDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ready = false;
  }

  async ensureSchema() {
    if (this.ready) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS magic_links (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_gen (
        email TEXT PRIMARY KEY,
        gen INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        email TEXT NOT NULL,
        board_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (email, board_id)
      );
      CREATE TABLE IF NOT EXISTS invites (
        token_hash TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        role TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);
      CREATE INDEX IF NOT EXISTS idx_invites_expires ON invites(expires_at);
      CREATE INDEX IF NOT EXISTS idx_memberships_board ON memberships(board_id);
    `);
    this.ready = true;
    await this.schedulePurge();
  }

  async schedulePurge() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      await this.ctx.storage.setAlarm(Date.now() + AUTH_PURGE_ALARM_MS);
    }
  }

  async alarm() {
    await this.ensureSchema();
    this.purgeExpired();
    await this.ctx.storage.setAlarm(Date.now() + AUTH_PURGE_ALARM_MS);
  }

  purgeExpired() {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM magic_links WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM invites WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec(
      "DELETE FROM rate_limits WHERE window_start + ? <= ?",
      RATE_LIMIT_WINDOW_MS,
      now,
    );
  }

  async fetch(request) {
    await this.ensureSchema();
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "POST" && pathname === "/magic-links") {
      return this.createMagicLink(request);
    }
    if (method === "GET" && pathname === "/magic-links/peek") {
      return this.peekMagicLink(url);
    }
    if (method === "POST" && pathname === "/magic-links/consume") {
      return this.consumeMagicLink(request);
    }
    if (method === "GET" && pathname === "/session/gen") {
      return this.getSessionGen(url);
    }
    if (method === "POST" && pathname === "/session/bump") {
      return this.bumpSessionGen(request);
    }
    if (method === "POST" && pathname === "/memberships") {
      return this.upsertMembership(request);
    }
    if (method === "POST" && pathname === "/memberships/delete") {
      return this.deleteMembership(request);
    }
    if (method === "GET" && pathname === "/memberships") {
      return this.listMemberships(url);
    }
    if (method === "GET" && pathname === "/memberships/role") {
      return this.getMembershipRole(url);
    }
    if (method === "GET" && pathname === "/memberships/board") {
      return this.listBoardMembers(url);
    }
    if (method === "POST" && pathname === "/memberships/role") {
      return this.patchMembershipRole(request);
    }
    if (method === "POST" && pathname === "/invites") {
      return this.createInvite(request);
    }
    if (method === "POST" && pathname === "/invites/accept") {
      return this.acceptInvite(request);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  /**
   * Rate-limit then mint a magic link. Always returns 200.
   * { minted: false } when limited; { minted: true, token, email } when created.
   * Caller sends mail (or logs) outside the DO.
   */
  async createMagicLink(request) {
    const body = await request.json();
    const email = body?.email;
    const ip = typeof body?.ip === "string" ? body.ip : "";
    const tokenHash = body?.tokenHash;
    if (typeof email !== "string" || typeof tokenHash !== "string" || !tokenHash) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }

    this.purgeExpired();

    const now = Date.now();
    // Known issue: the per-email limit is keyed only by the target address, so anyone
    // can spend a victim's quota and block their sign-in for the window. Accepted for now.
    const emailLimited = this.hitRateLimit(`email:${email}`, RATE_LIMIT_EMAIL, now);
    const ipLimited = ip ? this.hitRateLimit(`ip:${ip}`, RATE_LIMIT_IP, now) : false;
    if (emailLimited || ipLimited) {
      return Response.json({ minted: false });
    }

    const expiresAt = now + MAGIC_LINK_TTL_MS;
    this.ctx.storage.sql.exec(
      "INSERT INTO magic_links (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      email,
      now,
      expiresAt,
    );

    // Token itself stays with the Worker; we only stored the hash.
    return Response.json({ minted: true, email, expiresAt });
  }

  hitRateLimit(key, max, now) {
    const row = this.ctx.storage.sql
      .exec("SELECT window_start, count FROM rate_limits WHERE key = ?", key)
      .toArray()[0];

    if (!row || row.window_start + RATE_LIMIT_WINDOW_MS <= now) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)",
        key,
        now,
      );
      return false;
    }

    if (row.count >= max) return true;

    this.ctx.storage.sql.exec("UPDATE rate_limits SET count = count + 1 WHERE key = ?", key);
    return false;
  }

  async peekMagicLink(url) {
    const tokenHash = url.searchParams.get("tokenHash");
    if (!tokenHash) {
      return Response.json({ error: "Missing tokenHash" }, { status: 400 });
    }
    this.purgeExpired();
    const row = this.ctx.storage.sql
      .exec(
        "SELECT email, expires_at FROM magic_links WHERE token_hash = ?",
        tokenHash,
      )
      .toArray()[0];
    if (!row || row.expires_at <= Date.now()) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ email: row.email, expiresAt: row.expires_at });
  }

  async consumeMagicLink(request) {
    const body = await request.json();
    const tokenHash = body?.tokenHash;
    if (typeof tokenHash !== "string" || !tokenHash) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    this.purgeExpired();

    const row = this.ctx.storage.sql
      .exec(
        "DELETE FROM magic_links WHERE token_hash = ? AND expires_at > ? RETURNING email",
        tokenHash,
        Date.now(),
      )
      .toArray()[0];

    if (!row) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const gen = this.ensureSessionGen(row.email);
    return Response.json({ email: row.email, gen });
  }

  ensureSessionGen(email) {
    const existing = this.ctx.storage.sql
      .exec("SELECT gen FROM session_gen WHERE email = ?", email)
      .toArray()[0];
    if (existing) return Number(existing.gen);
    this.ctx.storage.sql.exec("INSERT INTO session_gen (email, gen) VALUES (?, 0)", email);
    return 0;
  }

  async getSessionGen(url) {
    const email = url.searchParams.get("email");
    if (!email) {
      return Response.json({ error: "Missing email" }, { status: 400 });
    }
    const row = this.ctx.storage.sql
      .exec("SELECT gen FROM session_gen WHERE email = ?", email)
      .toArray()[0];
    if (!row) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ gen: Number(row.gen) });
  }

  async bumpSessionGen(request) {
    const body = await request.json();
    const email = body?.email;
    if (typeof email !== "string" || !email) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    this.ensureSessionGen(email);
    this.ctx.storage.sql.exec("UPDATE session_gen SET gen = gen + 1 WHERE email = ?", email);
    const row = this.ctx.storage.sql
      .exec("SELECT gen FROM session_gen WHERE email = ?", email)
      .toArray()[0];
    return Response.json({ gen: Number(row.gen) });
  }

  async upsertMembership(request) {
    const body = await request.json();
    const email = body?.email;
    const boardId = body?.boardId;
    const role = body?.role;
    if (typeof email !== "string" || !email || typeof boardId !== "string" || !boardId) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    if (!BOARD_ROLES.includes(role)) {
      return Response.json({ error: "Invalid role" }, { status: 400 });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO memberships (email, board_id, role) VALUES (?, ?, ?)
       ON CONFLICT(email, board_id) DO UPDATE SET role = excluded.role`,
      email,
      boardId,
      role,
    );
    return Response.json({ ok: true, email, boardId, role });
  }

  async deleteMembership(request) {
    const body = await request.json();
    const email = body?.email;
    const boardId = body?.boardId;
    const force = body?.force === true;
    if (typeof email !== "string" || !email || typeof boardId !== "string" || !boardId) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }

    const existing = this.ctx.storage.sql
      .exec(
        "SELECT role FROM memberships WHERE email = ? AND board_id = ?",
        email,
        boardId,
      )
      .toArray()[0];
    if (!existing) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // force: Worker rollback after a failed board init (not exposed on public routes).
    if (!force && existing.role === "owner" && this.countOwners(boardId) <= 1) {
      return Response.json({ error: "Cannot remove the last owner" }, { status: 409 });
    }

    this.ctx.storage.sql.exec(
      "DELETE FROM memberships WHERE email = ? AND board_id = ?",
      email,
      boardId,
    );
    return Response.json({ ok: true, email, boardId, role: existing.role });
  }

  countOwners(boardId) {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT COUNT(*) AS n FROM memberships WHERE board_id = ? AND role = 'owner'",
        boardId,
      )
      .toArray()[0];
    return Number(row?.n ?? 0);
  }

  async listMemberships(url) {
    const email = url.searchParams.get("email");
    if (!email) {
      return Response.json({ error: "Missing email" }, { status: 400 });
    }
    const rows = this.ctx.storage.sql
      .exec("SELECT board_id, role FROM memberships WHERE email = ?", email)
      .toArray();
    return Response.json({
      memberships: rows.map((row) => ({ boardId: row.board_id, role: row.role })),
    });
  }

  async getMembershipRole(url) {
    const email = url.searchParams.get("email");
    const boardId = url.searchParams.get("boardId");
    if (!email || !boardId) {
      return Response.json({ error: "Missing email or boardId" }, { status: 400 });
    }
    const row = this.ctx.storage.sql
      .exec(
        "SELECT role FROM memberships WHERE email = ? AND board_id = ?",
        email,
        boardId,
      )
      .toArray()[0];
    if (!row) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ role: row.role });
  }

  async listBoardMembers(url) {
    const boardId = url.searchParams.get("boardId");
    if (!boardId) {
      return Response.json({ error: "Missing boardId" }, { status: 400 });
    }
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT email, role FROM memberships WHERE board_id = ? ORDER BY email ASC",
        boardId,
      )
      .toArray();
    return Response.json({
      members: rows.map((row) => ({ email: row.email, role: row.role })),
    });
  }

  async patchMembershipRole(request) {
    const body = await request.json();
    const email = body?.email;
    const boardId = body?.boardId;
    const role = body?.role;
    if (typeof email !== "string" || !email || typeof boardId !== "string" || !boardId) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    if (!BOARD_ROLES.includes(role)) {
      return Response.json({ error: "Invalid role" }, { status: 400 });
    }

    const existing = this.ctx.storage.sql
      .exec(
        "SELECT role FROM memberships WHERE email = ? AND board_id = ?",
        email,
        boardId,
      )
      .toArray()[0];
    if (!existing) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (existing.role === "owner" && role !== "owner" && this.countOwners(boardId) <= 1) {
      return Response.json({ error: "Cannot demote the last owner" }, { status: 409 });
    }

    this.ctx.storage.sql.exec(
      "UPDATE memberships SET role = ? WHERE email = ? AND board_id = ?",
      role,
      email,
      boardId,
    );
    return Response.json({ ok: true, email, boardId, role, previousRole: existing.role });
  }

  async createInvite(request) {
    const body = await request.json();
    const tokenHash = body?.tokenHash;
    const boardId = body?.boardId;
    const role = body?.role;
    const invitedBy = body?.invitedBy;
    if (
      typeof tokenHash !== "string" ||
      !tokenHash ||
      typeof boardId !== "string" ||
      !boardId ||
      typeof invitedBy !== "string" ||
      !invitedBy
    ) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }
    if (!INVITE_ROLES.includes(role)) {
      return Response.json({ error: "Invalid role" }, { status: 400 });
    }

    this.purgeExpired();
    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO invites (token_hash, board_id, role, invited_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash,
      boardId,
      role,
      invitedBy,
      now,
      expiresAt,
    );
    return Response.json({ ok: true, boardId, role, expiresAt });
  }

  async acceptInvite(request) {
    const body = await request.json();
    const tokenHash = body?.tokenHash;
    const email = body?.email;
    if (typeof tokenHash !== "string" || !tokenHash || typeof email !== "string" || !email) {
      return Response.json({ error: "Invalid body" }, { status: 400 });
    }

    this.purgeExpired();
    const now = Date.now();

    let result;
    try {
      result = this.ctx.storage.transactionSync(() => {
        const row = this.ctx.storage.sql
          .exec(
            `DELETE FROM invites WHERE token_hash = ? AND expires_at > ? RETURNING board_id, role`,
            tokenHash,
            now,
          )
          .toArray()[0];
        if (!row) return { error: "Invalid or expired invite", status: 404 };

        const existing = this.ctx.storage.sql
          .exec(
            "SELECT role FROM memberships WHERE email = ? AND board_id = ?",
            email,
            row.board_id,
          )
          .toArray()[0];
        if (existing) {
          return {
            ok: true,
            boardId: row.board_id,
            role: existing.role,
            alreadyMember: true,
          };
        }

        this.ctx.storage.sql.exec(
          "INSERT INTO memberships (email, board_id, role) VALUES (?, ?, ?)",
          email,
          row.board_id,
          row.role,
        );
        return {
          ok: true,
          boardId: row.board_id,
          role: row.role,
          alreadyMember: false,
        };
      });
    } catch (err) {
      console.error("acceptInvite failed", err);
      return Response.json({ error: "Auth store failed" }, { status: 500 });
    }

    if (result.error) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    return Response.json(result);
  }
}
