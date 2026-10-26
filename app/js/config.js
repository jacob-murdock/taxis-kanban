/** Shared API + WebSocket path helpers. */

export const API = {
  boardWs: `${wsBase()}/api/board/ws`,
  jobWs: (id) => `${wsBase()}/api/jobs/${encodeURIComponent(id)}/ws`,
  jobHistory: (id) => `/api/jobs/${encodeURIComponent(id)}/history`,
  jobStatus: (id) => `/api/jobs/${encodeURIComponent(id)}/status`,
  createJob: "/api/jobs",
};

function wsBase() {
  const { protocol, host } = window.location;
  return protocol === "https:" ? `wss://${host}` : `ws://${host}`;
}
