/** Board view. Columns come from the board document. The socket is read-only;
 * every change is an HTTP request, and the next server update redraws the board.
 */

import { announce } from "./announce.js";
import { planCardNudge, planMoveToColumn } from "./card-nudge.js";
import { describeBoardChanges } from "./change-summary.js";
import { API, readRouteIds, requestJson, settleRevokedAccess, stillExists } from "./config.js";
import { COLUMN_TITLE_HINT, BOARD_TITLE_HINT, setTitleEditing } from "./editable-title.js";
import { rememberSession } from "./local-session.js";
import { bindPresence } from "./presence.js";
import { connectYjsRoom, setStatus } from "./yjs-sync.js";

const NAME_MAX = 80;
const TITLE_MAX = 200;

const { boardId } = readRouteIds();

const statusEl = document.getElementById("connection-status");
const presenceEl = document.getElementById("presence");
const boardEl = document.getElementById("board");
const boardNameEl = document.getElementById("board-name");
const archivedBanner = document.getElementById("archived-banner");
const unarchiveBtn = document.getElementById("unarchive-btn");
const archivedStrip = document.getElementById("archived-strip");
const archivedList = document.getElementById("archived-list");
const addColumnForm = document.getElementById("add-column-form");
const newColumnInput = document.getElementById("new-column-name");
const errorEl = document.getElementById("page-error");
const boardAccessEl = document.getElementById("board-access");
const boardRoleEl = document.getElementById("board-role");
const leaveBoardBtn = document.getElementById("leave-board-btn");
const exportBoardBtn = document.getElementById("export-board-btn");
const membersPanel = document.getElementById("members-panel");
const membersList = document.getElementById("members-list");
const inviteForm = document.getElementById("invite-form");
const inviteRoleEl = document.getElementById("invite-role");
const inviteLinkRow = document.getElementById("invite-link-row");
const inviteLinkEl = document.getElementById("invite-link");
const copyInviteBtn = document.getElementById("copy-invite-btn");
const boardKeysEl = document.getElementById("board-keys");

let doc = null;
let missing = false;
let rendering = false;
let renderPending = false;
let dragCardId = null;
let suppressClick = false;
let renderedBoard = null;
let openMenu = null;
let moveQueue = Promise.resolve();
let focusAfterRender = null;
const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const COLUMN_ACTIONS = new Set(["move-left", "move-right", "delete-column"]);
let myRole = null;
let myEmail = null;
let room = null;
let presence = null;
const adding = new Set();

function canEditBoard() {
  return myRole === "owner" || myRole === "editor";
}

function isOwner() {
  return myRole === "owner";
}

