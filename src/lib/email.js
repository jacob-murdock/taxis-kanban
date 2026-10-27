/**
 * Send a plain-text email via Resend when RESEND_API_KEY is set.
 * Otherwise log the message to the Worker console (local/dev, no domain needed).
 */
export async function sendEmail(env, { to, subject, text }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[email] to=${to} subject=${subject}\n${text}`);
    return { ok: true, mode: "log" };
  }

  const from = env.MAIL_FROM || "Taxis Kanban <onboarding@resend.dev>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`[email] Resend ${response.status}: ${detail}`);
    return { ok: false, mode: "resend", status: response.status };
  }

  await response.body?.cancel();
  return { ok: true, mode: "resend" };
}
