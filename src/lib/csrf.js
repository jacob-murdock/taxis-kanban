/** Origin + Content-Type checks for cookie-authenticated mutating /api requests. */

export function requestOrigin(request) {
  return new URL(request.url).origin;
}

/** Origins allowed for CSRF: the request's own origin, plus APP_URL when set. */
export function allowedOrigins(request, env) {
  const origins = new Set([requestOrigin(request)]);
  if (typeof env.APP_URL === "string" && env.APP_URL) {
    try {
      origins.add(new URL(env.APP_URL).origin);
    } catch {
      /* ignore bad APP_URL */
    }
  }
  return origins;
}

export function appOrigin(request, env) {
  if (typeof env.APP_URL === "string" && env.APP_URL) {
    try {
      return new URL(env.APP_URL).origin;
    } catch {
      /* fall through */
    }
  }
  return requestOrigin(request);
}

/**
 * For non-GET /api/* : Origin must match; Content-Type must be application/json
 * except DELETE with no body (exempt from the JSON check only).
 */
export function checkCsrf(request, env) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(request, env).has(origin)) {
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }

  if (method === "DELETE") {
    const ct = request.headers.get("Content-Type");
    if (!ct) return null;
  }

  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.startsWith("application/json")) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return null;
}

/** WebSocket upgrades must carry a matching Origin. */
export function checkWsOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(request, env).has(origin)) {
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }
  return null;
}

/** Clickjacking / sniffing guards for Worker-served responses. */
export function applyBrowserGuards(headers) {
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "no-referrer");
}
