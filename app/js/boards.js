/** Board list. Catalog is a filtered HTTP snapshot; refresh on focus and after mutations. */

import { API, requestJson, safeNextPath } from "./config.js";
import { setStatus } from "./yjs-sync.js";

const NAME_MAX = 80;

const statusEl = document.getElementById("connection-status");
const listEl = document.getElementById("board-list");
const form = document.getElementById("create-board-form");
const nameInput = document.getElementById("new-board-name");
const showArchivedEl = document.getElementById("show-archived");
const archivedToggle = showArchivedEl?.closest(".show-archived");
const errorEl = document.getElementById("page-error");

let boards = [];
let signedIn = false;
let rendering = false;
let editingId = null;
const pendingBoards = new Map();

function oneLine(value, max) {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function setError(message) {
  errorEl.textContent = message || "";
}

function visibleBoards() {
  const list = boards.map((board) => ({ ...board }));
  for (const board of list) pendingBoards.delete(board.id);
  for (const board of pendingBoards.values()) {
    if (!list.some((item) => item.id === board.id)) list.push(board);
  }
  list.sort((a, b) => {
    const byTime = String(b.createdAt).localeCompare(String(a.createdAt));
    if (byTime) return byTime;
    return a.id.localeCompare(b.id);
  });
  return list.filter((board) => showArchivedEl.checked || !board.archived);
}

function render() {
  rendering = true;
  const draftInput = editingId
    ? listEl.querySelector(`[data-board-id="${CSS.escape(editingId)}"] input`)
    : null;
  const draft = draftInput ? draftInput.value : null;
  const refocus = Boolean(draftInput && document.activeElement === draftInput);
  const selectionStart = draftInput?.selectionStart ?? null;
  const selectionEnd = draftInput?.selectionEnd ?? null;

  const visible = visibleBoards();
  listEl.replaceChildren();

  if (!signedIn) {
    const empty = document.createElement("li");
    empty.className = "placeholder";
    empty.textContent = "Sign in to see your boards.";
    listEl.append(empty);
    rendering = false;
    return;
  }

  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "placeholder";
    empty.textContent = showArchivedEl.checked ? "No boards." : "No boards yet.";
    listEl.append(empty);
    rendering = false;
    return;
  }

  for (const board of visible) {
    const value = board.id === editingId ? (draft ?? board.name) : null;
    listEl.append(buildRow(board, value));
  }

  if (refocus && editingId) {
    const input = listEl.querySelector(`[data-board-id="${CSS.escape(editingId)}"] input`);
    if (input) {
      input.focus();
      const start = selectionStart ?? input.value.length;
      input.setSelectionRange(start, selectionEnd ?? start);
    }
  }

  rendering = false;
}

function buildRow(board, draft) {
  const li = document.createElement("li");
  li.dataset.boardId = board.id;
  if (board.archived) li.classList.add("is-archived");
  const isOwner = board.role === "owner";

  if (draft != null) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = draft;
    input.maxLength = NAME_MAX;
    input.autocomplete = "off";
    input.setAttribute("aria-label", `Rename ${board.name || "board"}`);
    li.append(input);
  } else {
    const link = document.createElement("a");
    link.href = `/b/${encodeURIComponent(board.id)}`;
    link.textContent = board.name || "Untitled board";
    li.append(link);
    if (board.archived) {
      const tag = document.createElement("span");
      tag.className = "muted";
      tag.textContent = "Archived";
      li.append(tag);
    }
    if (isOwner) {
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "btn";
      rename.dataset.action = "rename";
      rename.textContent = "Rename";
      rename.setAttribute("aria-label", `Rename ${board.name || "board"}`);
      li.append(rename);
    }
  }

  if (isOwner || draft != null) {
    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = "btn";
    archive.dataset.action = "archive";
    archive.textContent = board.archived ? "Restore" : "Archive";
    archive.setAttribute(
      "aria-label",
      `${board.archived ? "Restore" : "Archive"} ${board.name || "board"}`,
    );
    li.append(archive);
  }
  return li;
}

function startRename(boardId) {
  editingId = boardId;
  render();
  const input = listEl.querySelector(`[data-board-id="${CSS.escape(boardId)}"] input`);
  input?.focus();
  input?.select();
}

