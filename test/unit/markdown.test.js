import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../app/js/markdown.js";

function types(nodes, found = []) {
  for (const node of nodes) {
    found.push(node.type);
    if (node.children) types(node.children, found);
    if (node.items) for (const item of node.items) types(item, found);
  }
  return found;
}

describe("parseMarkdown", () => {
  it("parses paragraphs, emphasis, headings, lists, and fenced code", () => {
    const blocks = parseMarkdown(
      ["# Title", "", "A **bold** and *em* and `code` note.", "", "- one", "- two", "", "```", "x < y", "```"].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list", "code"]);
    expect(blocks[0]).toMatchObject({ level: 1 });
    expect(types(blocks[1].children)).toEqual(["text", "strong", "text", "text", "em", "text", "text", "code", "text"]);
    expect(blocks[2].items).toHaveLength(2);
    expect(blocks[3].text).toBe("x < y");
  });

  it("links http and https targets", () => {
    const blocks = parseMarkdown("See [docs](https://example.com/a) now.");
    const link = blocks[0].children.find((node) => node.type === "link");
    expect(link.href).toBe("https://example.com/a");
    expect(link.children).toEqual([{ type: "text", text: "docs" }]);
  });

  it("leaves javascript links and raw html as text", () => {
    const script = parseMarkdown("[click](javascript:alert(1))");
    expect(types(script)).not.toContain("link");
    expect(JSON.stringify(script)).toContain("javascript:alert(1)");

    const mixed = parseMarkdown("[x](JaVaScRiPt:alert(1))");
    expect(types(mixed)).not.toContain("link");
    expect(JSON.stringify(mixed)).toContain("JaVaScRiPt:alert(1)");

    const html = parseMarkdown("<script>alert(1)</script>");
    expect(html).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "<script>alert(1)</script>" }] },
    ]);
    expect(types(html)).not.toContain("link");
  });
});
