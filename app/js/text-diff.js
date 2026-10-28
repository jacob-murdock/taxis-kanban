/**
 * Rewrite a Y.Text by its changed span, and map a caret through that rewrite.
 * The card page uses this so a field edit does not replace the whole body.
 */

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
export function mapIndexThroughTextDiff(index, prev, next) {
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
export function applyTextDiff(ytext, next) {
  const prev = ytext.toString();
  if (prev === next) return;

  const { start, endPrev, endNext } = textDiffBounds(prev, next);
  ytext.doc.transact(() => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  });
}
