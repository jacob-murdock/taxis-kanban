import * as Y from "yjs";
import { DEFAULT_COLUMN_NAMES } from "./constants.js";
import { clampAssignee, clampDue, clampLabels, clampStoredTitle } from "./fields.js";

function readYMapValue(map, key, fallback) {
  const value = map.get(key);
  return value === undefined ? fallback : value;
}

export function generateBoardId() {
  return `board_${crypto.randomUUID()}`;
}

export function generateCardId() {
  return `card_${crypto.randomUUID()}`;
}

export function generateColumnId() {
  return `col_${crypto.randomUUID()}`;
}

export function createEmptyBoardDoc(id, name = "Untitled board") {
  const doc = new Y.Doc();
  const meta = doc.getMap("meta");
  meta.set("id", id ?? null);
  meta.set("name", name);
  meta.set("archived", false);

  const columns = doc.getArray("columns");
  for (const columnName of DEFAULT_COLUMN_NAMES) {
    columns.push([{ id: generateColumnId(), name: columnName }]);
  }

  doc.getMap("cards");
  return doc;
}

export function createEmptyCardDoc(id, boardId) {
  const doc = new Y.Doc();
  const fields = doc.getMap("fields");

  fields.set("id", id ?? null);
  fields.set("boardId", boardId ?? null);
  fields.set("title", "Untitled");
  fields.set("columnId", null);
  fields.set("due", null);
  fields.set("assignee", "");
  fields.set("archived", false);

  doc.getArray("labels");
  doc.getText("body");

  return doc;
}

export function materializeCard(doc) {
  const fields = doc.getMap("fields");
  const labels = doc.getArray("labels").toArray().map((label) => String(label));

  return {
    id: readYMapValue(fields, "id", ""),
    boardId: readYMapValue(fields, "boardId", ""),
    title: readYMapValue(fields, "title", "Untitled"),
    columnId: readYMapValue(fields, "columnId", null),
    due: readYMapValue(fields, "due", null),
    assignee: String(readYMapValue(fields, "assignee", "") ?? ""),
    archived: Boolean(readYMapValue(fields, "archived", false)),
    labels,
    body: doc.getText("body").toString(),
  };
}

function materializeBoardCard(entry) {
  if (!(entry instanceof Y.Map)) return null;

  const labels = entry.get("labels");
  return {
    id: readYMapValue(entry, "id", ""),
    title: readYMapValue(entry, "title", ""),
    columnId: readYMapValue(entry, "columnId", null),
    rank: readYMapValue(entry, "rank", 0),
    due: readYMapValue(entry, "due", null),
    assignee: String(readYMapValue(entry, "assignee", "") ?? ""),
    labels: Array.isArray(labels) ? labels.map(String) : [],
    archived: Boolean(readYMapValue(entry, "archived", false)),
    updatedAt: readYMapValue(entry, "updatedAt", null),
  };
}

export function materializeBoard(doc) {
  const meta = doc.getMap("meta");
  const columns = doc.getArray("columns").toArray().map((col) => ({
    id: col?.id ?? "",
    name: col?.name ?? "",
  }));

  const cards = {};
  doc.getMap("cards").forEach((value, key) => {
    const card = materializeBoardCard(value);
    if (card) cards[key] = card;
  });

  return {
    id: readYMapValue(meta, "id", ""),
    name: readYMapValue(meta, "name", ""),
    archived: Boolean(readYMapValue(meta, "archived", false)),
    columns,
    cards,
  };
}

export function materializeCatalog(doc) {
  const boards = [];
  doc.getMap("boards").forEach((value) => {
    if (!(value instanceof Y.Map)) return;
    boards.push({
      id: readYMapValue(value, "id", ""),
      name: readYMapValue(value, "name", ""),
      archived: Boolean(readYMapValue(value, "archived", false)),
      createdAt: readYMapValue(value, "createdAt", null),
    });
  });
  return boards;
}

/** Write board-card summary fields onto a Y.Map without touching columnId or rank. */
export function applyCardSummaryToYMap(cardMap, summary) {
  if (summary.id !== undefined) cardMap.set("id", summary.id);
  if (summary.title !== undefined) cardMap.set("title", clampStoredTitle(summary.title));
  if (summary.due !== undefined) cardMap.set("due", clampDue(summary.due));
  if (summary.assignee !== undefined) cardMap.set("assignee", clampAssignee(summary.assignee));
  if (summary.labels !== undefined) cardMap.set("labels", clampLabels(summary.labels));
  if (typeof summary.archived === "boolean") cardMap.set("archived", summary.archived);
  cardMap.set("updatedAt", new Date().toISOString());
}
