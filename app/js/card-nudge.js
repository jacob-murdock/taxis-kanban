/** One-step card moves for arrow keys and the Move menu. */

function columnLabel(columns, columnId) {
  const name = columns.find((column) => column.id === columnId)?.name;
  const trimmed = String(name ?? "").trim();
  return trimmed || "Untitled column";
}

function activeIn(cards, columnId) {
  return cards
    .filter((card) => card.columnId === columnId && !card.archived)
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return String(a.id).localeCompare(String(b.id));
    });
}

function locate(columns, cards, cardId) {
  const card = cards.find((item) => item.id === cardId);
  if (!card || card.archived || !card.columnId) return null;
  const columnIndex = columns.findIndex((column) => column.id === card.columnId);
  if (columnIndex < 0) return null;
  const column = activeIn(cards, card.columnId);
  const index = column.findIndex((item) => item.id === cardId);
  if (index < 0) return null;
  return { card, columnIndex, column, index };
}

function beforeIdAt(cards, columnId, index) {
  const dest = activeIn(cards, columnId);
  return index < dest.length ? dest[index].id : null;
}

/**
 * Arrow-key placement. `blocked` is announced when the card is already at that edge.
 * Returns null when this card cannot be nudged (missing or archived).
 * @returns {{ columnId: string, beforeId: string | null } | { blocked: string } | null}
 */
export function planCardNudge(columns, cards, cardId, key) {
  const found = locate(columns, cards, cardId);
  if (!found) return null;
  const { columnIndex, column, index, card } = found;
  const label = columnLabel(columns, card.columnId);

  if (key === "ArrowUp") {
    if (index === 0) return { blocked: `Already at the top of ${label}` };
    return { columnId: card.columnId, beforeId: column[index - 1].id };
  }
  if (key === "ArrowDown") {
    if (index === column.length - 1) return { blocked: `Already at the bottom of ${label}` };
    const before = column[index + 2];
    return { columnId: card.columnId, beforeId: before ? before.id : null };
  }
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const nextIndex = columnIndex + (key === "ArrowLeft" ? -1 : 1);
    const target = columns[nextIndex];
    if (!target) {
      return {
        blocked: key === "ArrowLeft" ? "Already in the first column" : "Already in the last column",
      };
    }
    return { columnId: target.id, beforeId: beforeIdAt(cards, target.id, index) };
  }
  return null;
}

/**
 * Move into another column, keeping the same index when the destination is long enough.
 * @returns {{ columnId: string, beforeId: string | null } | { blocked: string } | null}
 */
export function planMoveToColumn(columns, cards, cardId, columnId) {
  const found = locate(columns, cards, cardId);
  if (!found) return null;
  if (!columns.some((column) => column.id === columnId)) return null;
  const label = columnLabel(columns, columnId);
  if (found.card.columnId === columnId) return { blocked: `Already in ${label}` };
  return { columnId, beforeId: beforeIdAt(cards, columnId, found.index) };
}

/**
 * Options for the card page position control.
 * `beforeId` is the card this one currently sits above, or "" at the end.
 */
export function positionChoices(cards, columnId, cardId) {
  const only = { value: "", label: "Only card in this column" };
  if (!columnId) return { beforeId: "", movable: false, options: [only] };
  const column = activeIn(cards, columnId);
  const others = column.filter((card) => card.id !== cardId);
  const index = column.findIndex((card) => card.id === cardId);
  const next = index >= 0 ? column[index + 1] : null;
  const before = others.map((card) => ({
    value: card.id,
    label: `Before ${String(card.title ?? "").trim() || "Untitled"}`,
  }));
  return {
    beforeId: next?.id || "",
    movable: others.length > 0,
    options: [...before, others.length ? { value: "", label: "At the end" } : only],
  };
}
