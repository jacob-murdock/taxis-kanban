/** Board list. The catalog socket is read-only; create, rename, and archive go over HTTP. */

import { API, requestJson } from "./config.js";
import { connectYjsRoom } from "./yjs-sync.js";

const NAME_MAX = 80;

const statusEl = document.getElementById("connection-status");
const listEl = document.getElementById("board-list");
const form = document.getElementById("create-board-form");
const nameInput = document.getElementById("new-board-name");
const showArchivedEl = document.getElementById("show-archived");
const errorEl = document.getElementById("page-error");

let doc = null;
let rendering = false;
let editingId = null;
const pendingBoards = new Map();

function oneLine(value, max) {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function setError(message) {
  errorEl.textContent = message || "";
}

function readBoards() {
  if (!doc) return [];
  const boards = [];
  doc.getMap("boards").forEach((value) => {
    if (!value || typeof value.get !== "function") return;
    boards.push({
      id: String(value.get("id") ?? ""),
      name: String(value.get("name") ?? ""),
      archived: value.get("archived") === true,
      createdAt: value.get("createdAt") ?? "",
    });
  });
  return boards;
}

function visibleBoards() {
  const boards = readBoards();
  for (const board of boards) pendingBoards.delete(board.id);
  for (const board of pendingBoards.values()) {
    if (!boards.some((item) => item.id === board.id)) boards.push(board);
  }
  boards.sort((a, b) => {
    const byTime = String(b.createdAt).localeCompare(String(a.createdAt));
    if (byTime) return byTime;
    return a.id.localeCompare(b.id);
  });
  return boards.filter((board) => showArchivedEl.checked || !board.archived);
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

  const boards = visibleBoards();
  listEl.replaceChildren();

  if (!boards.length) {
    const empty = document.createElement("li");
    empty.className = "placeholder";
    empty.textContent = showArchivedEl.checked ? "No boards." : "No boards yet.";
    listEl.append(empty);
    rendering = false;
    return;
  }

  for (const board of boards) {
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

  if (draft != null) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = draft;
    input.maxLength = NAME_MAX;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Board name");
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
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "btn";
    rename.dataset.action = "rename";
    rename.textContent = "Rename";
    li.append(rename);
  }

  const archive = document.createElement("button");
  archive.type = "button";
  archive.className = "btn";
  archive.dataset.action = "archive";
  archive.textContent = board.archived ? "Restore" : "Archive";
  li.append(archive);
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
  const current = readBoards().find((board) => board.id === boardId) ?? pendingBoards.get(boardId);
  const wasEditing = editingId === boardId;
  if (wasEditing) editingId = null;
  const name = oneLine(raw, NAME_MAX);
  if (wasEditing) render();
  if (!current || !name || name === current.name) return;

  setError("");
  try {
    await requestJson(API.board(boardId), { method: "PATCH", body: { name } });
  } catch (err) {
    setError(err.message);
  }
}

async function toggleArchive(boardId) {
  const board = readBoards().find((item) => item.id === boardId) ?? pendingBoards.get(boardId);
  if (!board) return;
  setError("");
  try {
    await requestJson(API.board(boardId), {
      method: "PATCH",
      body: { archived: !board.archived },
    });
  } catch (err) {
    setError(err.message);
  }
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
    });
    render();
    nameInput.focus();
  } catch (err) {
    setError(err.message);
  } finally {
    button.disabled = false;
  }
});

showArchivedEl.addEventListener("change", () => {
  if (doc) render();
});

async function bootstrap() {
  const room = connectYjsRoom(API.catalogWs);
  room.bindStatus(statusEl);

  doc = await room.ready;
  if (!doc) return;
  render();
  doc.on("update", () => {
    if (!rendering) render();
  });
}

bootstrap();
