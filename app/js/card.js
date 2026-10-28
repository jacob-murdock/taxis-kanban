/** Card page. Field edits go out on the card socket. Column, archive, and delete use HTTP. */

import { API, readRouteIds, requestJson, settleRevokedAccess, stillExists } from "./config.js";
import { readCard } from "./card-model.js";
import { bindPresence } from "./presence.js";
import { connectYjsRoom, setStatus } from "./yjs-sync.js";

const TITLE_MAX = 200;
const ASSIGNEE_MAX = 80;
const LABEL_MAX = 30;
const LABEL_MAX_COUNT = 20;

const { boardId, cardId } = readRouteIds();

const statusEl = document.getElementById("connection-status");
const presenceEl = document.getElementById("presence");
const backLink = document.getElementById("back-link");
const titleEl = document.getElementById("card-title");
const metaEl = document.getElementById("card-meta");
const errorEl = document.getElementById("page-error");
const fieldColumn = document.getElementById("field-column");
const fieldAssignee = document.getElementById("field-assignee");
const fieldDue = document.getElementById("field-due");
const fieldBody = document.getElementById("card-body");
const labelList = document.getElementById("label-list");
const labelForm = document.getElementById("label-form");
const labelInput = document.getElementById("field-label");
const archiveBtn = document.getElementById("archive-btn");
const deleteBtn = document.getElementById("delete-btn");
const historyList = document.getElementById("history-list");

let doc = null;
let gone = false;
let syncing = false;
let pendingColumnId = null;
let historyTimer = null;
let columns = [];
let columnSignature = "";
let fillingColumn = false;
let myRole = null;
let myEmail = null;
let presence = null;
let room = null;
const focused = new Set();

function canEditCard() {
  return myRole === "owner" || myRole === "editor";
}

function oneLine(value, max) {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function setError(message) {
  errorEl.textContent = message || "";
}

function releaseLive() {
  presence?.destroy();
  presence = null;
  const current = room;
  room = null;
  current?.disconnect();
}

function showDeleted() {
  gone = true;
  releaseLive();
  titleEl.textContent = "Card deleted";
  setStatus(statusEl, "error", "This card was deleted");
}

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  releaseLive();
});

function setField(key, value) {
  if (!canEditCard()) return;
  const fields = doc?.getMap("fields");
  if (!fields || gone || fields.get(key) === value) return;
  doc.transact(() => fields.set(key, value));
}

function applyViewOnly() {
  const editable = canEditCard();
  document.body.classList.toggle("view-only", !editable);
  if (editable) titleEl.setAttribute("contenteditable", "plaintext-only");
  else titleEl.removeAttribute("contenteditable");
  fieldColumn.disabled = !editable;
  fieldAssignee.disabled = !editable;
  fieldDue.disabled = !editable;
  fieldBody.readOnly = !editable;
  labelForm.hidden = !editable;
  archiveBtn.hidden = !editable;
  deleteBtn.hidden = !editable;
}

async function bootstrap() {
  applyViewOnly();
  if (boardId) backLink.href = `/b/${encodeURIComponent(boardId)}`;
  try {
    const me = await requestJson(API.me);
    myEmail = me.email || null;
  } catch (err) {
    if (err.status === 401) return;
  }
  if (!boardId || !cardId) {
    titleEl.textContent = "Card not found";
    setStatus(statusEl, "error", "Missing card");
    return;
  }

  try {
    const snapshot = await requestJson(API.cardSnapshot(boardId, cardId));
    myRole = snapshot.role || null;
    applyViewOnly();
  } catch (err) {
    if (err.status === 404 || err.status === 403) {
      titleEl.textContent = "Card not found";
      setStatus(statusEl, "error", err.message);
      return;
    }
    setError(err.message);
  }

  wireEditors();
  void loadHistory();
  void loadColumns();

  room = connectYjsRoom(API.cardWs(boardId, cardId), {
    writable: canEditCard(),
    user: myEmail ? { email: myEmail } : null,
    stillThere: () => stillExists(API.cardSnapshot(boardId, cardId)),
    onMissing: showDeleted,
    onClose(event) {
      if (event.code === 4403) {
        setStatus(statusEl, "error", "Checking access…");
        void settleRevokedAccess(API.cardSnapshot(boardId, cardId)).then((ok) => {
          if (ok === false) setError("Could not confirm access. Refresh to continue.");
        });
        return true;
      }
      if (event.reason !== "deleted") return false;
      showDeleted();
      return true;
    },
  });
  room.bindStatus(statusEl);
  presence = bindPresence(presenceEl, room.awareness, { selfEmail: myEmail });

  doc = await room.ready;
  if (!doc) return;
  renderFromDoc();
  doc.on("update", (_update, origin) => {
    renderFromDoc();
    // Local keystrokes do not echo back; refresh after commits instead.
    if (origin === "remote") scheduleHistoryRefresh();
  });
}

