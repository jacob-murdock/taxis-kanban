import { describe, expect, it } from "vitest";
import { describeBoardChanges, describeCardChanges } from "../../app/js/change-summary.js";

function board(overrides = {}) {
  return {
    name: "Sprint",
    archived: false,
    columns: [
      { id: "todo", name: "To do" },
      { id: "doing", name: "Doing" },
    ],
    cards: [],
    ...overrides,
  };
}

function card(id, title, columnId, rank, extra = {}) {
  return {
    id,
    title,
    columnId,
    rank,
    due: null,
    assignee: "",
    labels: [],
    archived: false,
    ...extra,
  };
}

describe("describeBoardChanges", () => {
  it("is quiet when nothing that matters changed", () => {
    const prev = board({
      cards: [card("a", "Alpha", "todo", 1024)],
    });
    const next = board({
      cards: [card("a", "Alpha", "todo", 4096)],
    });
    expect(describeBoardChanges(prev, next)).toEqual([]);
  });

  it("describes board, column, and card edits", () => {
    const prev = board({
      cards: [
        card("a", "Alpha", "todo", 1),
        card("b", "Beta", "todo", 2),
        card("c", "Gamma", "doing", 1, { assignee: "Ada" }),
      ],
    });
    const next = board({
      name: "Next",
      columns: [
        { id: "doing", name: "Doing" },
        { id: "todo", name: "Ready" },
        { id: "done", name: "Done" },
      ],
      cards: [
        card("b", "Beta", "todo", 1),
        card("a", "Alpha", "todo", 2),
        card("c", "Gamma", "doing", 1, { assignee: "" }),
        card("d", "Delta", "done", 1),
      ],
    });

    expect(describeBoardChanges(prev, next)).toEqual([
      "Board renamed to Next",
      "Renamed column To do to Ready",
      "Added column Done",
      "Updated Gamma",
      "Added Delta to Done",
      "Moved Alpha below Beta in Ready",
    ]);
  });

  it("describes a column reorder on its own", () => {
    const prev = board();
    const next = board({
      columns: [
        { id: "doing", name: "Doing" },
        { id: "todo", name: "To do" },
      ],
    });
    expect(describeBoardChanges(prev, next)).toEqual(["Columns reordered"]);
  });

  it("describes moves, archive, restore, and removal", () => {
    const prev = board({
      cards: [
        card("a", "Alpha", "todo", 1),
        card("b", "Beta", "todo", 2),
      ],
    });
    const moved = board({
      cards: [
        card("a", "Alpha", "doing", 1),
        card("b", "Beta", "todo", 2),
      ],
    });
    expect(describeBoardChanges(prev, moved)).toEqual(["Moved Alpha to Doing"]);

    const archived = board({
      cards: [card("a", "Alpha", "todo", 1, { archived: true })],
    });
    expect(describeBoardChanges(board({ cards: [card("a", "Alpha", "todo", 1)] }), archived)).toEqual([
      "Archived Alpha",
    ]);

    const restored = board({
      cards: [card("a", "Alpha", "doing", 1)],
    });
    expect(describeBoardChanges(archived, restored)).toEqual(["Restored Alpha to Doing"]);

    expect(describeBoardChanges(prev, board())).toEqual(["Removed Alpha", "Removed Beta"]);
  });

  it("names a card that moved inside its column", () => {
    const prev = board({
      cards: [card("a", "Alpha", "todo", 1), card("b", "Beta", "todo", 2), card("c", "Gamma", "todo", 3)],
    });
    const down = board({
      cards: [card("b", "Beta", "todo", 1), card("c", "Gamma", "todo", 2), card("a", "Alpha", "todo", 3)],
    });
    expect(describeBoardChanges(prev, down)).toEqual(["Moved Alpha below Gamma in To do"]);

    const up = board({
      cards: [card("c", "Gamma", "todo", 1), card("a", "Alpha", "todo", 2), card("b", "Beta", "todo", 3)],
    });
    expect(describeBoardChanges(prev, up)).toEqual(["Moved Gamma above Alpha in To do"]);
  });

  it("falls back when more than one card changed places", () => {
    const prev = board({
      cards: [
        card("a", "Alpha", "todo", 1),
        card("b", "Beta", "todo", 2),
        card("c", "Gamma", "todo", 3),
        card("d", "Delta", "todo", 4),
      ],
    });
    const next = board({
      cards: [
        card("b", "Beta", "todo", 1),
        card("a", "Alpha", "todo", 2),
        card("d", "Delta", "todo", 3),
        card("c", "Gamma", "todo", 4),
      ],
    });
    expect(describeBoardChanges(prev, next)).toEqual(["Reordered To do"]);
  });

  it("renames a card without calling a rank change a reorder", () => {
    const prev = board({ cards: [card("a", "Alpha", "todo", 1, { labels: ["bug"] })] });
    const next = board({ cards: [card("a", "Alpine", "todo", 9, { labels: ["bug", "ui"] })] });
    expect(describeBoardChanges(prev, next)).toEqual(["Renamed Alpha to Alpine", "Updated Alpine"]);
  });
});

describe("describeCardChanges", () => {
  const columns = [{ id: "doing", name: "Doing" }];
  const prev = {
    title: "Alpha",
    columnId: "todo",
    assignee: "",
    due: null,
    labels: ["bug"],
    archived: false,
    body: "one",
  };

  it("summarizes remote field edits and skips the field being typed in", () => {
    const next = {
      ...prev,
      title: "Alpine",
      columnId: "doing",
      assignee: "Ada",
      due: "2026-11-01",
      labels: [],
      body: "two",
    };
    expect(describeCardChanges(prev, next, { columns })).toEqual([
      "Title is now Alpine",
      "Moved to Doing",
      "Assignee is now Ada",
      "Due date is now 2026-11-01",
      "Labels updated",
      "Notes updated",
    ]);
    expect(describeCardChanges(prev, next, { columns, skip: new Set(["title", "body"]) })).toEqual([
      "Moved to Doing",
      "Assignee is now Ada",
      "Due date is now 2026-11-01",
      "Labels updated",
    ]);
  });

  it("says when a value is cleared", () => {
    expect(
      describeCardChanges(
        { ...prev, assignee: "Ada", due: "2026-11-01" },
        { ...prev, assignee: "", due: null },
        { columns },
      ),
    ).toEqual(["Assignee cleared", "Due date cleared"]);
  });
});
