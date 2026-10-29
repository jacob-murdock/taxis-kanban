import { describe, expect, it } from "vitest";
import { planCardNudge, planMoveToColumn, positionChoices } from "../../app/js/card-nudge.js";

const columns = [
  { id: "todo", name: "To do" },
  { id: "doing", name: "Doing" },
  { id: "done", name: "Done" },
];

function card(id, columnId, rank, extra = {}) {
  return { id, columnId, rank, archived: false, ...extra };
}

const cards = [
  card("a", "todo", 1),
  card("b", "todo", 2),
  card("c", "todo", 3),
  card("d", "doing", 1),
  card("e", "done", 1),
  card("z", "todo", 4, { archived: true }),
];

describe("planCardNudge", () => {
  it("moves up in front of the previous card and down past the next one", () => {
    expect(planCardNudge(columns, cards, "b", "ArrowUp")).toEqual({
      columnId: "todo",
      beforeId: "a",
    });
    expect(planCardNudge(columns, cards, "b", "ArrowDown")).toEqual({
      columnId: "todo",
      beforeId: null,
    });
    expect(planCardNudge(columns, cards, "a", "ArrowDown")).toEqual({
      columnId: "todo",
      beforeId: "c",
    });
  });

  it("names the edge when the card cannot move that way", () => {
    expect(planCardNudge(columns, cards, "a", "ArrowUp")).toEqual({
      blocked: "Already at the top of To do",
    });
    expect(planCardNudge(columns, cards, "c", "ArrowDown")).toEqual({
      blocked: "Already at the bottom of To do",
    });
    expect(planCardNudge(columns, cards, "a", "ArrowLeft")).toEqual({
      blocked: "Already in the first column",
    });
    expect(planCardNudge(columns, cards, "e", "ArrowRight")).toEqual({
      blocked: "Already in the last column",
    });
  });

  it("moves sideways to the same index, or the end of a shorter column", () => {
    expect(planCardNudge(columns, cards, "b", "ArrowRight")).toEqual({
      columnId: "doing",
      beforeId: null,
    });
    expect(planCardNudge(columns, cards, "a", "ArrowRight")).toEqual({
      columnId: "doing",
      beforeId: "d",
    });
    expect(planCardNudge(columns, cards, "d", "ArrowLeft")).toEqual({
      columnId: "todo",
      beforeId: "a",
    });
  });

  it("ignores archived and unknown cards", () => {
    expect(planCardNudge(columns, cards, "z", "ArrowUp")).toBeNull();
    expect(planCardNudge(columns, cards, "missing", "ArrowDown")).toBeNull();
    expect(planCardNudge(columns, cards, "a", "Enter")).toBeNull();
  });
});

describe("planMoveToColumn", () => {
  it("keeps the index in the destination column", () => {
    expect(planMoveToColumn(columns, cards, "c", "doing")).toEqual({
      columnId: "doing",
      beforeId: null,
    });
    expect(planMoveToColumn(columns, cards, "a", "done")).toEqual({
      columnId: "done",
      beforeId: "e",
    });
  });

  it("offers a before-card for each neighbor and the current slot", () => {
    const titled = [
      card("a", "todo", 1, { title: "Alpha" }),
      card("b", "todo", 2, { title: "Beta" }),
      card("c", "todo", 3, { title: "" }),
    ];
    expect(positionChoices(titled, "todo", "b")).toEqual({
      beforeId: "c",
      movable: true,
      options: [
        { value: "a", label: "Before Alpha" },
        { value: "c", label: "Before Untitled" },
        { value: "", label: "At the end" },
      ],
    });
    expect(positionChoices(titled, "todo", "c").beforeId).toBe("");
    expect(positionChoices([card("a", "todo", 1, { title: "Alpha" })], "todo", "a")).toEqual({
      beforeId: "",
      movable: false,
      options: [{ value: "", label: "Only card in this column" }],
    });
    expect(positionChoices(titled, null, "a").movable).toBe(false);
  });

  it("refuses the current column and unknown targets", () => {
    expect(planMoveToColumn(columns, cards, "a", "todo")).toEqual({
      blocked: "Already in To do",
    });
    expect(planMoveToColumn(columns, cards, "a", "nope")).toBeNull();
    expect(planMoveToColumn(columns, cards, "z", "doing")).toBeNull();
  });
});
