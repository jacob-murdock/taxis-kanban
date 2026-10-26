import { JobDO } from "./durable-objects/job-do.js";
import { BoardDO } from "./durable-objects/board-do.js";
import { WORKSPACE_ID } from "./lib/constants.js";
import { generateJobId } from "./lib/materialize.js";

export { JobDO, BoardDO };

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    // --- API: board ---
    if (url.pathname === "/api/board/ws") {
      return forwardToBoard(env, request, "/ws");
    }
    if (url.pathname === "/api/board/snapshot") {
      return forwardToBoard(env, request, "/snapshot");
    }

    // --- API: jobs collection ---
    if (url.pathname === "/api/jobs" && request.method === "POST") {
      return createJob(request, env);
    }

    // --- API: single job ---
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(\/.*)?$/);
    if (jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      const suffix = jobMatch[2] ?? "";

      if (suffix === "/ws") {
        return forwardToJob(env, jobId, request, "/ws");
      }
      if (suffix === "/snapshot") {
        return forwardToJob(env, jobId, request, "/snapshot");
      }
      if (suffix === "/history") {
        return forwardToJob(env, jobId, request, "/history");
      }
      if (suffix === "/status" && request.method === "POST") {
        return forwardToJob(env, jobId, request, "/status");
      }
    }

    // --- Health check ---
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "taxis-kanban" });
    }

    // --- Frontend routes ---
    if (url.pathname === "/job" || url.pathname === "/job/") {
      return env.ASSETS.fetch(new Request(new URL("/job.html", url.origin), request));
    }

    // --- Static frontend (SPA fallback via [assets]) ---
    return env.ASSETS.fetch(request);
  },
};

async function forwardToBoard(env, request, path) {
  const id = env.BOARD_DO.idFromName(WORKSPACE_ID);
  const stub = env.BOARD_DO.get(id);
  return stub.fetch(buildDoRequest(request, path));
}

async function forwardToJob(env, jobId, request, path) {
  const id = env.JOB_DO.idFromName(jobId);
  const stub = env.JOB_DO.get(id);
  return stub.fetch(buildDoRequest(request, path));
}

function buildDoRequest(request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  return new Request(url.toString(), request);
}

async function createJob(request, env) {
  const body = await request.json();
  const jobId = generateJobId();
  const slug = body.slug ?? slugify(body.title ?? "untitled");
  const title = body.title ?? "Untitled Job";

  const jobStub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
  const initResponse = await jobStub.fetch(
    new Request("https://do.internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: jobId, slug, title }),
    }),
  );
  if (!initResponse.ok) {
    return Response.json({ error: "Failed to initialize job" }, { status: 500 });
  }

  const boardStub = env.BOARD_DO.get(env.BOARD_DO.idFromName(WORKSPACE_ID));
  const cardResponse = await boardStub.fetch(
    new Request("https://do.internal/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: jobId, slug, title }),
    }),
  );
  if (!cardResponse.ok) {
    return Response.json({ error: "Failed to add board card" }, { status: 500 });
  }

  return Response.json({ id: jobId, slug, title }, { status: 201 });
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
