// Browser origins allowed by CORS and Socket.IO: CLIENT_URL (comma separated), else CLIENT_ORIGIN, else the local Vite dev server.
export const allowedOrigins = (env = process.env) => {
  const list = String(env.CLIENT_URL || env.CLIENT_ORIGIN || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return list.length ? list : ["http://localhost:5173"];
};

// GET /api/health: no login, no secrets; the Mongoose readyState by name.
const DB_STATES = ["disconnected", "connected", "connecting", "disconnecting"];
export const healthBody = (readyState, now = new Date()) => ({ status: "ok", db: DB_STATES[readyState] ?? "unknown", timestamp: now.toISOString() });
