import { normalizeEmail, randomTokenHex, sha256Hex } from "../lib/auth.js";
import { BOARD_ROLES, INVITE_ROLES } from "../lib/constants.js";
import { appOrigin } from "../lib/csrf.js";
import { readJson } from "../lib/json.js";
import { safeDecode } from "../lib/path.js";
import {
  authStub,
  jsonDoRequest,
  requireRole,
  requireSession,
  revokeMemberSockets,
} from "./do.js";

/** Routes under /api/boards/:boardId for invites and members, plus /api/invites/accept. */
export async function routeBoardMembers(request, env, boardId, rest) {
  const method = request.method;

  if (rest === "/invites" && method === "POST") {
    return createInvite(request, env, boardId);
  }
  if (rest === "/members" && method === "GET") {
    return listMembers(request, env, boardId);
  }

  const memberMatch = rest.match(/^\/members\/([^/]+)$/);
  if (memberMatch && (method === "PATCH" || method === "DELETE")) {
    const email = normalizeEmail(safeDecode(memberMatch[1]) ?? "");
    if (!email) {
      return Response.json({ error: "Invalid email" }, { status: 400 });
    }
    if (method === "PATCH") return patchMember(request, env, boardId, email);
    return deleteMember(request, env, boardId, email);
  }

  return null;
}

export async function routeInviteAccept(request, env) {
  const session = await requireSession(request, env);
  if (session.error) return session.error;

  const { body, error } = await readJson(request);
  if (error) return error;

  const token = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return Response.json({ error: "Invalid or expired invite" }, { status: 400 });
  }

  const tokenHash = await sha256Hex(token);
  const response = await authStub(env).fetch(
    jsonDoRequest("/invites/accept", "POST", { tokenHash, email: session.email }),
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return Response.json({ error: "Invalid or expired invite" }, { status: 400 });
  }
  if (!response.ok) {
    await response.body?.cancel();
    return Response.json({ error: "Auth store failed" }, { status: 500 });
  }

  const result = await response.json();
  return Response.json({
    ok: true,
    boardId: result.boardId,
    role: result.role,
    alreadyMember: Boolean(result.alreadyMember),
  });
}

async function createInvite(request, env, boardId) {
  const gate = await requireRole(request, env, boardId, "owner");
  if (gate.error) return gate.error;

  const { body, error } = await readJson(request);
  if (error) return error;

  const role = body.role;
  if (!INVITE_ROLES.includes(role)) {
    return Response.json({ error: "role must be editor or viewer" }, { status: 400 });
  }

  const token = randomTokenHex(32);
  const tokenHash = await sha256Hex(token);
  const stored = await authStub(env).fetch(
    jsonDoRequest("/invites", "POST", {
      tokenHash,
      boardId,
      role,
      invitedBy: gate.email,
    }),
  );
  if (!stored.ok) {
    const detail = await stored.json().catch(() => null);
    return Response.json(
      { error: detail?.error || "Failed to create invite" },
      { status: stored.status },
    );
  }
  const data = await stored.json();
  const origin = appOrigin(request, env);
  const url = `${origin}/invite?token=${encodeURIComponent(token)}`;

  return Response.json(
    { token, url, role, expiresAt: data.expiresAt },
    { status: 201 },
  );
}

async function listMembers(request, env, boardId) {
  const gate = await requireRole(request, env, boardId, "owner");
  if (gate.error) return gate.error;

  const response = await authStub(env).fetch(
    new Request(`https://do.internal/memberships/board?boardId=${encodeURIComponent(boardId)}`),
  );
  if (!response.ok) {
    await response.body?.cancel();
    return Response.json({ error: "Auth store failed" }, { status: 500 });
  }
  return response;
}

async function patchMember(request, env, boardId, email) {
  const gate = await requireRole(request, env, boardId, "owner");
  if (gate.error) return gate.error;

  const { body, error } = await readJson(request);
  if (error) return error;
  if (!BOARD_ROLES.includes(body.role)) {
    return Response.json({ error: "Invalid role" }, { status: 400 });
  }

  const response = await authStub(env).fetch(
    jsonDoRequest("/memberships/role", "POST", { email, boardId, role: body.role }),
  );
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    return Response.json(
      { error: detail?.error || "Failed to update member" },
      { status: response.status },
    );
  }

  const result = await response.json();
  if (result.previousRole !== result.role) {
    await revokeMemberSockets(env, boardId, email);
  }
  return Response.json(result);
}

async function deleteMember(request, env, boardId, email) {
  const session = await requireSession(request, env);
  if (session.error) return session.error;

  const isSelf = session.email === email;
  if (!isSelf) {
    const gate = await requireRole(request, env, boardId, "owner");
    if (gate.error) return gate.error;
  } else {
    // Leaving still requires being a member (viewer+).
    const gate = await requireRole(request, env, boardId, "viewer");
    if (gate.error) return gate.error;
  }

  const response = await authStub(env).fetch(
    jsonDoRequest("/memberships/delete", "POST", { email, boardId }),
  );
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    return Response.json(
      { error: detail?.error || "Failed to remove member" },
      { status: response.status },
    );
  }

  await revokeMemberSockets(env, boardId, email);
  return Response.json({ ok: true });
}
