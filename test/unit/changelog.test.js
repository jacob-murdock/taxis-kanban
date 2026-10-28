import { describe, expect, it } from "vitest";
import { diffCardSnapshots } from "../../src/lib/changelog.js";

const base = {
  id: "card_1",
  title: "Untitled",
  columnId: "col_1",
  due: null,
  assignee: "",
  labels: [],
  archived: false,
  body: "",
};

describe("diffCardSnapshots", () => {
  it("returns nothing when the tracked fields match", () => {
    expect(diffCardSnapshots(base, { ...base, id: "other" })).toEqual([]);
  });

  it("treats an empty string and null as the same empty value", () => {
    expect(diffCardSnapshots(base, { ...base, due: "", assignee: "" })).toEqual([]);
  });

  it("records each changed field in tracked order", () => {
    const next = {
      ...base,
      title: "Ship it",
      columnId: "col_2",
      due: "2026-10-28",
      assignee: "ada",
      labels: ["bug", "now"],
      archived: true,
      body: "notes",
    };
    expect(diffCardSnapshots(base, next)).toEqual([
      { field: "title", prev: "Untitled", next: "Ship it" },
      { field: "columnId", prev: "col_1", next: "col_2" },
      { field: "due", prev: null, next: "2026-10-28" },
      { field: "assignee", prev: null, next: "ada" },
      { field: "labels", prev: "[]", next: '["bug","now"]' },
      { field: "archived", prev: "false", next: "true" },
      { field: "body", prev: null, next: "notes" },
    ]);
  });

  it("treats label order as part of the value", () => {
    const prev = { ...base, labels: ["a", "b"] };
    const next = { ...base, labels: ["b", "a"] };
    expect(diffCardSnapshots(prev, next)).toEqual([
      { field: "labels", prev: '["a","b"]', next: '["b","a"]' },
    ]);
    expect(diffCardSnapshots(prev, { ...prev })).toEqual([]);
  });

  it("stores an empty previous value as null", () => {
    expect(
      diffCardSnapshots(
        { ...base, title: "" },
        { ...base, title: "A" },
      ),
    ).toEqual([{ field: "title", prev: null, next: "A" }]);
  });
});