function oneLine(value, max) {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function spoken(value, fallback) {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

function setBoardKeys(on) {
  if (boardKeysEl) boardKeysEl.hidden = !on;
  if (on) boardEl.setAttribute("aria-describedby", "board-keys");
  else boardEl.removeAttribute("aria-describedby");
}

function setError(message) {
  errorEl.textContent = message || "";
}

function readBoard(source) {
  const meta = source.getMap("meta");
  const columns = source
    .getArray("columns")
    .toArray()
    .filter(Boolean)
    .map((column) => ({
      id: String(column.id ?? ""),
      name: String(column.name ?? ""),
    }))
    .filter((column) => column.id);

  const cards = [];
  source.getMap("cards").forEach((value, key) => {
    if (!value || typeof value.get !== "function") return;
    cards.push({
      id: String(value.get("id") ?? key),
      title: String(value.get("title") ?? ""),
      columnId: value.get("columnId") ?? null,
      rank: Number(value.get("rank")) || 0,
      due: value.get("due") ?? null,
      assignee: String(value.get("assignee") ?? ""),
      labels: readLabels(value.get("labels")),
      archived: value.get("archived") === true,
    });
  });

  return {
    name: String(meta.get("name") ?? ""),
    archived: meta.get("archived") === true,
    columns,
    cards,
  };
}

function readLabels(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value.toArray === "function") return value.toArray().map(String);
  return [];
}

function compareCards(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.id.localeCompare(b.id);
}

function columnCards(cards, columnId) {
  return cards.filter((card) => card.columnId === columnId && !card.archived).sort(compareCards);
}

function cardHref(cardId) {
  return `/b/${encodeURIComponent(boardId)}/c/${encodeURIComponent(cardId)}`;
}

function renderFromDoc() {
  if (!doc || missing) return;
  // Replacing the dragged card detaches it, so dragend never reaches us and
  // clicks stay suppressed. An open Move menu would close the same way.
  // Hold the redraw until that gesture finishes.
  if (dragCardId || openMenu || rendering) {
    renderPending = true;
    return;
  }
  rendering = true;
  renderPending = false;
  const ui = captureUi();
  const board = readBoard(doc);
  if (renderedBoard) {
    for (const note of describeBoardChanges(renderedBoard, board)) announce(note);
  }
  renderedBoard = board;

  if (document.activeElement !== boardNameEl) {
    boardNameEl.textContent = board.name || "Untitled board";
  }
  document.title = `${board.name || "Board"} · Taxis Kanban`;
  archivedBanner.hidden = !board.archived;

  boardEl.replaceChildren(
    ...board.columns.map((column, index) =>
      renderColumn(column, columnCards(board.cards, column.id), index, board.columns.length),
    ),
  );
  renderArchived(board.cards.filter((card) => card.archived).sort(compareCards));
  restoreUi(ui);
  rendering = false;
  if (renderPending) renderFromDoc();
}

function renderColumn(column, cards, index, count) {
  const section = document.createElement("section");
  section.className = "board-column";
  section.dataset.columnId = column.id;
  const editable = canEditBoard();

  const head = document.createElement("div");
  head.className = "column-head";

  const columnName = spoken(column.name, "Untitled column");
  const heading = document.createElement("h2");
  heading.id = `column-title-${column.id}`;
  heading.dataset.columnName = "";
  heading.textContent = column.name;
  head.append(heading);
  setTitleEditing(heading, editable, COLUMN_TITLE_HINT);
  if (editable) {
    const actions = document.createElement("div");
    actions.className = "column-actions";
    actions.append(
      iconButton("move-left", `Move ${columnName} left`, "←", index === 0),
      iconButton("move-right", `Move ${columnName} right`, "→", index === count - 1),
      iconButton("delete-column", `Delete ${columnName}`, "✕", false),
    );
    head.append(actions);
  }

  const list = document.createElement("ul");
  list.className = "card-list";
  list.setAttribute("aria-labelledby", heading.id);
  cards.forEach((card, cardIndex) => {
    list.append(buildCardEl(card, { index: cardIndex, count: cards.length, columnName }));
  });

  section.append(head, list);

  if (editable) {
    const form = document.createElement("form");
    form.className = "composer";
    form.dataset.composer = "";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = TITLE_MAX;
    input.dataset.composerInput = "";
    input.autocomplete = "off";
    const field = document.createElement("label");
    field.className = "field-label";
    field.append(document.createTextNode("Card title"));
    const where = document.createElement("span");
    where.className = "visually-hidden";
    where.textContent = ` in ${columnName}`;
    field.append(where, input);
    const add = document.createElement("button");
    add.type = "submit";
    add.className = "btn";
    add.textContent = "Add";
    add.setAttribute("aria-label", `Add a card to ${columnName}`);
    form.append(field, add);
    section.append(form);
  }

  return section;
}

function buildCardEl(card, { archived = false, index = 0, count = 1, columnName = "" } = {}) {
  const li = document.createElement("li");
  li.dataset.cardId = card.id;
  li.draggable = canEditBoard() && !archived;

  const link = document.createElement("a");
  link.href = cardHref(card.id);
  link.draggable = false;
  link.dataset.cardLink = "";
  link.append(document.createTextNode(card.title || "Untitled"));
  const place = document.createElement("span");
  place.className = "visually-hidden";
  const where = `${index + 1} of ${count} in ${columnName || "this column"}`;
  const movable = canEditBoard() && !archived;
  place.textContent = movable ? `, ${where}. Arrow keys move this card.` : `, ${where}.`;
  link.append(place);
  li.append(link);

  const meta = [card.assignee, card.due].filter(Boolean).join(" · ");
  if (meta) {
    const small = document.createElement("small");
    small.textContent = meta;
    li.append(small);
  }

  if (card.labels.length) {
    const chips = document.createElement("ul");
    chips.className = "card-labels";
    for (const label of card.labels) {
      const chip = document.createElement("li");
      chip.className = "label-chip";
      chip.textContent = label;
      chips.append(chip);
    }
    li.append(chips);
  }

  if (archived && canEditBoard()) {
    const actions = document.createElement("div");
    actions.className = "card-quick";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "btn";
    restore.dataset.action = "restore";
    restore.dataset.cardId = card.id;
    restore.textContent = "Restore";
    restore.setAttribute("aria-label", `Restore ${card.title || "Untitled"}`);
    actions.append(restore);
    li.append(actions);
  } else if (canEditBoard()) {
    const actions = document.createElement("div");
    actions.className = "card-quick";
    const name = card.title || "Untitled";
    const move = document.createElement("button");
    move.type = "button";
    move.className = "btn";
    move.dataset.action = "move-menu";
    move.dataset.cardId = card.id;
    move.setAttribute("aria-haspopup", "menu");
    move.setAttribute("aria-expanded", "false");
    move.setAttribute("aria-label", `Move ${name}`);
    move.textContent = "Move";
    move.addEventListener("pointerdown", () => holdCardStill(li));
    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = "btn";
    archive.dataset.action = "archive-card";
    archive.dataset.cardId = card.id;
    archive.textContent = "Archive";
    archive.setAttribute("aria-label", `Archive ${name}`);
    archive.addEventListener("pointerdown", () => holdCardStill(li));
    actions.append(move, archive);
    li.append(actions);
  }

  return li;
}

/** A press on a control inside a draggable card should not start a drag. */
function holdCardStill(cardEl) {
  if (!cardEl) return;
  cardEl.draggable = false;
  const release = () => {
    if (cardEl.isConnected && canEditBoard()) cardEl.draggable = true;
    document.removeEventListener("pointerup", release);
    document.removeEventListener("pointercancel", release);
  };
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
}

function renderArchived(cards) {
  archivedStrip.hidden = cards.length === 0;
  archivedList.replaceChildren(
    ...cards.map((card, index) =>
      buildCardEl(card, {
        archived: true,
        index,
        count: cards.length,
        columnName: "Archived",
      }),
    ),
  );
}

function captureUi() {
  const active = document.activeElement;
  const composer = new Map();
  for (const input of boardEl.querySelectorAll("[data-composer-input]")) {
    const columnId = input.closest("[data-column-id]")?.dataset.columnId;
    if (!columnId) continue;
    if (!input.value && active !== input) continue;
    composer.set(columnId, {
      value: input.value,
      focus: active === input,
      start: input.selectionStart,
      end: input.selectionEnd,
    });
  }

  let columnName = null;
  if (active?.matches?.("[data-column-name]") && boardEl.contains(active)) {
    columnName = {
      id: active.closest("[data-column-id]")?.dataset.columnId,
      value: active.textContent ?? "",
      offset: caretOffset(active),
    };
  }

  let columnAction = null;
  if (active?.matches?.("[data-action]") && COLUMN_ACTIONS.has(active.dataset.action) && boardEl.contains(active)) {
    columnAction = {
      id: active.closest("[data-column-id]")?.dataset.columnId,
      action: active.dataset.action,
    };
  }

  const cardFocus = captureCardFocus(boardEl) || captureCardFocus(archivedList);

  return { composer, columnName, columnAction, cardFocus };
}

function captureCardFocus(root) {
  const active = document.activeElement;
  if (!active || !root?.contains(active)) return null;
  const item = active.closest("[data-card-id]");
  if (!item || !root.contains(item)) return null;
  const id = item.dataset.cardId;
  if (active.matches("[data-action='move-menu']")) return { id, part: "move" };
  if (active.matches("[data-action='archive-card']")) return { id, part: "archive" };
  if (active.matches("[data-action='restore']")) return { id, part: "restore" };
  if (active.closest("[data-card-link]")) return { id, part: "link" };
  return null;
}

function cardItem(cardId) {
  if (!cardId) return null;
  const selector = `[data-card-id="${CSS.escape(cardId)}"]`;
  return boardEl.querySelector(selector) || archivedList.querySelector(selector);
}

function caretOffset(el) {
  const selection = document.getSelection();
  if (!selection || !selection.anchorNode || !el.contains(selection.anchorNode)) return null;
  if (selection.anchorNode === el) return null;
  return selection.anchorOffset;
}

function restoreUi(ui) {
  if (ui.columnName?.id) {
    const heading = boardEl.querySelector(
      `[data-column-id="${CSS.escape(ui.columnName.id)}"] [data-column-name]`,
    );
    if (heading) {
      heading.textContent = ui.columnName.value;
      focusEditable(heading, ui.columnName.offset);
    }
  }

  for (const [columnId, composer] of ui.composer) {
    const input = boardEl.querySelector(
      `[data-column-id="${CSS.escape(columnId)}"] [data-composer-input]`,
    );
    if (!input) continue;
    input.value = composer.value;
    if (!composer.focus) continue;
    input.focus();
    const start = composer.start ?? input.value.length;
    input.setSelectionRange(start, composer.end ?? start);
  }

  if (ui.cardFocus?.id) {
    const item = cardItem(ui.cardFocus.id);
    const target =
      ui.cardFocus.part === "move"
        ? item?.querySelector("[data-action='move-menu']")
        : ui.cardFocus.part === "archive"
          ? item?.querySelector("[data-action='archive-card']") ||
            item?.querySelector("[data-action='restore']")
          : ui.cardFocus.part === "restore"
            ? item?.querySelector("[data-action='restore']")
            : item?.querySelector("[data-card-link]");
    target?.focus();
  }

  if (ui.columnAction?.id && ui.columnAction.action) {
    const button = boardEl.querySelector(
      `[data-column-id="${CSS.escape(ui.columnAction.id)}"] [data-action="${CSS.escape(ui.columnAction.action)}"]`,
    );
    if (button && !button.disabled) button.focus();
    else if (!document.activeElement || document.activeElement === document.body) {
      boardEl
        .querySelector(`[data-column-id="${CSS.escape(ui.columnAction.id)}"] [data-column-name]`)
        ?.focus();
    }
  }

  restoreLostFocus();
}

function restoreLostFocus() {
  const pending = focusAfterRender;
  focusAfterRender = null;
  if (!pending) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  if (pending.addColumn) {
    newColumnInput.focus();
    return;
  }
  const heading = boardEl.querySelector(
    `[data-column-id="${CSS.escape(pending.columnId)}"] [data-column-name]`,
  );
  heading?.focus();
}

function focusEditable(el, offset) {
  el.focus();
  const text = el.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) return;
  const point = Math.min(offset ?? text.length, text.length);
  const range = document.createRange();
  range.setStart(text, point);
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function iconButton(action, label, text, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  button.disabled = disabled;
  return button;
}

function clearDragOver() {
  boardEl.querySelectorAll(".drag-over, .dragging").forEach((el) => {
    el.classList.remove("drag-over", "dragging");
  });
}

function isNoopMove(cardId, columnId, beforeId) {
  const board = readBoard(doc);
  const card = board.cards.find((item) => item.id === cardId);
  if (!card || card.columnId !== columnId || card.archived) return false;
  const ids = columnCards(board.cards, columnId).map((item) => item.id);
  const index = ids.indexOf(cardId);
  if (index < 0) return false;
  if (beforeId) return ids[index + 1] === beforeId;
  return index === ids.length - 1;
}

async function moveCard(cardId, columnId, beforeId) {
  if (!doc || !cardId || !columnId || beforeId === cardId) return false;
  if (isNoopMove(cardId, columnId, beforeId)) return true;
  setError("");
  try {
    const body = { columnId };
    if (beforeId) body.beforeId = beforeId;
    await requestJson(API.cardMove(boardId, cardId), { method: "POST", body });
    return true;
  } catch (err) {
    setError(err.message);
    return false;
  }
}

/** Run moves one at a time so a second arrow reads the board after the first lands. */
function enqueueCardMove(cardId, plan) {
  moveQueue = moveQueue
    .then(async () => {
      if (!doc || missing) return;
      const planned = plan();
      if (!planned || planned.blocked) {
        if (planned?.blocked) announce(planned.blocked);
        return;
      }
      if (isNoopMove(cardId, planned.columnId, planned.beforeId)) return;
      const ok = await moveCard(cardId, planned.columnId, planned.beforeId);
      if (ok) await waitForPlacement(cardId, planned.columnId, planned.beforeId);
    })
    .catch(() => {});
}

function waitForPlacement(cardId, columnId, beforeId) {
  if (!doc || isNoopMove(cardId, columnId, beforeId)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      doc?.off("update", onUpdate);
      clearTimeout(timer);
      resolve();
    };
    const onUpdate = () => {
      if (isNoopMove(cardId, columnId, beforeId)) done();
    };
    timer = setTimeout(done, 2000);
    doc.on("update", onUpdate);
  });
}

