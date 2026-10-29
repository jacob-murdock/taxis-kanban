/** Short sentences for a polite live region. Ranks that change without
 * reordering are ignored: a gap collapse renumbers a whole column.
 */

function text(value, fallback) {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

function columnLabel(columns, columnId) {
  const column = columns.find((item) => item.id === columnId);
  return text(column?.name, "Untitled column");
}

function cardTitle(card) {
  return text(card?.title, "Untitled");
}

function labelsKey(labels) {
  return Array.isArray(labels) ? labels.map(String).join("\u0000") : "";
}

function activeIds(cards, columnId) {
  return cards
    .filter((card) => card.columnId === columnId && !card.archived)
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return String(a.id).localeCompare(String(b.id));
    })
    .map((card) => card.id);
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  const ids = new Set(a);
  return b.every((id) => ids.has(id));
}

function relocationNote(before, after, titleOf, columnName) {
  if (before.join("\0") === after.join("\0")) return null;
  const candidates = [];
  for (const id of before) {
    if (!after.includes(id)) continue;
    const restBefore = before.filter((item) => item !== id);
    const restAfter = after.filter((item) => item !== id);
    if (restBefore.join("\0") !== restAfter.join("\0")) continue;
    const from = before.indexOf(id);
    const to = after.indexOf(id);
    if (from !== to) candidates.push({ id, to });
  }
  const moved = candidates.find((item) => item.to > before.indexOf(item.id)) || candidates[0];
  if (!moved || candidates.length > 2) return `Reordered ${columnName}`;
  const title = titleOf(moved.id);
  const ahead = after[moved.to - 1];
  if (ahead) return `Moved ${title} below ${titleOf(ahead)} in ${columnName}`;
  const behind = after[moved.to + 1];
  if (behind) return `Moved ${title} above ${titleOf(behind)} in ${columnName}`;
  return `Reordered ${columnName}`;
}

function reorderNotes(prev, next) {
  const notes = [];
  const prevCards = new Map(prev.cards.map((card) => [card.id, card]));
  const nextCards = new Map(next.cards.map((card) => [card.id, card]));
  const titleOf = (id) => cardTitle(nextCards.get(id) || prevCards.get(id));
  const columnIds = new Set([
    ...prev.columns.map((column) => column.id),
    ...next.columns.map((column) => column.id),
  ]);
  for (const columnId of columnIds) {
    if (!next.columns.some((column) => column.id === columnId)) continue;
    const before = activeIds(prev.cards, columnId);
    const after = activeIds(next.cards, columnId);
    const stayedBefore = before.filter((id) => after.includes(id));
    const stayedAfter = after.filter((id) => before.includes(id));
    const note = relocationNote(
      stayedBefore,
      stayedAfter,
      titleOf,
      columnLabel(next.columns, columnId),
    );
    if (note) notes.push(note);
  }
  return notes;
}

export function describeBoardChanges(prev, next) {
  if (!prev || !next) return [];
  const notes = [];

  if (text(prev.name, "Untitled board") !== text(next.name, "Untitled board")) {
    notes.push(`Board renamed to ${text(next.name, "Untitled board")}`);
  }
  if (Boolean(prev.archived) !== Boolean(next.archived)) {
    notes.push(next.archived ? "Board archived" : "Board restored");
  }

  const prevColumns = new Map(prev.columns.map((column) => [column.id, column]));
  const nextColumns = new Map(next.columns.map((column) => [column.id, column]));
  for (const column of next.columns) {
    const old = prevColumns.get(column.id);
    if (!old) notes.push(`Added column ${columnLabel(next.columns, column.id)}`);
    else if (text(old.name, "Untitled column") !== text(column.name, "Untitled column")) {
      notes.push(`Renamed column ${text(old.name, "Untitled column")} to ${text(column.name, "Untitled column")}`);
    }
  }
  for (const column of prev.columns) {
    if (!nextColumns.has(column.id)) {
      notes.push(`Removed column ${text(column.name, "Untitled column")}`);
    }
  }
  const prevOrder = prev.columns.map((column) => column.id);
  const nextOrder = next.columns.map((column) => column.id);
  if (prevOrder.join("\0") !== nextOrder.join("\0") && sameIds(prevOrder, nextOrder)) {
    notes.push("Columns reordered");
  }

  const prevCards = new Map(prev.cards.map((card) => [card.id, card]));
  const nextCards = new Map(next.cards.map((card) => [card.id, card]));
  const columnsForName = next.columns.length ? next.columns : prev.columns;

  for (const card of next.cards) {
    const old = prevCards.get(card.id);
    const title = cardTitle(card);
    if (!old) {
      if (!card.archived) notes.push(`Added ${title} to ${columnLabel(columnsForName, card.columnId)}`);
      continue;
    }
    if (Boolean(old.archived) !== Boolean(card.archived)) {
      notes.push(
        card.archived
          ? `Archived ${title}`
          : `Restored ${title} to ${columnLabel(columnsForName, card.columnId)}`,
      );
      continue;
    }
    if (cardTitle(old) !== title) notes.push(`Renamed ${cardTitle(old)} to ${title}`);
    if (card.archived) continue;
    if (old.columnId !== card.columnId) {
      notes.push(`Moved ${title} to ${columnLabel(columnsForName, card.columnId)}`);
    }
    if (
      String(old.assignee ?? "") !== String(card.assignee ?? "") ||
      String(old.due ?? "") !== String(card.due ?? "") ||
      labelsKey(old.labels) !== labelsKey(card.labels)
    ) {
      notes.push(`Updated ${title}`);
    }
  }
  for (const card of prev.cards) {
    if (!nextCards.has(card.id)) notes.push(`Removed ${cardTitle(card)}`);
  }

  notes.push(...reorderNotes(prev, next));
  return notes;
}

function columnName(columns, columnId) {
  const column = columns.find((item) => item.id === columnId);
  return text(column?.name, "another column");
}

/**
 * @param {Set<string>} [skip] field keys the user is editing; those stay quiet
 */
export function describeCardChanges(prev, next, { columns = [], skip = new Set() } = {}) {
  if (!prev || !next) return [];
  const notes = [];
  const title = text(next.title, "Untitled");

  if (text(prev.title, "Untitled") !== title && !skip.has("title")) {
    notes.push(`Title is now ${title}`);
  }
  if (prev.columnId !== next.columnId && !skip.has("column")) {
    notes.push(`Moved to ${columnName(columns, next.columnId)}`);
  }
  if (String(prev.assignee ?? "") !== String(next.assignee ?? "") && !skip.has("assignee")) {
    notes.push(next.assignee ? `Assignee is now ${next.assignee}` : "Assignee cleared");
  }
  if (String(prev.due ?? "") !== String(next.due ?? "") && !skip.has("due")) {
    notes.push(next.due ? `Due date is now ${next.due}` : "Due date cleared");
  }
  if (labelsKey(prev.labels) !== labelsKey(next.labels) && !skip.has("label")) {
    notes.push("Labels updated");
  }
  if (Boolean(prev.archived) !== Boolean(next.archived)) {
    notes.push(next.archived ? "Card archived" : "Card restored");
  }
  if (String(prev.body ?? "") !== String(next.body ?? "") && !skip.has("body")) {
    notes.push("Notes updated");
  }
  return notes;
}
