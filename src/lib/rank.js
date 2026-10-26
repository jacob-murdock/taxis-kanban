/**
 * Integer gap ranks for card order within a column. Server-only.
 * Ranks are positive integers (multiples of RANK_GAP after renumber).
 */

export const RANK_GAP = 1024;

/** Rank for a card appended after `lastRank` (or the first card when null). */
export function rankAppend(lastRank) {
  if (lastRank == null || Number.isNaN(Number(lastRank))) return RANK_GAP;
  return Number(lastRank) + RANK_GAP;
}

/**
 * Midpoint between the previous neighbor and the card being inserted before.
 * `prevRank` is null when inserting at the head of the column.
 * Returns null when the gap is too small (caller renumbers, then retries).
 */
export function rankInsertBefore(prevRank, beforeRank) {
  const before = Number(beforeRank);
  if (Number.isNaN(before)) return null;

  if (prevRank == null || Number.isNaN(Number(prevRank))) {
    if (before <= 1) return null;
    return Math.floor(before / 2);
  }

  const prev = Number(prevRank);
  if (before - prev <= 1) return null;
  return Math.floor((prev + before) / 2);
}

/** Assign fresh gap ranks to cards already sorted in display order. */
export function renumberRanks(orderedIds) {
  const out = new Map();
  orderedIds.forEach((id, i) => {
    out.set(id, (i + 1) * RANK_GAP);
  });
  return out;
}

/** Stable order: ascending rank, then id. Used for render and renumber. */
export function compareByRankThenId(a, b) {
  const rankA = Number(a.rank) || 0;
  const rankB = Number(b.rank) || 0;
  if (rankA !== rankB) return rankA - rankB;
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/** Sort card-like objects `{id, rank}` by rank, then id. */
export function sortByRankThenId(cards) {
  return [...cards].sort(compareByRankThenId);
}
