import {
  clearSessionCookieHeader,
  mintSessionCookie,
  normalizeEmail,
  randomTokenHex,
  safeNextPath,
  sha256Hex,
} from "../lib/auth.js";
import { appOrigin, applyBrowserGuards } from "../lib/csrf.js";
import { sendEmail } from "../lib/email.js";
import { readJson } from "../lib/json.js";
import { readVerifiedSession } from "../lib/session.js";
import { authStub, jsonDoRequest, revokeUserSockets } from "./do.js";

export async function routeAuth(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/auth/request" && method === "POST") {
    return requestMagicLink(request, env, ctx);
  }
  if (pathname === "/api/auth/callback" && method === "GET") {
    return callbackPage(request, env, url);
  }
  if (pathname === "/api/auth/consume" && method === "POST") {
    return consumeMagicLink(request, env, url);
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    return logout(request, env);
  }
  if (pathname === "/api/me" && method === "GET") {
    return me(request, env);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

function requireSecret(env) {
  if (!env.SESSION_SECRET) {
    return Response.json({ error: "Auth is not configured" }, { status: 500 });
  }
  return null;
}

async function requestMagicLink(request, env, ctx) {
  const misconfigured = requireSecret(env);
  if (misconfigured) return misconfigured;

  const { body, error } = await readJson(request);
  if (error) return error;

  const email = normalizeEmail(body.email);
  if (!email) return Response.json({ error: "Invalid email" }, { status: 400 });

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const token = randomTokenHex(32);
  const tokenHash = await sha256Hex(token);

  const storeResponse = await authStub(env).fetch(
    jsonDoRequest("/magic-links", "POST", { email, ip, tokenHash }),
  );
  if (!storeResponse.ok) {
    await storeResponse.body?.cancel();
    return Response.json({ error: "Auth store failed" }, { status: 500 });
  }
  const stored = await storeResponse.json();

  if (stored.minted) {
    const origin = appOrigin(request, env);
    const next = safeNextPath(body.next);
    const link = `${origin}/api/auth/callback?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
    const subject = "Sign in to Taxis Kanban";
    const text = `Sign in as ${email}:\n\n${link}\n\nThis link expires in 15 minutes and can only be used once.`;
    ctx.waitUntil(sendEmail(env, { to: email, subject, text }));
  }

  return Response.json({ ok: true });
}

async function callbackPage(request, env, url) {
  const misconfigured = requireSecret(env);
  if (misconfigured) {
    return htmlPage("Sign in unavailable", "<p>Auth is not configured on this server.</p>", 500);
  }

  const token = url.searchParams.get("token") || "";
  const next = safeNextPath(url.searchParams.get("next"));
  if (!token || !/^[0-9a-f]{64}$/i.test(token)) {
    return htmlPage("Link invalid", "<p>This sign-in link is invalid or incomplete.</p>", 400);
  }

  const tokenHash = await sha256Hex(token.toLowerCase());
  const peek = await authStub(env).fetch(
    new Request(`https://do.internal/magic-links/peek?tokenHash=${encodeURIComponent(tokenHash)}`),
  );
  if (peek.status === 404) {
    await peek.body?.cancel();
    return htmlPage(
      "Link expired",
      "<p>This sign-in link has expired or was already used. Request a new one from the app.</p>",
      410,
    );
  }
  if (!peek.ok) {
    await peek.body?.cancel();
    return htmlPage("Sign in unavailable", "<p>Something went wrong. Try again later.</p>", 502);
  }

  const { email } = await peek.json();
  const safeEmail = escapeHtml(email);

  const body = `
    <p>Continue as <strong>${safeEmail}</strong>?</p>
    <p class="tagline">Only continue if you meant to sign in on this device.</p>
    <button type="button" class="btn-primary" id="confirm">Sign in as ${safeEmail}</button>
    <p id="page-error" class="page-error" role="alert"></p>
    <script type="module">
      const token = ${scriptJson(token.toLowerCase())};
      const next = ${scriptJson(next)};
      const btn = document.getElementById("confirm");
      const err = document.getElementById("page-error");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        err.textContent = "";
        try {
          const response = await fetch("/api/auth/consume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ token, next }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(data?.error || "Sign-in failed");
          }
          const requested = data?.next || next || "/";
          const dest =
            typeof requested === "string" && requested.startsWith("/") && !requested.startsWith("//")
              ? requested
              : "/";
          location.replace(dest);
        } catch (e) {
          err.textContent = e.message || "Sign-in failed";
          btn.disabled = false;
        }
      });
    </script>
  `;
  return htmlPage("Confirm sign-in", body, 200);
}

async function consumeMagicLink(request, env, url) {
  const misconfigured = requireSecret(env);
  if (misconfigured) return misconfigured;

  const { body, error } = await readJson(request);
  if (error) return error;

  const token = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return Response.json({ error: "Invalid or expired link" }, { status: 400 });
  }
  const next = safeNextPath(body.next ?? url.searchParams.get("next"));

  const tokenHash = await sha256Hex(token);
  const consumed = await authStub(env).fetch(
    jsonDoRequest("/magic-links/consume", "POST", { tokenHash }),
  );
  if (consumed.status === 404) {
    await consumed.body?.cancel();
    return Response.json({ error: "Invalid or expired link" }, { status: 400 });
  }
  if (!consumed.ok) {
    await consumed.body?.cancel();
    return Response.json({ error: "Auth store failed" }, { status: 500 });
  }

  const { email, gen } = await consumed.json();
  const cookie = await mintSessionCookie(request, env, email, gen);
  if (!cookie) {
    return Response.json({ error: "Auth is not configured" }, { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, next }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
}

async function logout(request, env) {
  const misconfigured = requireSecret(env);
  if (misconfigured) return misconfigured;

  const session = await readVerifiedSession(request, env);
  if (session) {
    const bumped = await authStub(env).fetch(
      jsonDoRequest("/session/bump", "POST", { email: session.email }),
    );
    if (!bumped.ok) {
      await bumped.body?.cancel();
      return Response.json({ error: "Could not sign out" }, { status: 500 });
    }
    await bumped.body?.cancel();
    try {
      await revokeUserSockets(env, session.email);
    } catch (err) {
      console.error("revokeUserSockets failed", err);
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookieHeader(request),
    },
  });
}

async function me(request, env) {
  const misconfigured = requireSecret(env);
  if (misconfigured) return misconfigured;

  const session = await readVerifiedSession(request, env);
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cookie = await mintSessionCookie(request, env, session.email, session.gen);
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers["Set-Cookie"] = cookie;

  return new Response(JSON.stringify({ email: session.email }), { status: 200, headers });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON for an inline script. Escapes characters that would break out of the script element. */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function htmlPage(title, bodyHtml, status) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)} · Taxis Kanban</title>
  <script src="/js/theme.js"></script>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <header class="site-header">
    <div class="header-top">
      <nav><a href="/">← Boards</a></nav>
      <button type="button" class="btn theme-toggle" data-theme-toggle>Theme: system</button>
    </div>
    <h1>Taxis Kanban</h1>
    <p class="tagline">${escapeHtml(title)}</p>
  </header>
  <main class="stack auth-confirm">
    ${bodyHtml}
  </main>
</body>
</html>`;
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  applyBrowserGuards(headers);
  return new Response(html, { status, headers });
}
