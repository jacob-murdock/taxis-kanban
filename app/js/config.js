/** Shared API paths. Board and catalog sockets are read-only; the card socket is not. */

export const API = {
  catalogWs: `${wsBase()}/api/catalog/ws`,
  boards: "/api/boards",
  board: (boardId) => `/api/boards/${id(boardId)}`,
  boardWs: (boardId) => `${wsBase()}/api/boards/${id(boardId)}/ws`,
  boardSnapshot: (boardId) => `/api/boards/${id(boardId)}/snapshot`,
  columns: (boardId) => `/api/boards/${id(boardId)}/columns`,
  column: (boardId, columnId) => `/api/boards/${id(boardId)}/columns/${id(columnId)}`,
  columnOrder: (boardId) => `/api/boards/${id(boardId)}/columns/order`,
  cards: (boardId) => `/api/boards/${id(boardId)}/cards`,
  card: (boardId, cardId) => `/api/boards/${id(boardId)}/cards/${id(cardId)}`,
  cardWs: (boardId, cardId) => `${wsBase()}/api/boards/${id(boardId)}/cards/${id(cardId)}/ws`,
  cardMove: (boardId, cardId) => `/api/boards/${id(boardId)}/cards/${id(cardId)}/move`,
  cardArchive: (boardId, cardId) => `/api/boards/${id(boardId)}/cards/${id(cardId)}/archive`,
  cardHistory: (boardId, cardId) => `/api/boards/${id(boardId)}/cards/${id(cardId)}/history`,
  cardSnapshot: (boardId, cardId) => `/api/boards/${id(boardId)}/cards/${id(cardId)}/snapshot`,
};

export function readRouteIds() {
  const parts = location.pathname.split("/").filter(Boolean);
  const boardId = parts[0] === "b" ? decodePart(parts[1]) : null;
  const cardId = boardId && parts[2] === "c" ? decodePart(parts[3]) : null;
  return { boardId, cardId };
}

/** False only when the resource is gone. Network errors reject so callers can retry. */
export async function stillExists(url) {
  const response = await fetch(url, { cache: "no-store" });
  return response.status !== 404 && response.status !== 403;
}

export async function requestJson(url, { method = "GET", body } = {}) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function id(value) {
  return encodeURIComponent(value);
}

function wsBase() {
  const { protocol, host } = window.location;
  return protocol === "https:" ? `wss://${host}` : `ws://${host}`;
}

function decodePart(value) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
