import { JobDO } from "./durable-objects/job-do.js";
import { BoardDO } from "./durable-objects/board-do.js";
import { CatalogDO } from "./durable-objects/catalog-do.js";
import { BOARD_ID_RE, CARD_ID_RE } from "./lib/constants.js";
import { safeDecode } from "./lib/path.js";
import { routeApi } from "./routes/boards.js";
import { boardStub, jobStub } from "./routes/do.js";

const PAGE_SHELLS = new Set(["/board", "/board/", "/card", "/card/", "/board.html", "/card.html"]);

export { JobDO, BoardDO, CatalogDO };

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/health") {
      return Response.json({ ok: true, service: "taxis-kanban" });
    }

    if (pathname.startsWith("/api/")) {
      return routeApi(request, env, url);
    }

    if (PAGE_SHELLS.has(pathname)) return notFound(env, url);

    const boardPage = pathname.match(/^\/b\/([^/]+)\/?$/);
    if (boardPage) {
      const boardId = safeDecode(boardPage[1]);
      if (!boardId || !BOARD_ID_RE.test(boardId)) return notFound(env, url);
      const state = await lookupStatus(boardStub(env, boardId), "/snapshot");
      if (state === "missing") return notFound(env, url);
      if (state === "error") return unavailable();
      // Extensionless: wrangler redirects /board.html to /board.
      return env.ASSETS.fetch(new Request(new URL("/board", url.origin), request));
    }

    const cardPage = pathname.match(/^\/b\/([^/]+)\/c\/([^/]+)\/?$/);
    if (cardPage) {
      const boardId = safeDecode(cardPage[1]);
      const cardId = safeDecode(cardPage[2]);
      if (!boardId || !cardId || !BOARD_ID_RE.test(boardId) || !CARD_ID_RE.test(cardId)) {
        return notFound(env, url);
      }
      const boardState = await lookupStatus(boardStub(env, boardId), "/snapshot");
      if (boardState === "missing") return notFound(env, url);
      if (boardState === "error") return unavailable();
      const cardState = await lookupCard(env, boardId, cardId);
      if (cardState === "missing") return notFound(env, url);
      if (cardState === "error") return unavailable();
      return env.ASSETS.fetch(new Request(new URL("/card", url.origin), request));
    }

    return env.ASSETS.fetch(request);
  },
};

async function lookupStatus(stub, path) {
  try {
    const response = await stub.fetch(new Request(`https://do.internal${path}`));
    const { status } = response;
    await response.body?.cancel();
    if (status === 404) return "missing";
    if (status < 200 || status >= 300) return "error";
    return "ok";
  } catch (err) {
    console.error("Board lookup failed", err);
    return "error";
  }
}

async function lookupCard(env, boardId, cardId) {
  try {
    const response = await jobStub(env, cardId).fetch(
      new Request("https://do.internal/snapshot", { method: "GET" }),
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return "missing";
    }
    if (!response.ok) {
      await response.body?.cancel();
      return "error";
    }
    const card = await response.json();
    return card.boardId === boardId ? "ok" : "missing";
  } catch (err) {
    console.error("Card lookup failed", err);
    return "error";
  }
}

async function notFound(env, url) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/404.html", url.origin)));
  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (!asset.ok) {
    await asset.body?.cancel();
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new Response(asset.body, { status: 404, headers });
}

function unavailable() {
  return new Response("Unavailable", {
    status: 502,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
