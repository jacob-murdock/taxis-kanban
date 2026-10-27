import { BOARD_ID_RE, BOARD_NAME_MAX, COLUMN_ID_RE } from "../lib/constants.js";
import { readJson } from "../lib/json.js";
import { generateBoardId } from "../lib/materialize.js";
import { safeDecode } from "../lib/path.js";
import { routeCards } from "./cards.js";
import {
  authStub,
  boardStub,
  catalogStub,
  forwardToBoard,
  jsonDoRequest,
  requireRole,
  requireSession,
  requireUpgrade,
  withCallerRole,
} from "./do.js";
import { routeBoardMembers, routeInviteAccept } from "./members.js";

export async function routeApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/catalog/ws") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (pathname === "/api/catalog/snapshot" && method === "GET") {
    return catalogSnapshot(request, env);
  }

  if (pathname === "/api/invites/accept" && method === "POST") {
    return routeInviteAccept(request, env);
  }

  if (pathname === "/api/boards" && method === "POST") {
    return createBoard(request, env);
  }

  const boardMatch = pathname.match(/^\/api\/boards\/([^/]+)(\/.*)?$/);
  if (!boardMatch) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const boardId = safeDecode(boardMatch[1]);
  if (boardId == null) {
    return Response.json({ error: "Invalid path encoding" }, { status: 400 });
  }
  if (!BOARD_ID_RE.test(boardId)) {
    return Response.json({ error: "Invalid board id" }, { status: 400 });
  }

  const rest = boardMatch[2] ?? "";
  if (rest === "" && method === "PATCH") {
    const gate = await requireRole(request, env, boardId, "owner");
    if (gate.error) return gate.error;
    return patchBoard(request, env, boardId, gate);
  }
  if (rest === "/ws") {
    const upgrade = requireUpgrade(request);
    if (upgrade) return upgrade;
    const gate = await requireRole(request, env, boardId, "viewer");
    if (gate.error) return gate.error;
    return forwardToBoard(env, boardId, request, "/ws", {}, gate);
  }
  if (rest === "/snapshot" && method === "GET") {
    const gate = await requireRole(request, env, boardId, "viewer");
    if (gate.error) return gate.error;
    const response = await forwardToBoard(env, boardId, request, "/snapshot", null, gate);
    return withCallerRole(response, gate.role);
  }
  if (rest === "/columns" && method === "POST") {
    const gate = await requireRole(request, env, boardId, "editor");
    if (gate.error) return gate.error;
    return postColumn(request, env, boardId, gate);
  }
  if (rest === "/columns/order" && method === "POST") {
    const gate = await requireRole(request, env, boardId, "editor");
    if (gate.error) return gate.error;
    return reorderColumns(request, env, boardId, gate);
  }

  const columnMatch = rest.match(/^\/columns\/([^/]+)$/);
  if (columnMatch && (method === "PATCH" || method === "DELETE")) {
    const gate = await requireRole(request, env, boardId, "editor");
    if (gate.error) return gate.error;
    const columnId = safeDecode(columnMatch[1]);
    if (columnId == null) {
      return Response.json({ error: "Invalid path encoding" }, { status: 400 });
    }
    if (!COLUMN_ID_RE.test(columnId)) {
      return Response.json({ error: "Invalid column id" }, { status: 400 });
    }
    if (method === "DELETE") {
      return forwardToBoard(env, boardId, request, `/columns/${columnId}`, null, gate);
    }
    return renameColumn(request, env, boardId, columnId, gate);
  }

  if (rest.startsWith("/cards")) {
    return routeCards(request, env, boardId, rest);
  }

  const membersResponse = await routeBoardMembers(request, env, boardId, rest);
  if (membersResponse) return membersResponse;

  return Response.json({ error: "Not found" }, { status: 404 });
}

async function catalogSnapshot(request, env) {
  const session = await requireSession(request, env);
  if (session.error) return session.error;

  const memResponse = await authStub(env).fetch(
    new Request(`https://do.internal/memberships?email=${encodeURIComponent(session.email)}`),
  );
  if (!memResponse.ok) {
    await memResponse.body?.cancel();
    return Response.json({ error: "Auth store failed" }, { status: 500 });
  }
  const { memberships } = await memResponse.json();
  const roleByBoard = new Map(memberships.map((m) => [m.boardId, m.role]));

  const catalogResponse = await catalogStub(env).fetch(
    new Request("https://do.internal/snapshot", { method: "GET" }),
  );
  if (!catalogResponse.ok) return catalogResponse;
  const catalog = await catalogResponse.json();
  const boards = (catalog.boards || [])
    .filter((board) => roleByBoard.has(board.id))
    .map((board) => ({ ...board, role: roleByBoard.get(board.id) }));

  return Response.json({ boards });
}

async function createBoard(request, env) {
  const session = await requireSession(request, env);
  if (session.error) return session.error;

  const { body, error } = await readJson(request);
  if (error) return error;

  if (typeof body.name !== "string") {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  const name = body.name.trim().slice(0, BOARD_NAME_MAX);
  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  const boardId = generateBoardId();

  const membership = await authStub(env).fetch(
    jsonDoRequest("/memberships", "POST", {
      email: session.email,
      boardId,
      role: "owner",
    }),
  );
  if (!membership.ok) {
    await membership.body?.cancel();
    return Response.json({ error: "Failed to create board" }, { status: 500 });
  }
  await membership.body?.cancel();

  const response = await boardStub(env, boardId).fetch(
    jsonDoRequest("/init", "POST", { id: boardId, name }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    const rollback = await authStub(env).fetch(
      jsonDoRequest("/memberships/delete", "POST", {
        email: session.email,
        boardId,
        force: true,
      }),
    );
    await rollback.body?.cancel();
    return Response.json({ error: "Failed to create board" }, { status: 500 });
  }
  await response.body?.cancel();

  return Response.json({ id: boardId, name, role: "owner" }, { status: 201 });
}

async function patchBoard(request, env, boardId, gate) {
  const { body, error } = await readJson(request);
  if (error) return error;

  const patch = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return Response.json({ error: "name must be a string" }, { status: 400 });
    }
    const name = body.name.trim().slice(0, BOARD_NAME_MAX);
    if (!name) {
      return Response.json({ error: "name must not be empty" }, { status: 400 });
    }
    patch.name = name;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      return Response.json({ error: "archived must be a boolean" }, { status: 400 });
    }
    patch.archived = body.archived;
  }
  if (patch.name === undefined && patch.archived === undefined) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  return boardStub(env, boardId).fetch(jsonDoRequest("/meta", "PATCH", patch, gate));
}

async function postColumn(request, env, boardId, gate) {
  const { body, error } = await readJson(request);
  if (error) return error;
  return boardStub(env, boardId).fetch(
    jsonDoRequest("/columns", "POST", { name: body.name }, gate),
  );
}

async function renameColumn(request, env, boardId, columnId, gate) {
  const { body, error } = await readJson(request);
  if (error) return error;
  return boardStub(env, boardId).fetch(
    jsonDoRequest(`/columns/${columnId}`, "PATCH", { name: body.name }, gate),
  );
}

async function reorderColumns(request, env, boardId, gate) {
  const { body, error } = await readJson(request);
  if (error) return error;
  return boardStub(env, boardId).fetch(
    jsonDoRequest("/columns/order", "POST", { ids: body.ids }, gate),
  );
}
