import {
  ASSIGNEE_MAX,
  CARD_TITLE_MAX,
  COLUMN_NAME_MAX,
  DUE_MAX,
  LABEL_MAX_COUNT,
  LABEL_MAX_LENGTH,
} from "./constants.js";

export function clampColumnName(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, COLUMN_NAME_MAX);
}

export function clampStoredTitle(value) {
  if (typeof value !== "string") return "Untitled";
  return value.trim().slice(0, CARD_TITLE_MAX) || "Untitled";
}

/** Length cap only, so a live edit can keep a trailing space. */
export function clampLiveTitle(value, fallback) {
  if (typeof value !== "string") return fallback ?? "Untitled";
  return value.slice(0, CARD_TITLE_MAX);
}

export function clampAssignee(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, ASSIGNEE_MAX);
}

export function clampLiveAssignee(value, fallback) {
  if (typeof value !== "string") return fallback ?? "";
  return value.slice(0, ASSIGNEE_MAX);
}

export function clampDue(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  return value.trim().slice(0, DUE_MAX) || null;
}

export function clampLiveDue(value, fallback) {
  if (value == null) return null;
  if (typeof value !== "string") return fallback ?? null;
  return value.slice(0, DUE_MAX);
}

export function clampLabels(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const label of value) {
    if (out.length >= LABEL_MAX_COUNT) break;
    if (typeof label !== "string") continue;
    const text = label.trim().slice(0, LABEL_MAX_LENGTH);
    if (text) out.push(text);
  }
  return out;
}

export function sameLabels(a, b) {
  return a.length === b.length && a.every((label, i) => label === b[i]);
}