async function loadColumns() {
  try {
    const board = await requestJson(API.boardSnapshot(boardId));
    columns = Array.isArray(board.columns) ? board.columns : [];
    if (doc) fillColumnSelect(selectedColumnId());
  } catch (err) {
    setError(err.message);
  }
}

function selectedColumnId() {
  if (!doc) return null;
  const current = readCard(doc).columnId;
  if (pendingColumnId && pendingColumnId !== current) return pendingColumnId;
  pendingColumnId = null;
  return current;
}

function fillColumnSelect(selectedId, { force = false } = {}) {
  if (!force && document.activeElement === fieldColumn) return;
  const signature = columns.map((column) => `${column.id}:${column.name}`).join("|");
  const value = selectedId ?? "";
  if (signature === columnSignature && fieldColumn.value === value) return;

  fillingColumn = true;
  fieldColumn.replaceChildren();
  for (const column of columns) {
    const option = document.createElement("option");
    option.value = column.id;
    option.textContent = column.name || "Untitled";
    fieldColumn.append(option);
  }
  if (value && ![...fieldColumn.options].some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = "Unknown column";
    fieldColumn.append(option);
  }
  if (value) fieldColumn.value = value;
  fillingColumn = false;
  columnSignature = signature;
}

function renderFromDoc() {
  if (!doc || gone) return;
  syncing = true;
  const card = readCard(doc);

  if (!focused.has("title") && titleEl.textContent !== card.title) {
    titleEl.textContent = card.title;
  }
  const meta = [card.archived ? "Archived" : "", card.id].filter(Boolean).join(" · ");
  if (metaEl.textContent !== meta) metaEl.textContent = meta;
  document.title = `${card.title} · Taxis Kanban`;

  fillColumnSelect(selectedColumnId());

  if (!focused.has("assignee") && fieldAssignee.value !== card.assignee) {
    fieldAssignee.value = card.assignee;
  }
  const due = typeof card.due === "string" ? card.due : "";
  if (!focused.has("due") && fieldDue.value !== due) fieldDue.value = due;
  if (fieldBody.value !== card.body) {
    if (focused.has("body")) {
      const prev = fieldBody.value;
      const selStart = fieldBody.selectionStart;
      const selEnd = fieldBody.selectionEnd;
      fieldBody.value = card.body;
      fieldBody.setSelectionRange(
        mapIndexThroughTextDiff(selStart, prev, card.body),
        mapIndexThroughTextDiff(selEnd, prev, card.body),
      );
    } else {
      fieldBody.value = card.body;
    }
  }

  renderLabels(card.labels);
  archiveBtn.textContent = card.archived ? "Restore" : "Archive";
  syncing = false;
}

function renderLabels(labels) {
  labelList.replaceChildren();
  labels.forEach((label, index) => {
    const li = document.createElement("li");
    li.className = "label-chip";
    const text = document.createElement("span");
    text.textContent = label;
    li.append(text);
    if (canEditCard()) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.labelIndex = String(index);
      remove.setAttribute("aria-label", `Remove ${label}`);
      remove.textContent = "×";
      li.append(remove);
    }
    labelList.append(li);
  });
}

