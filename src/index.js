import { JobDO } from "./durable-objects/job-do.js";
import { BoardDO } from "./durable-objects/board-do.js";
import { CatalogDO } from "./durable-objects/catalog-do.js";
import { BOARD_ID_RE, CARD_ID_RE } from "./lib/constants.js";
import { safeDecode } from "./lib/path.js";
import { routeApi } from "./routes/boards.js";

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

    const boardPage = pathname.match(/^\/b\/([^/]+)\/?$/);
    if (boardPage) {
      const boardId = safeDecode(boardPage[1]);
      if (boardId && BOARD_ID_RE.test(boardId)) {
        return env.ASSETS.fetch(new Request(new URL("/board.html", url.origin), request));
      }
    }

    const cardPage = pathname.match(/^\/b\/([^/]+)\/c\/([^/]+)\/?$/);
    if (cardPage) {
      const boardId = safeDecode(cardPage[1]);
      const cardId = safeDecode(cardPage[2]);
      if (boardId && cardId && BOARD_ID_RE.test(boardId) && CARD_ID_RE.test(cardId)) {
        return env.ASSETS.fetch(new Request(new URL("/card.html", url.origin), request));
      }
    }

    return env.ASSETS.fetch(request);
  },
};
