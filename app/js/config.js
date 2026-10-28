/** Shared API paths. Board sockets are read-only; the card socket is not.
 * Catalog is HTTP snapshot + focus/mutation refresh (no catalog WebSocket).
 */

export const API = {
  me: "/api/me",
  authRequest: "/api/auth/request",
  authLogout: "/api/auth/logout",
  catalogSnapshot: "/api/catalog/snapshot",
  inviteAccept: "/api/invites/accept",
  boards: "/api/boards",
  board: (boardId) => `/api/boards/${id(boardId)}`,
  boardWs: (boardId) => `${wsBase()}/api/boards/${id(boardId)}/ws`,
  boardSnapshot: (boardId) => `/api/boards/${id(boardId)}/snapshot`,
  boardExport: (boardId) => `/api/boards/${id(boardId)}/export`,
  boardMembers: (boardId) => `/api/boards/${id(boardId)}/members`,
  boardMember: (boardId, email) => `/api/boards/${id(boardId)}/members/${id(email)}`,
  boardInvites: (boardId) => `/api/boards/${id(boardId)}/invites`,
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

const BOARD_ID = /^board_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_ID = /^card_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Post-login path. Only `/`, an invite URL, or a board/card page.
 * Keep in sync with `safeNextPath` in src/lib/auth.js.
 */
export function safeNextPath(raw) {
  if (typeof raw !== "string") return "/";
  const next = raw.trim();
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  if (/[\u0000-\u001F\u007F\\]/.test(next)) return "/";

  let url;
  try {
    url = new URL(next, "https://taxis.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://taxis.local" || url.username || url.password) return "/";

  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") return "/";

  if (path === "/invite") {
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== "token")) return "/";
    const token = (url.searchParams.get("token") || "").toLowerCase();
    if (!token) return "/invite";
    if (!/^[0-9a-f]{64}$/.test(token)) return "/";
    return `/invite?token=${token}`;
  }

  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "b") return "/";
  if (parts.length === 2 && BOARD_ID.test(parts[1])) return `/b/${parts[1]}`;
  if (parts.length === 4 && parts[2] === "c" && BOARD_ID.test(parts[1]) && CARD_ID.test(parts[3])) {
    return `/b/${parts[1]}/c/${parts[3]}`;
  }
  return "/";
}

/** False only when the resource is gone. Network errors reject so callers can retry. */
export async function stillExists(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (response.status === 401) {
    redirectToSignIn();
    return false;
  }
  return response.status !== 404 && response.status !== 403;
}

export async function requestJson(url, { method = "GET", body } = {}) {
  const options = { method, credentials: "same-origin" };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (response.status === 401 && url !== API.me && url !== API.authRequest) {
    redirectToSignIn();
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function redirectToSignIn() {
  if (location.pathname === "/") return;
  const next = safeNextPath(`${location.pathname}${location.search}`);
  location.replace(next === "/" ? "/" : `/?next=${encodeURIComponent(next)}`);
}

/** After a revoked socket: reload when the caller still belongs, otherwise go home. */
export async function settleRevokedAccess(snapshotUrl) {
  try {
    await requestJson(snapshotUrl);
  } catch (err) {
    if (err.status === 401) return true;
    if (err.status === 403 || err.status === 404) {
      location.assign("/");
      return true;
    }
    return false;
  }
  location.reload();
  return true;
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
