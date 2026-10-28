import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { applyTextDiff, mapIndexThroughTextDiff } from "../../app/js/text-diff.js";

function docWith(text) {
  const doc = new Y.Doc();
  if (text) doc.getText("body").insert(0, text);
  return doc;
}

function exchange(a, b) {
  const forA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  const forB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  Y.applyUpdate(a, forA);
  Y.applyUpdate(b, forB);
}

describe("applyTextDiff", () => {
  it("leaves the document alone when the text is unchanged", () => {
    const doc = docWith("hello");
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    applyTextDiff(doc.getText("body"), "hello");
    expect(updates).toBe(0);
    expect(doc.getText("body").toString()).toBe("hello");
  });

  it("rewrites only the changed span", () => {
    const doc = docWith("hello world");
    applyTextDiff(doc.getText("body"), "hello there");
    expect(doc.getText("body").toString()).toBe("hello there");

    applyTextDiff(doc.getText("body"), "why hello there");
    expect(doc.getText("body").toString()).toBe("why hello there");

    applyTextDiff(doc.getText("body"), "why hello");
    expect(doc.getText("body").toString()).toBe("why hello");

    applyTextDiff(doc.getText("body"), "");
    expect(doc.getText("body").toString()).toBe("");
  });

  it("merges edits in different regions", () => {
    const a = docWith("hello world");
    const b = docWith("");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    applyTextDiff(a.getText("body"), "HELLO world");
    applyTextDiff(b.getText("body"), "hello WORLD");
    exchange(a, b);

    expect(a.getText("body").toString()).toBe("HELLO WORLD");
    expect(b.getText("body").toString()).toBe("HELLO WORLD");
  });
});

describe("mapIndexThroughTextDiff", () => {
  it("keeps a caret in the unchanged prefix and shifts one after the edit", () => {
    const prev = "hello world";
    const next = "hello there world";
    expect(mapIndexThroughTextDiff(0, prev, next)).toBe(0);
    // The insertion boundary stays put, so the caret remains before the new text.
    expect(mapIndexThroughTextDiff(6, prev, next)).toBe(6);
    expect(mapIndexThroughTextDiff(7, prev, next)).toBe(13);
    expect(mapIndexThroughTextDiff(11, prev, next)).toBe(17);
  });

  it("drops a caret inside the replaced span onto the end of the new span", () => {
    expect(mapIndexThroughTextDiff(3, "hello", "hi")).toBe(2);
    expect(mapIndexThroughTextDiff(5, "hello", "hi")).toBe(2);
    expect(mapIndexThroughTextDiff(0, "hello", "hi")).toBe(0);
  });

  it("clamps indexes outside the string", () => {
    expect(mapIndexThroughTextDiff(-4, "ab", "abc")).toBe(0);
    expect(mapIndexThroughTextDiff(50, "ab", "a")).toBe(1);
  });
});
