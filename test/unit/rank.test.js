import { describe, expect, it } from "vitest";
import {
  RANK_GAP,
  compareByRankThenId,
  rankAppend,
  rankInsertBefore,
  renumberRanks,
  sortByRankThenId,
} from "../../src/lib/rank.js";

describe("rankAppend", () => {
  it("starts a column at the gap and steps past the last rank", () => {
    expect(RANK_GAP).toBe(1024);
    expect(rankAppend(null)).toBe(RANK_GAP);
    expect(rankAppend(undefined)).toBe(RANK_GAP);
    expect(rankAppend("nope")).toBe(RANK_GAP);
    expect(rankAppend(0)).toBe(RANK_GAP);
    expect(rankAppend(RANK_GAP)).toBe(RANK_GAP * 2);
  });
});

describe("rankInsertBefore", () => {
  it("takes the midpoint, or null when the gap is gone", () => {
    expect(rankInsertBefore(null, RANK_GAP)).toBe(RANK_GAP / 2);
    expect(rankInsertBefore(RANK_GAP, RANK_GAP * 2)).toBe(RANK_GAP + RANK_GAP / 2);
    expect(rankInsertBefore(null, 2)).toBe(1);
    expect(rankInsertBefore(null, 1)).toBeNull();
    expect(rankInsertBefore(5, 6)).toBeNull();
    expect(rankInsertBefore(5, 7)).toBe(6);
    expect(rankInsertBefore(1, "nope")).toBeNull();
  });
});

describe("renumberRanks", () => {
  it("assigns fresh gap ranks in the given order", () => {
    const ranks = renumberRanks(["c", "a"]);
    expect(ranks.get("c")).toBe(RANK_GAP);
    expect(ranks.get("a")).toBe(RANK_GAP * 2);
    expect(renumberRanks([]).size).toBe(0);
  });
});

describe("sortByRankThenId", () => {
  it("orders by rank, then id, without mutating the input", () => {
    const cards = [
      { id: "b", rank: 1 },
      { id: "a", rank: 1 },
      { id: "c", rank: 0 },
    ];
    expect(sortByRankThenId(cards).map((card) => card.id)).toEqual(["c", "a", "b"]);
    expect(cards.map((card) => card.id)).toEqual(["b", "a", "c"]);
    expect(compareByRankThenId({ id: "a", rank: "10" }, { id: "b", rank: 2 })).toBeGreaterThan(0);
    expect(compareByRankThenId({ id: "b" }, { id: "a" })).toBeGreaterThan(0);
  });
});
