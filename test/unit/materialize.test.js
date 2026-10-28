import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  BOARD_ID_RE,
  CARD_ID_RE,
  CARD_TITLE_MAX,
  COLUMN_ID_RE,
  DEFAULT_COLUMN_NAMES,
  LABEL_MAX_LENGTH,
} from "../../src/lib/constants.js";
import {
  applyCardSummaryToYMap,
  createEmptyBoardDoc,
  createEmptyCardDoc,
  generateBoardId,
  generateCardId,
  generateColumnId,
  materializeBoard,
  materializeCard,
  materializeCatalog,
} from "../../src/lib/materialize.js";

describe("ids", () => {
  it("mints board, card, and column ids", () => {
    expect(generateBoardId()).toMatch(BOARD_ID_RE);
    expect(generateCardId()).toMatch(CARD_ID_RE);
    expect(generateColumnId()).toMatch(COLUMN_ID_RE);
    expect(generateBoardId()).not.toBe(generateBoardId());
  });
});

describe("materializeCard", () => {
  it("reads fields, labels, and the body", () => {
    const doc = createEmptyCardDoc("card_1", "board_1");
    doc.getMap("fields").set("title", "Ship it");
    doc.getMap("fields").set("columnId", "col_1");
    doc.getMap("fields").set("due", "2026-10-28");
    doc.getMap("fields").set("assignee", "ada");
    doc.getMap("fields").set("archived", true);
    doc.getArray("labels").push(["bug"]);
    doc.getText("body").insert(0, "notes");

    expect(materializeCard(doc)).toEqual({
      id: "card_1",
      boardId: "board_1",
      title: "Ship it",
      columnId: "col_1",
      due: "2026-10-28",
      assignee: "ada",
      archived: true,
      labels: ["bug"],
      body: "notes",
    });
  });

  it("fills defaults when the maps are empty", () => {
    const doc = new Y.Doc();
    doc.getMap("fields");
    doc.getArray("labels");
    doc.getText("body");
    expect(materializeCard(doc)).toMatchObject({
      id: "",
      boardId: "",
      title: "Untitled",
      columnId: null,
      due: null,
      assignee: "",
      archived: false,
      labels: [],
      body: "",
    });
  });
});

describe("materializeBoard", () => {
  it("reads meta, columns, and card summaries", () => {
    const doc = createEmptyBoardDoc("board_1", "Roadmap");
    const columnId = doc.getArray("columns").get(0).id;
    const card = new Y.Map();
    card.set("id", "card_1");
    card.set("title", "One");
    card.set("columnId", columnId);
    card.set("rank", 1024);
    card.set("due", null);
    card.set("assignee", "");
    card.set("labels", ["a"]);
    card.set("archived", false);
    card.set("updatedAt", "2026-10-28T00:00:00.000Z");
    doc.getMap("cards").set("card_1", card);
    doc.getMap("cards").set("junk", "not a map");

    const board = materializeBoard(doc);
    expect(board.id).toBe("board_1");
    expect(board.name).toBe("Roadmap");
    expect(board.archived).toBe(false);
    expect(board.columns.map((column) => column.name)).toEqual(DEFAULT_COLUMN_NAMES);
    expect(board.cards.card_1).toMatchObject({
      id: "card_1",
      title: "One",
      columnId,
      rank: 1024,
      labels: ["a"],
    });
    expect(board.cards.junk).toBeUndefined();
  });
});

describe("materializeCatalog", () => {
  it("lists board rows and skips anything that is not a map", () => {
    const doc = new Y.Doc();
    const boards = doc.getMap("boards");
    const row = new Y.Map();
    row.set("id", "board_1");
    row.set("name", "Roadmap");
    row.set("archived", 1);
    row.set("createdAt", "t");
    boards.set("board_1", row);
    boards.set("bad", "nope");

    expect(materializeCatalog(doc)).toEqual([
      { id: "board_1", name: "Roadmap", archived: true, createdAt: "t" },
    ]);
  });
});

describe("applyCardSummaryToYMap", () => {
  it("writes summary fields and leaves placement alone", () => {
    const doc = new Y.Doc();
    const card = new Y.Map();
    doc.getMap("cards").set("card_1", card);
    card.set("columnId", "col_keep");
    card.set("rank", 1024);
    card.set("archived", false);

    const before = Date.now();
    applyCardSummaryToYMap(card, {
      id: "card_1",
      title: "  Hello  ",
      due: " tomorrow ",
      assignee: "  ada  ",
      labels: ["  bug ", "", 4, "x".repeat(LABEL_MAX_LENGTH + 5)],
      archived: "yes",
      columnId: "col_other",
      rank: 1,
    });

    expect(card.get("columnId")).toBe("col_keep");
    expect(card.get("rank")).toBe(1024);
    expect(card.get("title")).toBe("Hello");
    expect(card.get("due")).toBe("tomorrow");
    expect(card.get("assignee")).toBe("ada");
    expect(card.get("labels")).toEqual(["bug", "x".repeat(LABEL_MAX_LENGTH)]);
    expect(card.get("archived")).toBe(false);
    expect(Date.parse(card.get("updatedAt"))).toBeGreaterThanOrEqual(before);

    applyCardSummaryToYMap(card, {
      title: "x".repeat(CARD_TITLE_MAX + 10),
      archived: true,
    });
    expect(card.get("title")).toHaveLength(CARD_TITLE_MAX);
    expect(card.get("archived")).toBe(true);
  });
});
