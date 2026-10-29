import { afterEach, describe, expect, it, vi } from "vitest";
import { createRosterAnnouncer, peerRosterNotes } from "../../app/js/peer-roster.js";

function roster(entries) {
  return new Map(entries);
}

describe("peerRosterNotes", () => {
  it("names joins and leaves against the previous roster", () => {
    const previous = roster([
      ["ada@x", "Ada"],
      ["bea@x", "Bea"],
    ]);
    const next = roster([
      ["bea@x", "Bea"],
      ["cy@x", "Cy"],
    ]);
    expect(peerRosterNotes(previous, next)).toEqual(["Cy joined", "Ada left"]);
  });

  it("is quiet when there is no baseline yet", () => {
    expect(peerRosterNotes(null, roster([["ada@x", "Ada"]]))).toEqual([]);
  });
});

describe("createRosterAnnouncer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function settled(entries) {
    const notes = [];
    const announcer = createRosterAnnouncer((note) => notes.push(note), {
      ready: Promise.resolve(),
      quietMs: 400,
      maxWaitMs: 1200,
    });
    announcer.see(roster(entries));
    await vi.advanceTimersByTimeAsync(400);
    return { notes, announcer };
  }

  it("does not announce people who were already here when the room opened", async () => {
    vi.useFakeTimers();
    const { notes, announcer } = await settled([
      ["ada@x", "Ada"],
      ["bea@x", "Bea"],
    ]);
    expect(notes).toEqual([]);
    announcer.see(roster([
      ["ada@x", "Ada"],
      ["bea@x", "Bea"],
      ["cy@x", "Cy"],
    ]));
    expect(notes).toEqual(["Cy joined"]);
    announcer.destroy();
  });

  it("waits out a burst that arrives just after ready", async () => {
    vi.useFakeTimers();
    const notes = [];
    const announcer = createRosterAnnouncer((note) => notes.push(note), {
      ready: Promise.resolve(),
      quietMs: 400,
      maxWaitMs: 1200,
    });
    announcer.see(roster([]));
    await vi.advanceTimersByTimeAsync(200);
    announcer.see(roster([["ada@x", "Ada"]]));
    await vi.advanceTimersByTimeAsync(200);
    expect(notes).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(notes).toEqual([]);
    announcer.see(roster([]));
    expect(notes).toEqual(["Ada left"]);
    announcer.destroy();
  });

  it("does not lock the baseline before the room is ready", async () => {
    vi.useFakeTimers();
    let open;
    const ready = new Promise((resolve) => {
      open = resolve;
    });
    const notes = [];
    const announcer = createRosterAnnouncer((note) => notes.push(note), {
      ready,
      quietMs: 400,
      maxWaitMs: 1200,
    });
    announcer.see(roster([["ada@x", "Ada"]]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(notes).toEqual([]);
    open();
    await vi.advanceTimersByTimeAsync(400);
    expect(notes).toEqual([]);
    announcer.see(roster([]));
    expect(notes).toEqual(["Ada left"]);
    announcer.destroy();
  });

  it("ignores updates after destroy", async () => {
    vi.useFakeTimers();
    const { notes, announcer } = await settled([["ada@x", "Ada"]]);
    announcer.destroy();
    announcer.see(roster([]));
    expect(notes).toEqual([]);
  });
});
