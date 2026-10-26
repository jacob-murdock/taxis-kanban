import { CARD_ID_RE, CARD_TITLE_MAX, COLUMN_ID_RE } from "../lib/constants.js";
import { readJson } from "../lib/json.js";
import { generateCardId } from "../lib/materialize.js";
import { safeDecode } from "../lib/path.js";
import { boardStub, forwardToJob, jobStub, jsonDoRequest, requireUpgrade } from "./do.js";

export async function routeCards(request, env, boardId, rest) {
  const method = request.method;

  if (rest === "/cards" && method === "POST") {
    return createCard(request, env, boardId);
  }

  const cardMatch = rest.match(/^\/cards\/([^/]+)(\/.*)?$/);
  if (!cardMatch) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const cardId = safeDecode(cardMatch[1]);
  if (cardId == null) {
    return Response.json({ error: "Invalid path encoding" }, { status: 400 });
  }
  if (!CARD_ID_RE.test(cardId)) {
    return Response.json({ error: "Invalid card id" }, { status: 400 });
  }

  const cardRest = cardMatch[2] ?? "";
  if (cardRest === "/move" && method === "POST") {
    return moveCard(request, env, boardId, cardId);
  }
  if (cardRest === "/archive" && method === "POST") {
    return archiveCard(request, env, boardId, cardId);
  }
  if (cardRest === "" && method === "DELETE") {
    return deleteCard(env, boardId, cardId);
  }
  if (cardRest === "/ws") {
    const upgrade = requireUpgrade(request);
    if (upgrade) return upgrade;
    const { error } = await assertCardBoard(env, boardId, cardId);
    if (error) return error;
    return forwardToJob(env, cardId, request, "/ws", { boardId });
  }
  if (cardRest === "/snapshot" && method === "GET") {
    const { error } = await assertCardBoard(env, boardId, cardId);
    if (error) return error;
    return forwardToJob(env, cardId, request, "/snapshot");
  }
  if (cardRest === "/history" && method === "GET") {
    const { error } = await assertCardBoard(env, boardId, cardId);
    if (error) return error;
    return forwardToJob(env, cardId, request, "/history");
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

async function createCard(request, env, boardId) {
  const { body, error } = await readJson(request);
  if (error) return error;

  if (body.title !== undefined && typeof body.title !== "string") {
    return Response.json({ error: "title must be a string" }, { status: 400 });
  }
  const title =
    (typeof body.title === "string" ? body.title : "").trim().slice(0, CARD_TITLE_MAX) ||
    "Untitled";

  const snapshotResponse = await boardStub(env, boardId).fetch(
    new Request("https://do.internal/snapshot", { method: "GET" }),
  );
  if (!snapshotResponse.ok) {
    return Response.json({ error: "Board not found" }, { status: snapshotResponse.status });
  }
  const board = await snapshotResponse.json();

  let columnId = body.columnId ?? null;
  if (columnId != null) {
    if (typeof columnId !== "string" || !COLUMN_ID_RE.test(columnId)) {
      return Response.json({ error: "Invalid column id" }, { status: 400 });
    }
    if (!board.columns.some((c) => c.id === columnId)) {
      return Response.json({ error: "Unknown column" }, { status: 400 });
    }
  } else {
    columnId = board.columns[0]?.id ?? null;
    if (!columnId) {
      return Response.json({ error: "Board has no columns" }, { status: 400 });
    }
  }

  const cardId = generateCardId();
  const initResponse = await jobStub(env, cardId).fetch(
    jsonDoRequest("/init", "POST", { id: cardId, boardId, title, columnId }),
  );
  if (!initResponse.ok) {
    return Response.json({ error: "Failed to initialize card" }, { status: 500 });
  }

  const insertResponse = await boardStub(env, boardId).fetch(
    jsonDoRequest("/cards", "POST", { id: cardId, title, columnId }),
  );
  if (!insertResponse.ok) {
    await jobStub(env, cardId).fetch(new Request("https://do.internal/destroy", { method: "DELETE" }));
    return Response.json({ error: "Failed to add card to board" }, { status: 500 });
  }

  const placed = await insertResponse.json();
  return Response.json(
    { id: cardId, title, columnId: placed.columnId, rank: placed.rank },
    { status: 201 },
  );
}

async function moveCard(request, env, boardId, cardId) {
  const { body, error } = await readJson(request);
  if (error) return error;

  if (typeof body.columnId !== "string" || !COLUMN_ID_RE.test(body.columnId)) {
    return Response.json({ error: "columnId is required" }, { status: 400 });
  }
  if (body.beforeId != null) {
    if (typeof body.beforeId !== "string" || !CARD_ID_RE.test(body.beforeId)) {
      return Response.json({ error: "Invalid beforeId" }, { status: 400 });
    }
  }

  const moveResponse = await boardStub(env, boardId).fetch(
    jsonDoRequest(`/cards/${cardId}/move`, "POST", {
      columnId: body.columnId,
      beforeId: body.beforeId ?? null,
    }),
  );
  if (!moveResponse.ok) return moveResponse;

  const columnResponse = await jobStub(env, cardId).fetch(
    jsonDoRequest("/column", "POST", { boardId, columnId: body.columnId }),
  );
  if (!columnResponse.ok) {
    return Response.json({ error: "Failed to update card column" }, { status: 500 });
  }

  return moveResponse;
}

async function archiveCard(request, env, boardId, cardId) {
  const { body, error } = await readJson(request);
  if (error) return error;
  if (typeof body.archived !== "boolean") {
    return Response.json({ error: "archived boolean is required" }, { status: 400 });
  }

  return jobStub(env, cardId).fetch(
    jsonDoRequest("/archive", "POST", { boardId, archived: body.archived }),
  );
}

async function deleteCard(env, boardId, cardId) {
  const { error } = await assertCardBoard(env, boardId, cardId);
  if (error) return error;

  const boardResponse = await boardStub(env, boardId).fetch(
    new Request(`https://do.internal/cards/${cardId}`, { method: "DELETE" }),
  );
  if (!boardResponse.ok && boardResponse.status !== 404) {
    return Response.json({ error: "Failed to remove card from board" }, { status: 500 });
  }

  const jobResponse = await jobStub(env, cardId).fetch(
    new Request("https://do.internal/destroy", { method: "DELETE" }),
  );
  if (!jobResponse.ok) {
    return Response.json({ error: "Failed to destroy card" }, { status: 500 });
  }

  return Response.json({ ok: true });
}

async function assertCardBoard(env, boardId, cardId) {
  const response = await jobStub(env, cardId).fetch(
    new Request("https://do.internal/snapshot", { method: "GET" }),
  );
  if (!response.ok) {
    return { error: Response.json({ error: "Card not found" }, { status: 404 }) };
  }
  const card = await response.json();
  if (card.boardId !== boardId) {
    return {
      error: Response.json({ error: "Card does not belong to this board" }, { status: 403 }),
    };
  }
  return { card, error: null };
}
