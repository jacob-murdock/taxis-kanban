import { BOARD_ID_RE, BOARD_NAME_MAX, COLUMN_ID_RE } from "../lib/constants.js";
import { readJson } from "../lib/json.js";
import { generateBoardId } from "../lib/materialize.js";
import { safeDecode } from "../lib/path.js";
import { routeCards } from "./cards.js";
import { boardStub, forwardToBoard, forwardToCatalog, jsonDoRequest, requireUpgrade } from "./do.js";

export async function routeApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/catalog/ws") {
    const upgrade = requireUpgrade(request);
    if (upgrade) return upgrade;
    return forwardToCatalog(env, request, "/ws");
  }
  if (pathname === "/api/catalog/snapshot" && method === "GET") {
    return forwardToCatalog(env, request, "/snapshot");
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
    return patchBoard(request, env, boardId);
  }
  if (rest === "/ws") {
    const upgrade = requireUpgrade(request);
    if (upgrade) return upgrade;
    return forwardToBoard(env, boardId, request, "/ws");
  }
  if (rest === "/snapshot" && method === "GET") {
    return forwardToBoard(env, boardId, request, "/snapshot");
  }
  if (rest === "/columns" && method === "POST") {
    return postColumn(request, env, boardId);
  }
  if (rest === "/columns/order" && method === "POST") {
    return reorderColumns(request, env, boardId);
  }

  const columnMatch = rest.match(/^\/columns\/([^/]+)$/);
  if (columnMatch && (method === "PATCH" || method === "DELETE")) {
    const columnId = safeDecode(columnMatch[1]);
    if (columnId == null) {
      return Response.json({ error: "Invalid path encoding" }, { status: 400 });
    }
    if (!COLUMN_ID_RE.test(columnId)) {
      return Response.json({ error: "Invalid column id" }, { status: 400 });
    }
    if (method === "DELETE") {
      return forwardToBoard(env, boardId, request, `/columns/${columnId}`);
    }
    return renameColumn(request, env, boardId, columnId);
  }

  if (rest.startsWith("/cards")) {
    return routeCards(request, env, boardId, rest);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

async function createBoard(request, env) {
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
  const response = await boardStub(env, boardId).fetch(
    jsonDoRequest("/init", "POST", { id: boardId, name }),
  );
  if (!response.ok) {
    return Response.json({ error: "Failed to create board" }, { status: 500 });
  }

  return Response.json({ id: boardId, name }, { status: 201 });
}

async function patchBoard(request, env, boardId) {
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

  return boardStub(env, boardId).fetch(jsonDoRequest("/meta", "PATCH", patch));
}

async function postColumn(request, env, boardId) {
  const { body, error } = await readJson(request);
  if (error) return error;
  return boardStub(env, boardId).fetch(jsonDoRequest("/columns", "POST", { name: body.name }));
}

async function renameColumn(request, env, boardId, columnId) {
  const { body, error } = await readJson(request);
  if (error) return error;
  return boardStub(env, boardId).fetch(
    jsonDoRequest(`/columns/${columnId}`, "PATCH", { name: body.name }),
  );
}

async function reorderColumns(request, env, boardId) {
  const { body, error } = await readJson(request);
  if (error) return error;
  return boardStub(env, boardId).fetch(jsonDoRequest("/columns/order", "POST", { ids: body.ids }));
}
