export async function readJson(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { body: null, error: Response.json({ error: "Body must be JSON" }, { status: 400 }) };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      body: null,
      error: Response.json({ error: "Body must be a JSON object" }, { status: 400 }),
    };
  }
  return { body, error: null };
}