function wireEditors() {
  trackFocus(titleEl, "title");
  trackFocus(fieldColumn, "column");
  trackFocus(fieldAssignee, "assignee");
  trackFocus(fieldDue, "due");
  trackFocus(fieldBody, "body");
  trackFocus(labelInput, "label");

  titleEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      titleEl.blur();
    }
  });

  titleEl.addEventListener("blur", () => {
    if (!canEditCard() || !doc || syncing || gone) return;
    setField("title", oneLine(titleEl.textContent ?? "", TITLE_MAX) || "Untitled");
    scheduleHistoryRefresh();
  });

  fieldColumn.addEventListener("change", () => {
    if (!canEditCard() || !doc || syncing || gone || fillingColumn) return;
    const columnId = fieldColumn.value;
    const current = readCard(doc).columnId;
    if (!columnId || columnId === current) return;
    pendingColumnId = columnId;
    setError("");
    void requestJson(API.cardMove(boardId, cardId), {
      method: "POST",
      body: { columnId },
    })
      .then(() => scheduleHistoryRefresh())
      .catch((err) => {
        pendingColumnId = null;
        columnSignature = "";
        setError(err.message);
        fillColumnSelect(current, { force: true });
      });
  });

  fieldAssignee.addEventListener("change", () => {
    if (!canEditCard() || !doc || syncing || gone) return;
    setField("assignee", oneLine(fieldAssignee.value, ASSIGNEE_MAX));
    scheduleHistoryRefresh();
  });

  fieldDue.addEventListener("change", () => {
    if (!canEditCard() || !doc || syncing || gone) return;
    setField("due", fieldDue.value || null);
    scheduleHistoryRefresh();
  });

  fieldBody.addEventListener("input", () => {
    if (!canEditCard() || !doc || gone) return;
    applyTextDiff(doc.getText("body"), fieldBody.value);
  });

  fieldBody.addEventListener("blur", () => {
    if (!canEditCard() || !doc || gone) return;
    scheduleHistoryRefresh();
  });

  labelForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!canEditCard() || !doc || gone) return;
    const label = oneLine(labelInput.value, LABEL_MAX);
    labelInput.value = "";
    if (!label) return;
    const labels = doc.getArray("labels");
    if (labels.toArray().includes(label)) return;
    if (labels.length >= LABEL_MAX_COUNT) {
      setError("A card can have at most 20 labels.");
      return;
    }
    setError("");
    doc.transact(() => labels.push([label]));
    scheduleHistoryRefresh();
  });

  labelList.addEventListener("click", (event) => {
    if (!canEditCard()) return;
    const button = event.target.closest("[data-label-index]");
    if (!button || !doc || gone) return;
    const index = Number(button.dataset.labelIndex);
    const labels = doc.getArray("labels");
    if (!Number.isInteger(index) || index < 0 || index >= labels.length) return;
    doc.transact(() => labels.delete(index, 1));
    scheduleHistoryRefresh();
  });

  archiveBtn.addEventListener("click", async () => {
    if (!canEditCard() || !doc || gone) return;
    const archived = !readCard(doc).archived;
    archiveBtn.disabled = true;
    setError("");
    try {
      await requestJson(API.cardArchive(boardId, cardId), {
        method: "POST",
        body: { archived },
      });
      scheduleHistoryRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      archiveBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener("click", async () => {
    if (!canEditCard() || !doc || gone) return;
    if (!window.confirm("Delete this card?")) return;
    deleteBtn.disabled = true;
    setError("");
    try {
      await requestJson(API.card(boardId, cardId), { method: "DELETE" });
      location.assign(`/b/${encodeURIComponent(boardId)}`);
    } catch (err) {
      setError(err.message);
      deleteBtn.disabled = false;
    }
  });
}

function trackFocus(el, key) {
  el.addEventListener("focus", () => {
    focused.add(key);
    presence?.setEditing(key);
  });
  el.addEventListener("blur", () => {
    focused.delete(key);
    // Prefer another still-focused field if focus moved within the card.
    const next = focused.values().next().value || null;
    presence?.setEditing(next);
  });
}

/**
 * Common prefix / changed-span bounds for a string rewrite of `prev` → `next`.
 * Same region `applyTextDiff` mutates on Y.Text.
 */
function textDiffBounds(prev, next) {
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev[start] === next[start]) start++;

  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  return { start, endPrev, endNext };
}

/** Map a caret/selection index through a `prev` → `next` rewrite, then clamp. */
function mapIndexThroughTextDiff(index, prev, next) {
  const { start, endPrev, endNext } = textDiffBounds(prev, next);
  let mapped;
  if (index <= start) mapped = index;
  else if (index >= endPrev) mapped = index + (endNext - endPrev);
  else mapped = endNext;
  return Math.max(0, Math.min(mapped, next.length));
}

/**
 * Apply only the changed region of `next` to a Y.Text, instead of replacing
 * the whole document. This keeps untouched regions intact so concurrent edits
 * from other collaborators merge cleanly (and don't reset their cursors).
 */
function applyTextDiff(ytext, next) {
  const prev = ytext.toString();
  if (prev === next) return;

  const { start, endPrev, endNext } = textDiffBounds(prev, next);
  ytext.doc.transact(() => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  });
}

/** Wait past JobDO's 400ms changelog debounce before refetching. */
const HISTORY_REFRESH_MS = 800;

function scheduleHistoryRefresh() {
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = null;
    void loadHistory();
  }, HISTORY_REFRESH_MS);
}

async function loadHistory() {
  try {
    const { entries } = await requestJson(API.cardHistory(boardId, cardId));
    renderHistory(entries ?? []);
  } catch {
    // History is best-effort; the page works without it.
  }
}

function renderHistory(entries) {
  historyList.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "placeholder";
    empty.textContent = "No changes recorded yet.";
    historyList.append(empty);
    return;
  }

  for (const entry of entries) {
    const li = document.createElement("li");
    const author = entry.author ? `${entry.author} · ` : "";
    li.textContent = `${entry.ts} — ${author}${entry.field}: ${entry.prev ?? "∅"} → ${entry.next ?? "∅"}`;
    historyList.append(li);
  }
}

window.addEventListener("focus", () => {
  if (!boardId || !doc || gone) return;
  void loadColumns();
  void loadHistory();
});

bootstrap();
