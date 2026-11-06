import PerformanceLog from "../models/PerformanceLog.js";

const ALLOWED_ACTIONS = new Set([
  "login",
  "dashboard_load",
  "create_task",
  "move_task",
  "submit_task",
  "open_portfolio",
]);

// ── POST /api/perf/log ────────────────────────────────────────────────────────
// Accepts: { action, durationMs, page }
// Any authenticated user may post. userId + orgId come from token.
export async function createPerfLog(req, res) {
  const { id: userId, orgId } = req.user;
  const { action, durationMs, page } = req.body;

  if (!action || typeof action !== "string")
    return res.status(400).json({ error: "action is required." });
  if (!ALLOWED_ACTIONS.has(action))
    return res.status(400).json({ error: `action must be one of: ${[...ALLOWED_ACTIONS].join(", ")}.` });
  if (typeof durationMs !== "number" || durationMs < 0)
    return res.status(400).json({ error: "durationMs must be a non-negative number." });

  await PerformanceLog.create({
    userId,
    orgId,
    action:     action.slice(0, 100),
    durationMs,
    page:       page   ? String(page).slice(0, 200)                  : null,
    userAgent:  req.headers["user-agent"] ? req.headers["user-agent"].slice(0, 300) : null,
  });

  res.status(201).json({ ok: true });
}
