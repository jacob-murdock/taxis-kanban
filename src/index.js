import { AuthDO } from "./durable-objects/auth-do.js";
import { JobDO } from "./durable-objects/job-do.js";
import { BoardDO } from "./durable-objects/board-do.js";
import { CatalogDO } from "./durable-objects/catalog-do.js";
import { safeNextPath } from "./lib/auth.js";
import { BOARD_ID_RE, CARD_ID_RE } from "./lib/constants.js";
import { applyBrowserGuards, checkCsrf, checkWsOrigin } from "./lib/csrf.js";
import { safeDecode } from "./lib/path.js";
import { routeAuth } from "./routes/auth.js";
import { routeApi } from "./routes/boards.js";
import { boardStub, jobStub, requireRole } from "./routes/do.js";

const PAGE_SHELLS = new Set(["/board", "/board/", "/card", "/card/", "/board.html", "/card.html"]);

export { AuthDO, JobDO, BoardDO, CatalogDO };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/health") {
      return Response.json({ ok: true, service: "taxis-kanban" });
    }

    if (pathname.startsWith("/api/")) {
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const originError = checkWsOrigin(request, env);
        if (originError) return finishApi(originError);
      } else {
        const csrfError = checkCsrf(request, env);
        if (csrfError) return finishApi(csrfError);
      }

      const response =
        pathname === "/api/me" || pathname.startsWith("/api/auth/")
          ? await routeAuth(request, env, ctx, url)
          : await routeApi(request, env, url);
      return finishApi(response);
    }

    if (PAGE_SHELLS.has(pathname)) return notFound(env, url);

    const boardPage = pathname.match(/^\/b\/([^/]+)\/?$/);
    if (boardPage) {
      const boardId = safeDecode(boardPage[1]);
      if (!boardId || !BOARD_ID_RE.test(boardId)) return notFound(env, url);
      const denied = await denyUnlessViewer(request, env, boardId, url);
      if (denied) return denied;
      const state = await lookupStatus(boardStub(env, boardId), "/snapshot");
      if (state === "missing") return notFound(env, url);
      if (state === "error") return unavailable();
      return privatePage(await env.ASSETS.fetch(new Request(new URL("/board", url.origin), request)));
    }

    const cardPage = pathname.match(/^\/b\/([^/]+)\/c\/([^/]+)\/?$/);
    if (cardPage) {
      const boardId = safeDecode(cardPage[1]);
      const cardId = safeDecode(cardPage[2]);
      if (!boardId || !cardId || !BOARD_ID_RE.test(boardId) || !CARD_ID_RE.test(cardId)) {
        return notFound(env, url);
      }
      const denied = await denyUnlessViewer(request, env, boardId, url);
      if (denied) return denied;
      const boardState = await lookupStatus(boardStub(env, boardId), "/snapshot");
      if (boardState === "missing") return notFound(env, url);
      if (boardState === "error") return unavailable();
      const cardState = await lookupCard(env, boardId, cardId);
      if (cardState === "missing") return notFound(env, url);
      if (cardState === "error") return unavailable();
      return privatePage(await env.ASSETS.fetch(new Request(new URL("/card", url.origin), request)));
    }

    return withGuards(await env.ASSETS.fetch(request));
  },
};

/** Signed-out visitors go to sign-in. Members who cannot view the board get the same 404 as a missing one. */
async function denyUnlessViewer(request, env, boardId, url) {
  const gate = await requireRole(request, env, boardId, "viewer");
  if (!gate.error) return null;
  if (gate.error.status === 401) {
    await gate.error.body?.cancel();
    return redirectToSignIn(url);
  }
  if (gate.error.status === 403) {
    await gate.error.body?.cancel();
    return notFound(env, url);
  }
  await gate.error.body?.cancel();
  return unavailable();
}

function redirectToSignIn(url) {
  const next = safeNextPath(url.pathname);
  const dest = new URL("/", url.origin);
  if (next !== "/") dest.searchParams.set("next", next);
  const headers = new Headers({
    Location: dest.toString(),
    "Cache-Control": "no-store",
  });
  applyBrowserGuards(headers);
  return new Response(null, { status: 302, headers });
}

function finishApi(response) {
  if (response.status === 101) return response;
  return withNoStore(response);
}

function privatePage(response) {
  return withNoStore(response);
}

function withGuards(response) {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  applyBrowserGuards(headers);
  copySetCookie(response.headers, headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withNoStore(response) {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  applyBrowserGuards(headers);
  headers.set("Cache-Control", "no-store");
  copySetCookie(response.headers, headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function copySetCookie(from, to) {
  if (typeof from.getSetCookie !== "function") return;
  const cookies = from.getSetCookie();
  if (cookies.length && !to.has("Set-Cookie")) {
    for (const cookie of cookies) to.append("Set-Cookie", cookie);
  }
}

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
  applyBrowserGuards(headers);
  if (!asset.ok) {
    await asset.body?.cancel();
    const plain = new Headers({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    applyBrowserGuards(plain);
    return new Response("Not found", { status: 404, headers: plain });
  }
  return new Response(asset.body, { status: 404, headers });
}

function unavailable() {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  applyBrowserGuards(headers);
  return new Response("Unavailable", { status: 502, headers });
}