function closeMoveMenu({ restoreFocus = false } = {}) {
  if (!openMenu) return;
  const { button, menu } = openMenu;
  openMenu = null;
  if (button.isConnected) {
    button.setAttribute("aria-expanded", "false");
    button.removeAttribute("aria-controls");
  }
  menu.remove();
  if (restoreFocus && button.isConnected) button.focus();
  // Let the click or key that closed the menu finish before swapping the board.
  if (!renderPending || dragCardId || openMenu) return;
  setTimeout(() => {
    if (!renderPending || dragCardId || openMenu) return;
    renderFromDoc();
  }, 0);
}

function openMoveMenu(button) {
  if (!doc || !canEditBoard()) return;
  const cardId = button?.dataset.cardId;
  if (!cardId) return;
  if (openMenu?.cardId === cardId) {
    closeMoveMenu({ restoreFocus: true });
    return;
  }
  closeMoveMenu({ restoreFocus: false });
  const live =
    boardEl.querySelector(
      `[data-card-id="${CSS.escape(cardId)}"] [data-action="move-menu"]`,
    ) || button;
  if (!live.isConnected) return;
  const menu = buildMoveMenu(cardId);
  if (!menu) return;
  live.setAttribute("aria-expanded", "true");
  live.setAttribute("aria-controls", menu.id);
  const cardEl = live.closest("[data-card-id]");
  if (cardEl) cardEl.append(menu);
  else live.after(menu);
  openMenu = { cardId, button: live, menu };
  const items = [...menu.querySelectorAll("[role='menuitem']")];
  items[0]?.focus();
}

