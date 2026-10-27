import {
  BOARD_ID_RE,
  CARD_ID_RE,
  EMAIL_MAX,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
} from "./constants.js";

const encoder = new TextEncoder();

/** Trim, lowercase, basic format. Rejects over EMAIL_MAX. Returns null if rejected. */
export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX) return null;
  // Local@domain with at least one dot in the domain; no spaces.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function randomTokenHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Sign session payload. Cookie value: v1.<email>.<gen>.<exp>.<sig> */
export async function signSession(secret, email, gen, exp) {
  const payload = `v1.${email}.${gen}.${exp}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${payload}.${toBase64Url(sig)}`;
}

/**
 * Verify cookie value with crypto.subtle.verify (constant-time).
 * Returns { email, gen, exp } or null.
 */
export async function verifySession(secret, cookieValue) {
  if (typeof cookieValue !== "string" || !cookieValue.startsWith("v1.")) return null;
  const parts = cookieValue.split(".");
  // v1 / email… / gen / exp / sig  — email may contain dots, so parse from the right.
  if (parts.length < 5) return null;
  const sig = parts[parts.length - 1];
  const expRaw = parts[parts.length - 2];
  const genRaw = parts[parts.length - 3];
  const email = parts.slice(1, -3).join(".");
  if (!email || !/^\d+$/.test(genRaw) || !/^\d+$/.test(expRaw) || !sig) return null;

  const gen = Number(genRaw);
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(gen) || gen < 0) return null;
  if (!Number.isSafeInteger(exp) || exp <= 0) return null;

  let sigBytes;
  try {
    sigBytes = fromBase64Url(sig);
  } catch {
    return null;
  }

  const payload = `v1.${email}.${gen}.${exp}`;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
  if (!ok) return null;
  // Check expiry after the MAC so a bad signature and an expired one take the same path.
  if (exp * 1000 <= Date.now()) return null;
  return { email, gen, exp };
}

export function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** Secure cookies are ignored on plain HTTP, so only mark them when the request is https. */
function cookieSecureFlag(request) {
  return new URL(request.url).protocol === "https:";
}

export function sessionCookieHeader(request, value, maxAgeSec = SESSION_TTL_SEC) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSec}`,
  ];
  if (cookieSecureFlag(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(request) {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (cookieSecureFlag(request)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Post-login path. Only `/`, an invite URL, or a board/card page.
 * Anything else (other origins, backslashes, markup) becomes "/".
 * Keep in sync with `safeNextPath` in app/js/config.js.
 */
export function safeNextPath(raw) {
  if (typeof raw !== "string") return "/";
  const next = raw.trim();
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  if (/[\u0000-\u001F\u007F\\]/.test(next)) return "/";

  let url;
  try {
    url = new URL(next, "https://taxis.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://taxis.local" || url.username || url.password) return "/";

  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") return "/";

  if (path === "/invite") {
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== "token")) return "/";
    const token = (url.searchParams.get("token") || "").toLowerCase();
    if (!token) return "/invite";
    if (!/^[0-9a-f]{64}$/.test(token)) return "/";
    return `/invite?token=${token}`;
  }

  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "b") return "/";
  if (parts.length === 2 && BOARD_ID_RE.test(parts[1])) return `/b/${parts[1]}`;
  if (
    parts.length === 4 &&
    parts[2] === "c" &&
    BOARD_ID_RE.test(parts[1]) &&
    CARD_ID_RE.test(parts[3])
  ) {
    return `/b/${parts[1]}/c/${parts[3]}`;
  }
  return "/";
}

export async function mintSessionCookie(request, env, email, gen) {
  const secret = env.SESSION_SECRET;
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const value = await signSession(secret, email, gen, exp);
  return sessionCookieHeader(request, value);
}
