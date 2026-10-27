import { readCookie, verifySession } from "./auth.js";
import { SESSION_COOKIE } from "./constants.js";

function authStub(env) {
  return env.AUTH_DO.get(env.AUTH_DO.idFromName("auth"));
}

/** Verify the session cookie signature and AuthDO generation counter. */
export async function readVerifiedSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const parsed = await verifySession(env.SESSION_SECRET, raw);
  if (!parsed) return null;

  const genResponse = await authStub(env).fetch(
    new Request(`https://do.internal/session/gen?email=${encodeURIComponent(parsed.email)}`),
  );
  if (!genResponse.ok) {
    await genResponse.body?.cancel();
    return null;
  }
  const { gen } = await genResponse.json();
  if (gen !== parsed.gen) return null;
  return parsed;
}