function buildMoveMenu(cardId) {
  const board = readBoard(doc);
  const card = board.cards.find((item) => item.id === cardId);
  if (!card || card.archived) return null;
  const menu = document.createElement("div");
  menu.className = "move-menu";
  menu.dataset.moveMenu = "";
  menu.id = `move-menu-${cardId}`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Move ${card.title || "Untitled"}`);
  menu.addEventListener("pointerdown", () => holdCardStill(menu.closest("[data-card-id]")));
  addMoveItem(menu, cardId, "Up", { key: "ArrowUp" });
  addMoveItem(menu, cardId, "Down", { key: "ArrowDown" });
  for (const column of board.columns) {
    if (column.id === card.columnId) continue;
    addMoveItem(menu, cardId, `To ${column.name || "Untitled"}`, { columnId: column.id });
  }
  return menu;
}

function addMoveItem(menu, cardId, label, kind) {
  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.dataset.moveAction = "";
  item.tabIndex = -1;
  item.textContent = label;
  const board = readBoard(doc);
  const planned = kind.key
    ? planCardNudge(board.columns, board.cards, cardId, kind.key)
    : planMoveToColumn(board.columns, board.cards, cardId, kind.columnId);
  if (!planned || planned.blocked) {
    item.setAttribute("aria-disabled", "true");
    if (planned?.blocked) {
      item.dataset.blocked = planned.blocked;
      const reason = document.createElement("span");
      reason.className = "visually-hidden";
      reason.textContent = `, ${planned.blocked}`;
      item.append(reason);
    }
  }
  item.addEventListener("click", () => {
    if (item.dataset.blocked) {
      announce(item.dataset.blocked);
      return;
    }
    if (item.getAttribute("aria-disabled") === "true") return;
    closeMoveMenu({ restoreFocus: true });
    enqueueCardMove(cardId, () => {
      if (!doc) return null;
      const live = readBoard(doc);
      return kind.key
        ? planCardNudge(live.columns, live.cards, cardId, kind.key)
        : planMoveToColumn(live.columns, live.cards, cardId, kind.columnId);
    });
  });
  menu.append(item);
}

function moveMenuFocus(menu, delta) {
  const items = [...menu.querySelectorAll("[role='menuitem']")];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  const start = current === -1 ? (delta > 0 ? -1 : 0) : current;
  const index = (start + delta + items.length) % items.length;
  items[index]?.focus();
}

function focusMenuEnd(menu, first) {
  const items = [...menu.querySelectorAll("[role='menuitem']")];
  const item = first ? items[0] : items[items.length - 1];
  item?.focus();
}

const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='plaintext-only']",
].join(",");

function isTabStop(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest("[hidden], [data-move-menu]")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.tabIndex < 0) return false;
  return el.getClientRects().length > 0;
}

function nextTabStop(from, direction) {
  const stops = [...document.querySelectorAll(TABBABLE)].filter(isTabStop);
  const index = stops.indexOf(from);
  if (index < 0) return null;
  return stops[index + direction] || null;
}

async function shiftColumn(columnId, direction) {
  const ids = doc.getArray("columns").toArray().map((column) => column.id);
  const index = ids.indexOf(columnId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return;
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  setError("");
  try {
    await requestJson(API.columnOrder(boardId), { method: "POST", body: { ids: next } });
  } catch (err) {
    setError(err.message);
  }
}

async function removeColumn(columnId) {
  const ids = doc.getArray("columns").toArray().map((column) => column?.id);
  const index = ids.indexOf(columnId);
  const neighborId = ids[index + 1] || ids[index - 1] || null;
  focusAfterRender = neighborId ? { columnId: neighborId } : { addColumn: true };
  setError("");
  try {
    await requestJson(API.column(boardId, columnId), { method: "DELETE" });
  } catch (err) {
    focusAfterRender = null;
    setError(err.message);
  }
}

async function commitColumnName(heading) {
  if (rendering || !doc) return;
  const columnId = heading.closest("[data-column-id]")?.dataset.columnId;
  if (!columnId) return;
  const current = doc.getArray("columns").toArray().find((column) => column?.id === columnId);
  if (!current) return;
  const name = oneLine(heading.textContent ?? "", NAME_MAX);
  if (!name || name === current.name) {
    if (!name) heading.textContent = current.name;
    return;
  }
  setError("");
  try {
    await requestJson(API.column(boardId, columnId), { method: "PATCH", body: { name } });
  } catch (err) {
    setError(err.message);
    if (heading.isConnected) heading.textContent = current.name;
  }
}

async function commitBoardName() {
  if (rendering || !doc) return;
  const current = String(doc.getMap("meta").get("name") ?? "");
  const name = oneLine(boardNameEl.textContent ?? "", NAME_MAX);
  if (!name || name === current) {
    if (!name) boardNameEl.textContent = current || "Untitled board";
    return;
  }
  setError("");
  try {
    await requestJson(API.board(boardId), { method: "PATCH", body: { name } });
  } catch (err) {
    setError(err.message);
    boardNameEl.textContent = current || "Untitled board";
  }
}

async function addCard(columnId, input) {
  const title = oneLine(input.value, TITLE_MAX);
  if (!title) {
    input.value = "";
    return;
  }
  if (adding.has(columnId)) return;
  adding.add(columnId);
  input.value = "";
  setError("");
  try {
    await requestJson(API.cards(boardId), {
      method: "POST",
      body: { title, columnId },
    });
  } catch (err) {
    setError(err.message);
    const live = boardEl.querySelector(
      `[data-column-id="${CSS.escape(columnId)}"] [data-composer-input]`,
    );
    if (live && !live.value) live.value = title;
    else if (!input.value) input.value = title;
  } finally {
    adding.delete(columnId);
  }
}

function releaseLive() {
  presence?.destroy();
  presence = null;
  const current = room;
  room = null;
  current?.disconnect();
}

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  releaseLive();
});

function showMissing() {
  missing = true;
  renderPending = false;
  releaseLive();
  boardNameEl.textContent = "Board not found";
  setTitleEditing(boardNameEl, false);
  setBoardKeys(false);
  addColumnForm.hidden = true;
  boardEl.replaceChildren();
  archivedStrip.hidden = true;
  setStatus(statusEl, "error", "Board not found");
}

function finishDrag() {
  if (!dragCardId && !suppressClick) return;
  dragCardId = null;
  clearDragOver();
  // The click that follows a drop is not a navigation.
  setTimeout(() => {
    suppressClick = false;
  }, 0);
  if (renderPending) renderFromDoc();
}

function dropBeforeId(column, event) {
  const overCard = event.target.closest?.("[data-card-id]");
  if (!overCard || !column.contains(overCard)) return null;
  const rect = overCard.getBoundingClientRect();
  const lowerHalf = event.clientY >= rect.top + rect.height / 2;
  if (!lowerHalf) return overCard.dataset.cardId;
  return overCard.nextElementSibling?.dataset.cardId ?? null;
}

boardEl.addEventListener("click", (event) => {
  if (!canEditBoard()) return;
  if (suppressClick) {
    event.preventDefault();
    return;
  }
  const moveButton = event.target.closest("[data-action='move-menu']");
  if (moveButton && boardEl.contains(moveButton)) {
    openMoveMenu(moveButton);
    return;
  }
  const archiveButton = event.target.closest("[data-action='archive-card']");
  if (archiveButton && boardEl.contains(archiveButton)) {
    void archiveCard(archiveButton);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button || !boardEl.contains(button)) return;
  const columnId = button.closest("[data-column-id]")?.dataset.columnId;
  if (!columnId) return;
  if (button.dataset.action === "move-left") void shiftColumn(columnId, -1);
  else if (button.dataset.action === "move-right") void shiftColumn(columnId, 1);
  else if (button.dataset.action === "delete-column") void removeColumn(columnId);
});

boardEl.addEventListener("submit", (event) => {
  if (!canEditBoard()) return;
  const form = event.target.closest?.("[data-composer]");
  if (!form || !boardEl.contains(form)) return;
  event.preventDefault();
  const columnId = form.closest("[data-column-id]")?.dataset.columnId;
  const input = form.querySelector("[data-composer-input]");
  if (!columnId || !input) return;
  void addCard(columnId, input);
});

boardEl.addEventListener("focusout", (event) => {
  if (!canEditBoard()) return;
  const heading = event.target.closest?.("[data-column-name]");
  if (!heading || !boardEl.contains(heading)) return;
  void commitColumnName(heading);
});

boardEl.addEventListener("keydown", (event) => {
  const menu = event.target.closest?.("[data-move-menu]");
  if (menu && boardEl.contains(menu)) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveMenuFocus(menu, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveMenuFocus(menu, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusMenuEnd(menu, true);
    } else if (event.key === "End") {
      event.preventDefault();
      focusMenuEnd(menu, false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMoveMenu({ restoreFocus: true });
    } else if (event.key === "Tab") {
      event.preventDefault();
      const button = openMenu?.button ?? null;
      const target = button ? nextTabStop(button, event.shiftKey ? -1 : 1) : null;
      closeMoveMenu({ restoreFocus: false });
      (target || button)?.focus();
    }
    return;
  }

  if (!canEditBoard()) return;

  if (event.target.matches?.("[data-column-name]")) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.target.blur();
    } else if (event.key === "Escape") {
      const columnId = event.target.closest("[data-column-id]")?.dataset.columnId;
      const current = doc?.getArray("columns").toArray().find((column) => column?.id === columnId);
      if (current) event.target.textContent = current.name;
      event.preventDefault();
      event.target.blur();
    }
    return;
  }

  if (event.target.matches?.("[data-action='move-menu']") && event.key === "ArrowDown") {
    event.preventDefault();
    openMoveMenu(event.target);
    return;
  }

  const link = event.target.closest?.("[data-card-link]");
  if (!link || !boardEl.contains(link) || !ARROW_KEYS.has(event.key)) return;
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.repeat) return;
  event.preventDefault();
  const cardId = link.closest("[data-card-id]")?.dataset.cardId;
  const key = event.key;
  if (!cardId) return;
  enqueueCardMove(cardId, () => {
    if (!doc) return null;
    const board = readBoard(doc);
    return planCardNudge(board.columns, board.cards, cardId, key);
  });
});

boardEl.addEventListener("dragstart", (event) => {
  if (!canEditBoard()) return;
  const fromControl = (event.composedPath?.() ?? []).some(
    (node) => node instanceof Element && node.matches?.("button, [data-move-menu]"),
  );
  if (fromControl) {
    event.preventDefault();
    return;
  }
  const item = event.target.closest?.("[data-card-id]");
  if (!item || !boardEl.contains(item) || !item.draggable) return;
  dragCardId = item.dataset.cardId;
  suppressClick = true;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", dragCardId);
  item.classList.add("dragging");
  item.addEventListener("dragend", finishDrag, { once: true });
  if (openMenu) closeMoveMenu({ restoreFocus: false });
});

boardEl.addEventListener("dragover", (event) => {
  if (!canEditBoard()) return;
  const column = event.target.closest?.("[data-column-id]");
  if (!column || !boardEl.contains(column)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  for (const el of boardEl.querySelectorAll(".drag-over")) {
    if (el !== column) el.classList.remove("drag-over");
  }
  column.classList.add("drag-over");
});

boardEl.addEventListener("drop", (event) => {
  if (!canEditBoard()) return;
  const column = event.target.closest?.("[data-column-id]");
  if (!column || !boardEl.contains(column)) return;
  event.preventDefault();
  clearDragOver();
  const cardId = dragCardId || event.dataTransfer.getData("text/plain");
  const columnId = column.dataset.columnId;
  const beforeId = dropBeforeId(column, event);
  enqueueCardMove(cardId, () => ({ columnId, beforeId }));
});

document.addEventListener("dragend", finishDrag);

document.addEventListener("pointerdown", (event) => {
  if (!openMenu) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (openMenu.menu.contains(target) || openMenu.button.contains(target)) return;
  closeMoveMenu({ restoreFocus: false });
});

async function archiveCard(button) {
  const cardId = button?.dataset.cardId;
  if (!cardId || !canEditBoard()) return;
  // Keep the button focusable. `disabled` would blur it before the redraw
  // can move focus to Restore.
  if (button.getAttribute("aria-disabled") === "true") return;
  button.setAttribute("aria-disabled", "true");
  setError("");
  try {
    await requestJson(API.cardArchive(boardId, cardId), {
      method: "POST",
      body: { archived: true },
    });
    // The redraw may already have dropped focus when it removed this button.
    const restore = document.querySelector(
      `[data-card-id="${CSS.escape(cardId)}"] [data-action="restore"]`,
    );
    const fallen = document.activeElement === button || document.activeElement === document.body;
    if (restore && fallen) restore.focus();
  } catch (err) {
    if (button.isConnected) button.removeAttribute("aria-disabled");
    setError(err.message);
  }
}

archivedList.addEventListener("click", (event) => {
  if (!canEditBoard()) return;
  const button = event.target.closest("[data-action='restore']");
  if (!button) return;
  const cardId = button.dataset.cardId;
  button.disabled = true;
  setError("");
  void requestJson(API.cardArchive(boardId, cardId), {
    method: "POST",
    body: { archived: false },
  }).catch((err) => {
    button.disabled = false;
    setError(err.message);
  });
});

boardNameEl.addEventListener("keydown", (event) => {
  if (!isOwner()) return;
  if (event.key === "Enter") {
    event.preventDefault();
    boardNameEl.blur();
  } else if (event.key === "Escape" && doc) {
    boardNameEl.textContent = String(doc.getMap("meta").get("name") ?? "");
    event.preventDefault();
    boardNameEl.blur();
  }
});

boardNameEl.addEventListener("blur", () => {
  if (!isOwner()) return;
  void commitBoardName();
});

unarchiveBtn.addEventListener("click", async () => {
  if (!isOwner()) return;
  unarchiveBtn.disabled = true;
  setError("");
  try {
    await requestJson(API.board(boardId), { method: "PATCH", body: { archived: false } });
  } catch (err) {
    setError(err.message);
  } finally {
    unarchiveBtn.disabled = false;
  }
});

addColumnForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canEditBoard()) return;
  const name = oneLine(newColumnInput.value, NAME_MAX);
  if (!name) {
    newColumnInput.value = "";
    return;
  }
  const button = addColumnForm.querySelector("button");
  button.disabled = true;
  setError("");
  try {
    await requestJson(API.columns(boardId), { method: "POST", body: { name } });
    newColumnInput.value = "";
  } catch (err) {
    setError(err.message);
  } finally {
    button.disabled = false;
  }
});

async function loadMembersPanel() {
  if (myRole !== "owner") {
    membersPanel.hidden = true;
    return;
  }
  membersPanel.hidden = false;
  try {
    const data = await requestJson(API.boardMembers(boardId));
    renderMembers(data.members || []);
  } catch (err) {
    setError(err.message);
  }
}

function renderMembers(members) {
  membersList.replaceChildren();
  const ownerCount = members.filter((m) => m.role === "owner").length;

  for (const member of members) {
    const li = document.createElement("li");
    li.className = "member-row";

    const email = document.createElement("span");
    email.className = "member-email";
    email.textContent = member.email;
    li.append(email);

    const select = document.createElement("select");
    select.setAttribute("aria-label", `Role for ${member.email}`);
    for (const role of ["owner", "editor", "viewer"]) {
      const option = document.createElement("option");
      option.value = role;
      option.textContent = role;
      if (member.role === role) option.selected = true;
      select.append(option);
    }
    const onlyOwner = member.role === "owner" && ownerCount <= 1;
    select.disabled = onlyOwner;
    select.addEventListener("change", () => {
      void changeMemberRole(member.email, select.value);
    });
    li.append(select);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn";
    remove.textContent = member.email === myEmail ? "Leave" : "Remove";
    remove.setAttribute(
      "aria-label",
      member.email === myEmail ? "Leave board" : `Remove ${member.email}`,
    );
    remove.disabled = onlyOwner;
    remove.addEventListener("click", () => {
      void removeMember(member.email);
    });
    li.append(remove);

    membersList.append(li);
  }
}

async function changeMemberRole(email, role) {
  setError("");
  try {
    await requestJson(API.boardMember(boardId, email), { method: "PATCH", body: { role } });
    await loadMembersPanel();
  } catch (err) {
    setError(err.message);
    await loadMembersPanel();
  }
}

async function removeMember(email) {
  setError("");
  try {
    await requestJson(API.boardMember(boardId, email), { method: "DELETE" });
    if (email === myEmail) {
      location.assign("/");
      return;
    }
    await loadMembersPanel();
  } catch (err) {
    setError(err.message);
  }
}

function showAccessChrome() {
  boardAccessEl.hidden = false;
  boardRoleEl.textContent = myRole ? `Your role: ${myRole}` : "";
  // Owners leave via the members list (last-owner guard lives there).
  leaveBoardBtn.hidden = !myRole || myRole === "owner";
  addColumnForm.hidden = !canEditBoard();
  document.body.classList.toggle("view-only", myRole === "viewer");
  setTitleEditing(boardNameEl, isOwner(), BOARD_TITLE_HINT);
  setBoardKeys(canEditBoard());
  unarchiveBtn.hidden = !isOwner();
}

inviteForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("");
  const button = inviteForm.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const created = await requestJson(API.boardInvites(boardId), {
      method: "POST",
      body: { role: inviteRoleEl.value },
    });
    inviteLinkEl.value = created.url;
    inviteLinkRow.hidden = false;
    inviteLinkEl.focus();
    inviteLinkEl.select();
  } catch (err) {
    setError(err.message);
  } finally {
    button.disabled = false;
  }
});

copyInviteBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteLinkEl.value);
    copyInviteBtn.textContent = "Copied";
    announce("Invite link copied");
    setTimeout(() => {
      copyInviteBtn.textContent = "Copy";
    }, 1500);
  } catch {
    inviteLinkEl.select();
  }
});

leaveBoardBtn?.addEventListener("click", () => {
  if (!myEmail) return;
  void removeMember(myEmail);
});

exportBoardBtn?.addEventListener("click", () => {
  void downloadBoardExport();
});

function filenameFromDisposition(header, fallback) {
  const match = /filename="([^"]+)"/.exec(header || "");
  return match?.[1] || fallback;
}

async function downloadBoardExport() {
  if (!boardId || !exportBoardBtn) return;
  setError("");
  exportBoardBtn.disabled = true;
  try {
    const cards = [];
    const missingCardIds = [];
    const seenCardIds = new Set();
    let cursor = null;
    let board = null;
    let exportedAt = null;
    let schemaVersion = null;
    let filename = "board.json";
    for (;;) {
      const endpoint = new URL(API.boardExport(boardId), location.origin);
      if (cursor) endpoint.searchParams.set("cursor", cursor);
      const response = await fetch(endpoint, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        location.replace("/");
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `Export failed (${response.status})`);
      }
      if (!board) {
        filename = filenameFromDisposition(response.headers.get("Content-Disposition"), filename);
      }
      const page = await response.json();
      if (!Array.isArray(page.cards)) throw new Error("Export failed (missing cards)");
      if (!board) {
        if (!page.board) throw new Error("Export failed (missing board)");
        board = page.board;
        exportedAt = page.exportedAt;
        schemaVersion = page.schemaVersion;
      }
      for (const card of page.cards) {
        const id = typeof card?.id === "string" ? card.id : "";
        if (id && seenCardIds.has(id)) continue;
        if (id) seenCardIds.add(id);
        cards.push(card);
      }
      if (Array.isArray(page.missingCardIds)) missingCardIds.push(...page.missingCardIds);
      const next = typeof page.nextCursor === "string" ? page.nextCursor : "";
      if (!next) break;
      cursor = next;
    }
    const file = { exportedAt, schemaVersion, board, cards };
    if (missingCardIds.length) file.missingCardIds = missingCardIds;
    saveJsonDownload(file, filename);
  } catch (err) {
    setError(err.message);
  } finally {
    exportBoardBtn.disabled = false;
  }
}

function saveJsonDownload(value, filename) {
  const blob = new Blob([JSON.stringify(value)], {
    type: "application/json;charset=utf-8",
  });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1500);
}

async function bootstrap() {
  if (!boardId) {
    showMissing();
    return;
  }

  try {
    const me = await requestJson(API.me);
    myEmail = me.email;
    if (myEmail) rememberSession({ email: myEmail });
  } catch (err) {
    if (err.status === 401) return;
    setError(err.message);
  }

  try {
    const snapshot = await requestJson(API.boardSnapshot(boardId));
    myRole = snapshot.role || null;
    if (myEmail && myRole) rememberSession({ email: myEmail, boardId, role: myRole });
    showAccessChrome();
    void loadMembersPanel();
  } catch (err) {
    if (err.status === 404 || err.status === 403) {
      showMissing();
      return;
    }
    setError(err.message);
  }

  room = connectYjsRoom(API.boardWs(boardId), {
    user: myEmail ? { email: myEmail } : null,
    stillThere: () => stillExists(API.boardSnapshot(boardId)),
    onMissing: showMissing,
    onClose(event) {
      if (event.code === 4403) {
        setStatus(statusEl, "error", "Checking access…");
        void settleRevokedAccess(API.boardSnapshot(boardId)).then((ok) => {
          if (ok === false) setError("Could not confirm access. Refresh to continue.");
        });
        return true;
      }
      return false;
    },
  });
  room.bindStatus(statusEl);
  presence = bindPresence(presenceEl, room.awareness, { selfEmail: myEmail, ready: room.ready });

  doc = await room.ready;
  if (!doc) return;
  renderFromDoc();
  doc.on("update", renderFromDoc);
}

bootstrap();
