import { describe, expect, it } from "vitest";
import { formatHistoryEntry } from "../../app/js/history-format.js";

const now = Date.parse("2026-10-29T20:00:00.000Z");
const zone = { now, timeZone: "UTC" };

function entry(overrides) {
  return {
    ts: "2026-10-29T19:55:00.000Z",
    author: "ada@ex.com",
    field: "title",
    prev: "Old",
    next: "New",
    ...overrides,
  };
}

describe("formatHistoryEntry", () => {
  it("uses a relative time and a field label", () => {
    const formatted = formatHistoryEntry(entry(), zone);
    expect(formatted.relative).toBe("5 minutes ago");
    expect(formatted.datetime).toBe("2026-10-29T19:55:00.000Z");
    expect(formatted.author).toBe("ada@ex.com");
    expect(formatted.summary).toBe("Title: Old → New");
    expect(formatted.suffix).toBe(formatted.absolute);
    expect(formatted.absolute).toContain("2026");
  });

  it("says just now inside the skew window, then minutes, hours, and days", () => {
    expect(formatHistoryEntry(entry({ ts: "2026-10-29T19:59:20.000Z" }), zone).relative).toBe("just now");
    expect(formatHistoryEntry(entry({ ts: "2026-10-29T19:59:15.000Z" }), zone).relative).toBe("1 minute ago");
    expect(formatHistoryEntry(entry({ ts: "2026-10-29T19:58:00.000Z" }), zone).relative).toBe("2 minutes ago");
    expect(formatHistoryEntry(entry({ ts: "2026-10-29T19:00:00.000Z" }), zone).relative).toBe("1 hour ago");
    expect(formatHistoryEntry(entry({ ts: "2026-10-29T17:00:00.000Z" }), zone).relative).toBe("3 hours ago");
    expect(formatHistoryEntry(entry({ ts: "2026-10-28T20:00:00.000Z" }), zone).relative).toBe("yesterday");
    expect(formatHistoryEntry(entry({ ts: "2026-10-26T20:00:00.000Z" }), zone).relative).toBe("3 days ago");
  });

  it("shows a short date after a week and keeps the clock in the suffix", () => {
    const formatted = formatHistoryEntry(entry({ ts: "2026-10-22T20:00:00.000Z" }), zone);
    expect(formatted.relative).toMatch(/Oct 22, 2026/);
    expect(formatted.absolute.startsWith(formatted.relative)).toBe(true);
    expect(formatted.suffix).not.toBe(formatted.absolute);
    expect(formatted.absolute).toContain(formatted.suffix);
  });

  it("names columns, labels, archived, and notes without dumping the body", () => {
    const columns = [{ id: "col_1", name: "Doing" }];
    expect(formatHistoryEntry(entry({ field: "columnId", prev: null, next: "col_1" }), { ...zone, columns }).summary).toBe(
      "Column: empty → Doing",
    );
    expect(
      formatHistoryEntry(entry({ field: "columnId", prev: null, next: "col_missing" }), { ...zone, columns }).summary,
    ).toBe("Column: empty → col_missing");
    expect(
      formatHistoryEntry(
        entry({ field: "labels", prev: "[]", next: JSON.stringify(["bug", "ui"]) }),
        zone,
      ).summary,
    ).toBe("Labels: empty → bug, ui");
    expect(formatHistoryEntry(entry({ field: "archived", prev: "false", next: "true" }), zone).summary).toBe(
      "Archived: restored → archived",
    );
    expect(
      formatHistoryEntry(entry({ field: "body", prev: "a".repeat(400), next: "b".repeat(400) }), zone).summary,
    ).toBe("Updated the notes");
    expect(formatHistoryEntry(entry({ field: "due", prev: null, next: "2026-11-02" }), zone).summary).toBe(
      "Due: empty → 2026-11-02",
    );
  });

  it("drops the system author and keeps an unreadable timestamp as text", () => {
    expect(formatHistoryEntry(entry({ author: "system" }), zone).author).toBe("");
    const formatted = formatHistoryEntry(entry({ ts: "nope", prev: null, next: "A" }), zone);
    expect(formatted.datetime).toBe("");
    expect(formatted.relative).toBe("nope");
    expect(formatted.suffix).toBe("");
    expect(formatted.summary).toBe("Title: empty → A");
  });
});