async function commitRename(boardId, raw) {
  const current = boards.find((board) => board.id === boardId) ?? pendingBoards.get(boardId);
  const wasEditing = editingId === boardId;
  if (wasEditing) editingId = null;
  const name = oneLine(raw, NAME_MAX);
  if (wasEditing) render();
  if (!current || !name || name === current.name) return;

  setError("");
  try {
    await requestJson(API.board(boardId), { method: "PATCH", body: { name } });
    await refreshCatalog();
  } catch (err) {
    setError(err.message);
  }
}

async function toggleArchive(boardId) {
  const board = boards.find((item) => item.id === boardId) ?? pendingBoards.get(boardId);
  if (!board) return;
  setError("");
  try {
    await requestJson(API.board(boardId), {
      method: "PATCH",
      body: { archived: !board.archived },
    });
    await refreshCatalog();
  } catch (err) {
    setError(err.message);
  }
}

async function refreshCatalog() {
  if (!signedIn) return;
  const data = await requestJson(API.catalogSnapshot);
  boards = Array.isArray(data.boards) ? data.boards : [];
  render();
}

listEl.addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) event.preventDefault();
});

listEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || !listEl.contains(button)) return;
  const boardId = button.closest("[data-board-id]")?.dataset.boardId;
  if (!boardId) return;

  void (async () => {
    if (editingId && editingId !== boardId) {
      const input = listEl.querySelector(`[data-board-id="${CSS.escape(editingId)}"] input`);
      if (input) await commitRename(editingId, input.value);
    }

    if (button.dataset.action === "rename") {
      startRename(boardId);
      return;
    }

    if (button.dataset.action === "archive") {
      const input = listEl.querySelector(`[data-board-id="${CSS.escape(boardId)}"] input`);
      if (input && editingId === boardId) await commitRename(boardId, input.value);
      await toggleArchive(boardId);
    }
  })();
});

listEl.addEventListener("focusout", (event) => {
  if (rendering) return;
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const boardId = input.closest("[data-board-id]")?.dataset.boardId;
  if (!boardId || editingId !== boardId) return;
  void commitRename(boardId, input.value);
});

listEl.addEventListener("keydown", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const boardId = input.closest("[data-board-id]")?.dataset.boardId;
  if (!boardId) return;
  if (event.key === "Escape") {
    event.preventDefault();
    editingId = null;
    render();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void commitRename(boardId, input.value);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!signedIn) return;
  const name = oneLine(nameInput.value, NAME_MAX);
  if (!name) {
    nameInput.value = "";
    return;
  }

  const button = form.querySelector("button");
  button.disabled = true;
  setError("");
  try {
    const created = await requestJson(API.boards, { method: "POST", body: { name } });
    nameInput.value = "";
    pendingBoards.set(created.id, {
      id: created.id,
      name: created.name || name,
      archived: false,
      createdAt: new Date().toISOString(),
      role: created.role || "owner",
    });
    render();
    await refreshCatalog();
    nameInput.focus();
  } catch (err) {
    setError(err.message);
  } finally {
    button.disabled = false;
  }
});

showArchivedEl.addEventListener("change", () => {
  if (signedIn) render();
});

window.addEventListener("focus", () => {
  if (signedIn) void refreshCatalog().catch((err) => setError(err.message));
});

function setListChrome(signedInNow) {
  form.hidden = !signedInNow;
  if (archivedToggle) archivedToggle.hidden = !signedInNow;
}

function consumeNext() {
  const next = safeNextPath(new URLSearchParams(location.search).get("next"));
  if (next === "/") return false;
  location.replace(next);
  return true;
}

async function bootstrap() {
  setListChrome(false);
  setStatus(statusEl, "connecting", "Checking session…");

  try {
    await requestJson(API.me);
  } catch (err) {
    signedIn = false;
    setStatus(statusEl, "error", "Sign in to continue");
    render();
    if (err.status !== 401) setError(err.message);
    return;
  }

  signedIn = true;
  if (consumeNext()) return;
  setListChrome(true);
  try {
    await refreshCatalog();
    setStatus(statusEl, "connected", "Signed in");
  } catch (err) {
    setStatus(statusEl, "error", "Could not load boards");
    setError(err.message);
    render();
  }
}

bootstrap();
