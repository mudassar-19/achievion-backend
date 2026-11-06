// Computed project health for many projects in two aggregates (D-077). Every reader of
// project health goes through here so no screen shows the stored default.
import Task from "../models/Task.js";
import { projectHealth } from "./projectHealth.js";

// projects: [{ _id, startDate?, createdAt?, deadline? }] → Map(id → { score, band, total, done, overdue, progressPct })
export async function healthForProjects(projects, now = new Date()) {
  const ids = projects.map((p) => p._id);
  const out = new Map();
  if (!ids.length) return out;
  const [byStatus, overdue] = await Promise.all([
    Task.aggregate([
      { $match: { projectId: { $in: ids } } },
      { $group: { _id: { p: "$projectId", s: "$status" }, n: { $sum: 1 } } },
    ]),
    Task.aggregate([
      { $match: { projectId: { $in: ids }, status: { $ne: "Done" }, deadline: { $lt: now } } },
      { $group: { _id: "$projectId", n: { $sum: 1 } } },
    ]),
  ]);
  const counts = {};
  for (const r of byStatus) {
    const c = (counts[String(r._id.p)] ??= { total: 0, done: 0, byStatus: {} });
    c.total += r.n; c.byStatus[r._id.s] = r.n;
    if (r._id.s === "Done") c.done += r.n;
  }
  const od = Object.fromEntries(overdue.map((r) => [String(r._id), r.n]));
  for (const p of projects) {
    const id = String(p._id);
    const c = counts[id] ?? { total: 0, done: 0, byStatus: {} };
    const progressPct = c.total ? (c.done / c.total) * 100 : 0;
    const h = projectHealth({ startDate: p.startDate ?? p.createdAt, deadline: p.deadline, now, progressPct, openTasks: c.total - c.done, overdueTasks: od[id] ?? 0, totalTasks: c.total });
    out.set(id, { score: h.score, band: h.band, total: c.total, done: c.done, overdue: od[id] ?? 0, byStatus: c.byStatus, progressPct: Math.round(progressPct) });
  }
  return out;
}
