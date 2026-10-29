/** Small markdown subset for the card notes preview.
 * Renders with DOM nodes only — never innerHTML. HTML in the source stays text.
 * Links are http(s) only.
 */

function safeHref(raw) {
  const href = String(raw ?? "").trim();
  if (!href) return null;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

function isBlockStart(line) {
  return (
    line.startsWith("```") ||
    /^#{1,3} /.test(line) ||
    /^[-*] /.test(line) ||
    /^\d+\. /.test(line)
  );
}

function parseInline(input) {
  const nodes = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (!buf) return;
    nodes.push({ type: "text", text: buf });
    buf = "";
  };

  while (i < input.length) {
    if (input.startsWith("**", i)) {
      const end = input.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        nodes.push({ type: "strong", children: parseInline(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (input[i] === "`") {
      const end = input.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ type: "code", text: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (input[i] === "*" && input[i + 1] !== "*") {
      let end = input.indexOf("*", i + 1);
      while (end !== -1 && input[end + 1] === "*") end = input.indexOf("*", end + 2);
      if (end !== -1 && end > i + 1) {
        flush();
        nodes.push({ type: "em", children: parseInline(input.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    if (input[i] === "[") {
      const close = input.indexOf("]", i + 1);
      const openParen = close !== -1 && input[close + 1] === "(" ? close + 1 : -1;
      const paren = openParen !== -1 ? input.indexOf(")", openParen + 1) : -1;
      if (paren !== -1) {
        const label = input.slice(i + 1, close);
        const href = safeHref(input.slice(openParen + 1, paren));
        flush();
        if (href) nodes.push({ type: "link", href, children: parseInline(label) });
        else nodes.push({ type: "text", text: input.slice(i, paren + 1) });
        i = paren + 1;
        continue;
      }
    }

    buf += input[i];
    i += 1;
  }

  flush();
  return nodes;
}

/** Parse markdown into a plain block tree. Safe to call without a document. */
export function parseMarkdown(source) {
  const text = String(source ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: parseInline(heading[2]),
      });
      i += 1;
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(parseInline(lines[i].slice(2)));
        i += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\d+\. /, "")));
        i += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join(" ")) });
  }

  return blocks;
}

function renderInlines(nodes) {
  return nodes.map((node) => {
    if (node.type === "text") return document.createTextNode(node.text);
    if (node.type === "code") {
      const code = document.createElement("code");
      code.textContent = node.text;
      return code;
    }
    if (node.type === "strong" || node.type === "em") {
      const el = document.createElement(node.type === "strong" ? "strong" : "em");
      el.append(...renderInlines(node.children || []));
      return el;
    }
    if (node.type === "link") {
      const href = safeHref(node.href);
      if (!href) {
        const span = document.createElement("span");
        span.append(...renderInlines(node.children || []));
        return span;
      }
      const link = document.createElement("a");
      link.href = href;
      link.rel = "noreferrer noopener";
      link.target = "_blank";
      link.append(...renderInlines(node.children || []));
      return link;
    }
    return document.createTextNode("");
  });
}

function renderBlock(block) {
  if (block.type === "heading") {
    // The page already uses h1 and h2. Keep notes headings below those.
    const level = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
    const heading = document.createElement(level);
    heading.append(...renderInlines(block.children || []));
    return heading;
  }
  if (block.type === "list") {
    const list = document.createElement(block.ordered ? "ol" : "ul");
    for (const item of block.items || []) {
      const li = document.createElement("li");
      li.append(...renderInlines(item));
      list.append(li);
    }
    return list;
  }
  if (block.type === "code") {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = block.text;
    pre.append(code);
    return pre;
  }
  const p = document.createElement("p");
  p.append(...renderInlines(block.children || []));
  return p;
}

/** Replace `root`'s children with the rendered notes. */
export function renderMarkdown(root, source) {
  root.replaceChildren(...parseMarkdown(source).map(renderBlock));
}
