/** Polite live region. Bursts collapse into one announcement. */

const REGION_ID = "activity-log";
const FLUSH_MS = 250;
const MAX_SENTENCES = 4;

let pending = [];
let timer = null;
let generation = 0;

export function announce(message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return;
  // Repeating a sentence still pushes the flush back, so a burst of the same
  // note ("Notes updated") is read once after the burst settles.
  if (!pending.includes(text)) pending.push(text);
  clearTimeout(timer);
  timer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  timer = null;
  const notes = pending.splice(0);
  const el = document.getElementById(REGION_ID);
  if (!el || notes.length === 0) return;
  const message =
    notes.length > MAX_SENTENCES
      ? `${notes.length} updates. ${notes.slice(0, 3).join(". ")}`
      : notes.join(". ");
  const mine = ++generation;
  // Clearing first lets an identical follow-up announcement fire again.
  el.textContent = "";
  setTimeout(() => {
    if (mine !== generation) return;
    el.textContent = message;
  }, 20);
}
