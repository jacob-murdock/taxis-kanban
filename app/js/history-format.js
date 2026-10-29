/** Readable changelog lines for the card page. Pure: no DOM. */

const FIELD_LABELS = {
  title: "Title",
  columnId: "Column",
  due: "Due",
  assignee: "Assignee",
  labels: "Labels",
  archived: "Archived",
  body: "Notes",
};

const JUST_NOW_MS = 45_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function clip(value, max = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "empty";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatLabels(value) {
  if (value == null || value === "" || value === "[]") return "empty";
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      if (!parsed.length) return "empty";
      return clip(parsed.map((label) => String(label)).join(", "));
    }
  } catch {
    /* Not JSON. Show the stored text. */
  }
  return clip(value);
}

function columnName(columns, id) {
  if (id == null || id === "") return "empty";
  const found = columns.find((column) => column && column.id === id);
  if (!found) return clip(id);
  const name = typeof found.name === "string" ? found.name.trim() : "";
  return name ? clip(name) : "Untitled column";
}

function shownValue(field, value, columns) {
  if (value == null || value === "") return "empty";
  if (field === "labels") return formatLabels(value);
  if (field === "archived") {
    if (value === "true") return "archived";
    if (value === "false") return "restored";
    return clip(value);
  }
  if (field === "columnId") return columnName(columns, value);
  return clip(value);
}

function timeParts(date, timeZone) {
  const zone = timeZone ? { timeZone } : {};
  const datePart = new Intl.DateTimeFormat("en-US", { ...zone, dateStyle: "medium" }).format(date);
  const timePart = new Intl.DateTimeFormat("en-US", { ...zone, timeStyle: "short" }).format(date);
  const absolute = new Intl.DateTimeFormat("en-US", {
    ...zone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  return { datePart, timePart, absolute };
}

function relativeTime(date, now, parts) {
  const elapsed = now - date.getTime();
  if (Math.abs(elapsed) < JUST_NOW_MS) return "just now";
  if (elapsed < 0) return parts.datePart;
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 60) return minutes <= 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(elapsed / HOUR_MS);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(elapsed / DAY_MS);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return parts.datePart;
}

/**
 * @returns {{ datetime: string, relative: string, absolute: string, suffix: string, author: string, summary: string }}
 * `suffix` is hidden next to the relative time so the accessible name includes
 * the absolute timestamp. When the visible text is already the date, it is
 * only the clock time.
 */
export function formatHistoryEntry(entry = {}, { columns = [], now = Date.now(), timeZone } = {}) {
  const list = Array.isArray(columns) ? columns : [];
  const field = typeof entry.field === "string" ? entry.field : "";
  const label = FIELD_LABELS[field] || field || "Field";
  const rawAuthor = typeof entry.author === "string" ? entry.author.trim() : "";
  const author = rawAuthor && rawAuthor.toLowerCase() !== "system" ? rawAuthor : "";
  const summary =
    field === "body"
      ? "Updated the notes"
      : `${label}: ${shownValue(field, entry.prev, list)} → ${shownValue(field, entry.next, list)}`;

  const ts = typeof entry.ts === "string" ? entry.ts : "";
  const date = ts ? new Date(ts) : new Date(NaN);
  if (Number.isNaN(date.getTime())) {
    return { datetime: "", relative: ts || "Unknown time", absolute: "", suffix: "", author, summary };
  }

  const parts = timeParts(date, timeZone);
  const relative = relativeTime(date, now, parts);
  const suffix = relative === parts.datePart ? parts.timePart : parts.absolute;
  return {
    datetime: date.toISOString(),
    relative,
    absolute: parts.absolute,
    suffix,
    author,
    summary,
  };
}
