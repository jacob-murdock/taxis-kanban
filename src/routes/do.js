import { ROLE_RANK } from "../lib/constants.js";
import { readVerifiedSession } from "../lib/session.js";

export function authStub(env) {
  return env.AUTH_DO.get(env.AUTH_DO.idFromName("auth"));
}

export function catalogStub(env) {
  return env.CATALOG_DO.get(env.CATALOG_DO.idFromName("catalog"));
}

export function boardStub(env, boardId) {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));
}

export function jobStub(env, cardId) {
  return env.JOB_DO.get(env.JOB_DO.idFromName(cardId));
}

export function requireUpgrade(request) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Response.json({ error: "Expected WebSocket upgrade" }, { status: 426 });
  }
  return null;
}

function stripActorHeaders(headers) {
  for (const key of [...headers.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("x-tk-") || lower.startsWith("x-actor-")) {
      headers.delete(key);
    }
  }
}

function applyActorHeaders(headers, actor) {
  if (!actor) return;
  if (actor.email) headers.set("X-TK-Actor", actor.email);
  if (actor.role) headers.set("X-TK-Role", actor.role);
}

/**
 * Forward to a Durable Object. Strips any client-supplied X-TK-* / X-Actor-*
 * headers, then sets Worker-trusted actor identity when provided.
 */
export function buildDoRequest(request, path, search, actor) {
  const url = new URL(request.url);
  url.pathname = path;
  if (search) {
    url.search = "";
    for (const [key, value] of Object.entries(search)) {
      if (value != null) url.searchParams.set(key, value);
    }
  }
  // Identity travels on Worker-set headers, never on the query string.
  url.searchParams.delete("actorEmail");
  url.searchParams.delete("actorRole");

  const headers = new Headers(request.headers);
  stripActorHeaders(headers);
  applyActorHeaders(headers, actor);

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(url.toString(), init);
}

export function jsonDoRequest(path, method, body, actor) {
  const headers = new Headers({ "Content-Type": "application/json" });
  applyActorHeaders(headers, actor);
  return new Request(`https://do.internal${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

export function forwardToCatalog(env, request, path, actor) {
  return catalogStub(env).fetch(buildDoRequest(request, path, null, actor));
}

export function forwardToBoard(env, boardId, request, path, search, actor) {
  return boardStub(env, boardId).fetch(buildDoRequest(request, path, search, actor));
}

export function forwardToJob(env, cardId, request, path, search, actor) {
  return jobStub(env, cardId).fetch(buildDoRequest(request, path, search, actor));
}

/** Close board + card sockets for an email after membership change. */
export async function revokeMemberSockets(env, boardId, email) {
  const boardRevoke = await boardStub(env, boardId).fetch(
    jsonDoRequest("/revoke-sockets", "POST", { email }),
  );
  await boardRevoke.body?.cancel();

  const snapshotResponse = await boardStub(env, boardId).fetch(
    new Request("https://do.internal/snapshot", { method: "GET" }),
  );
  if (!snapshotResponse.ok) {
    console.error(`revokeMemberSockets: board snapshot failed (${snapshotResponse.status}) for ${boardId}`);
    await snapshotResponse.body?.cancel();
    return;
  }
  const board = await snapshotResponse.json();
  const cardIds = board.cards && typeof board.cards === "object"
    ? Object.keys(board.cards)
    : [];
  await Promise.all(
    cardIds.map((cardId) =>
      jobStub(env, cardId)
        .fetch(jsonDoRequest("/revoke-sockets", "POST", { email }))
        .then((response) => response.body?.cancel()),
    ),
  );
}

/** Close sockets on every board the email belongs to (logout). */
export async function revokeUserSockets(env, email) {
  const response = await authStub(env).fetch(
    new Request(`https://do.internal/memberships?email=${encodeURIComponent(email)}`),
  );
  if (!response.ok) {
    console.error(`revokeUserSockets: memberships lookup failed (${response.status})`);
    await response.body?.cancel();
    return;
  }
  const { memberships } = await response.json();
  await Promise.all(
    (memberships || []).map((row) => revokeMemberSockets(env, row.boardId, email)),
  );
}

export async function requireSession(request, env) {
  if (!env.SESSION_SECRET) {
    return { error: Response.json({ error: "Auth is not configured" }, { status: 500 }) };
  }
  const session = await readVerifiedSession(request, env);
  if (!session) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { email: session.email, gen: session.gen, error: null };
}

/**
 * Session + board membership with at least `minRole` (viewer | editor | owner).
 * Returns { email, role, error }.
 */
export async function requireRole(request, env, boardId, minRole) {
  const session = await requireSession(request, env);
  if (session.error) return session;

  const needed = ROLE_RANK[minRole];
  if (!needed) {
    return { error: Response.json({ error: "Invalid role gate" }, { status: 500 }) };
  }

  const response = await authStub(env).fetch(
    new Request(
      `https://do.internal/memberships/role?email=${encodeURIComponent(session.email)}&boardId=${encodeURIComponent(boardId)}`,
    ),
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return { error: Response.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { error: Response.json({ error: "Auth store failed" }, { status: 500 }) };
  }

  const { role } = await response.json();
  if ((ROLE_RANK[role] ?? 0) < needed) {
    return { error: Response.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { email: session.email, role, error: null };
}

/** Attach `role` onto a JSON DO response body. */
export async function withCallerRole(response, role) {
  if (!response.ok) return response;
  const data = await response.json();
  return Response.json({ ...data, role });
}
