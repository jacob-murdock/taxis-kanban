export function catalogStub(env) {
  return env.CATALOG_DO.get(env.CATALOG_DO.idFromName("catalog"));
}

export function boardStub(env, boardId) {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(boardId));
}

export function jobStub(env, cardId) {
  return env.JOB_DO.get(env.JOB_DO.idFromName(cardId));
}

export function requireUpgrade(request) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Response.json({ error: "Expected WebSocket upgrade" }, { status: 426 });
  }
  return null;
}

export function buildDoRequest(request, path, search) {
  const url = new URL(request.url);
  url.pathname = path;
  if (search) {
    for (const [key, value] of Object.entries(search)) {
      if (value != null) url.searchParams.set(key, value);
    }
  }
  return new Request(url.toString(), request);
}

export function jsonDoRequest(path, method, body) {
  return new Request(`https://do.internal${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function forwardToCatalog(env, request, path) {
  return catalogStub(env).fetch(buildDoRequest(request, path));
}

export function forwardToBoard(env, boardId, request, path) {
  return boardStub(env, boardId).fetch(buildDoRequest(request, path));
}

export function forwardToJob(env, cardId, request, path, search) {
  return jobStub(env, cardId).fetch(buildDoRequest(request, path, search));
}
