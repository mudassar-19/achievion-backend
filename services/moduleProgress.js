// LB-1: ONE place that says how far a module is. Progress is always computed from its tasks (done / all),
// never from the stored Milestone.progress field (nothing keeps that one up to date).
import Task from "../models/Task.js";

export const pct = (done, total) => (total > 0 ? Math.round((done / total) * 100) : 0);

// Map of String(milestoneId) -> { done, total, pct } for these modules.
export async function moduleProgressByIds(milestoneIds) {
  if (!milestoneIds.length) return new Map();
  const rows = await Task.aggregate([
    { $match: { milestoneId: { $in: milestoneIds } } },
    { $group: { _id: "$milestoneId", total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } } } },
  ]);
  const out = new Map(rows.map((r) => [String(r._id), { done: r.done, total: r.total, pct: pct(r.done, r.total) }]));
  for (const id of milestoneIds) if (!out.has(String(id))) out.set(String(id), { done: 0, total: 0, pct: 0 });
  return out;
}

// Map of String(projectId) -> { done, total, pct } for these projects (Portfolio list, Garden and health read this).
export async function projectProgressByIds(projectIds) {
  if (!projectIds.length) return new Map();
  const rows = await Task.aggregate([
    { $match: { projectId: { $in: projectIds } } },
    { $group: { _id: "$projectId", total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ["$status", "Done"] }, 1, 0] } } } },
  ]);
  const out = new Map(rows.map((r) => [String(r._id), { done: r.done, total: r.total, pct: pct(r.done, r.total) }]));
  for (const id of projectIds) if (!out.has(String(id))) out.set(String(id), { done: 0, total: 0, pct: 0 });
  return out;
}

// Sets `progress` on lean milestone documents from their tasks (in place; returns the same array). The stored
// Milestone.progress field is never kept up to date, so no screen may show it.
export async function applyTaskProgress(milestones) {
  const list = milestones.filter(Boolean);
  const prog = await moduleProgressByIds(list.map((m) => m._id));
  for (const m of list) m.progress = prog.get(String(m._id)).pct;
  return milestones;
}
