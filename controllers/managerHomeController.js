// Manager portal Home + Inbox actions (V2 Phase 3 · M-1, UX §3-4).
import mongoose     from "mongoose";
import Organization from "../models/Organization.js";
import Project      from "../models/Project.js";
import Task         from "../models/Task.js";
import Sprint       from "../models/Sprint.js";
import Quest        from "../models/Quest.js";
import User         from "../models/User.js";
import XpLog        from "../models/XpLog.js";
import Notification from "../models/Notification.js";
import GamificationProfile from "../models/GamificationProfile.js";
import { createNotification } from "./notificationController.js";
import { healthForProjects } from "../services/projectHealthService.js";

const DAY = 86_400_000;
const IS_OID = /^[0-9a-f]{24}$/i;
const CLOSED = ["Completed", "Archived", "Deleted"];
const LEADERS = ["Director", "Manager"]; // no personal XP for them (D-081)

// ── GET /api/manager/home ─────────────────────────────────────────────────────
// One call for the Dashboard cards. Overloaded members come from /workforce (same rule as Resources).
export async function getHome(req, res) {
  const { orgId } = req.user;
  const now = new Date(), weekEnd = new Date(+now + 7 * DAY), weekAgo = new Date(+now - 7 * DAY), twoWeeksAgo = new Date(+now - 14 * DAY);

  const [org, members] = await Promise.all([
    Organization.findOne(IS_OID.test(orgId) ? { _id: orgId } : { orgId }, "_id orgId").lean(),
    User.find({ orgId, status: { $ne: "deleted" }, role: { $nin: LEADERS } }, "_id").lean(),
  ]);
  const orgIds = org ? [String(org._id), ...(org.orgId ? [org.orgId] : [])] : [orgId];
  const memberIds = members.map((m) => m._id);

  const [projects, taskAgg, dueTasks, sprints, xpAgg, activeStreaks, flagAgg, runningChallenges] = await Promise.all([
    Project.find({ orgId: { $in: orgIds }, isDeleted: { $ne: true } }, "title status priority deadline startDate createdAt").lean(),
    Task.aggregate([
      { $match: { orgId, isDeleted: { $ne: true } } },
      { $group: {
        _id: null,
        pending: { $sum: { $cond: [{ $in: ["$status", ["Backlog", "To-Do"]] }, 1, 0] } },
        active:  { $sum: { $cond: [{ $in: ["$status", ["In-Progress", "In-Review"]] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $and: [{ $ne: ["$status", "Done"] }, { $ne: ["$deadline", null] }, { $lt: ["$deadline", now] }] }, 1, 0] } },
      } },
    ]),
    Task.find({ orgId, status: { $ne: "Done" }, deadline: { $gte: now, $lte: weekEnd } }, "title deadline projectId")
      .sort({ deadline: 1 }).limit(50).lean(),
    Sprint.find({ orgId: { $in: orgIds }, status: "Active" }, "name endDate projectId tasks").populate("tasks", "status").lean(),
    XpLog.aggregate([
      { $match: { userId: { $in: memberIds }, createdAt: { $gte: twoWeeksAgo } } },
      { $group: { _id: { $cond: [{ $gte: ["$createdAt", weekAgo] }, "this", "last"] }, xp: { $sum: "$amount" } } },
    ]),
    GamificationProfile.countDocuments({ userId: { $in: memberIds }, "streaks.daily": { $gt: 0 } }),
    // M-5: open anomaly flags (same records as the Anomalies screen)
    Task.aggregate([{ $match: { orgId: { $in: orgIds }, "reviewFlags.0": { $exists: true } } }, { $unwind: "$reviewFlags" }, { $match: { "reviewFlags.status": "open" } }, { $count: "n" }]),
    Quest.countDocuments({ orgId: { $in: orgIds }, status: "active" }),
  ]);

  const open = projects.filter((p) => !CLOSED.includes(p.status));
  const health = await healthForProjects(open, now);
  const projectTitle = Object.fromEntries(projects.map((p) => [String(p._id), p.title]));
  const xp = Object.fromEntries(xpAgg.map((r) => [r._id, r.xp]));
  const t = taskAgg[0] ?? { pending: 0, active: 0, overdue: 0 };

  res.json({
    isNewOrg: projects.length === 0,
    projects: open.map((p) => ({ id: p._id, title: p.title, status: p.status, deadline: p.deadline ?? null, ...pick(health.get(String(p._id))) }))
      .sort((a, b) => (a.healthScore ?? 101) - (b.healthScore ?? 101)), // "Not started" (no score) goes last
    tasks: { pending: t.pending, active: t.active, overdue: t.overdue },
    deadlinesThisWeek: {
      tasks: dueTasks.length,
      projects: open.filter((p) => p.deadline && p.deadline >= now && p.deadline <= weekEnd).map((p) => ({ id: p._id, title: p.title, deadline: p.deadline })),
      next: dueTasks.slice(0, 5).map((x) => ({ id: x._id, title: x.title, deadline: x.deadline, project: projectTitle[String(x.projectId)] ?? null })),
    },
    sprints: sprints.map((s) => {
      const total = s.tasks?.length ?? 0, done = (s.tasks ?? []).filter((x) => x?.status === "Done").length;
      return { id: s._id, name: s.name, endDate: s.endDate ?? null, done, total, pct: total ? Math.round((done / total) * 100) : 0 };
    }),
    teamActivity: { xpThisWeek: xp.this ?? 0, xpLastWeek: xp.last ?? 0, activeStreaks },
    openAnomalies: flagAgg[0]?.n ?? 0,
    runningChallenges,
  });
}
const pick = (h) => ({ healthScore: h ? h.score : 100, healthBand: h?.band ?? "On track", progressPct: h?.progressPct ?? 0, overdueTasks: h?.overdue ?? 0 });

// ── POST /api/manager/tasks/:id/nudge ─────────────────────────────────────────
// In Review is read-only for Managers (TL approves, D-027); they can remind the Team Lead.
export async function nudgeReviewer(req, res) {
  const { orgId, id: managerId, name } = req.user;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Task not found." });
  const task = await Task.findOne({ _id: req.params.id, orgId }, "title status projectId").lean();
  if (!task) return res.status(404).json({ error: "Task not found." });
  if (task.status !== "In-Review") return res.status(409).json({ error: "This task is no longer waiting for review." });

  const recent = await Notification.exists({ type: "review_nudge", "meta.taskId": task._id, createdAt: { $gte: new Date(Date.now() - 60 * 60_000) } });
  if (recent) return res.status(429).json({ error: "The Team Lead was already reminded in the last hour." });

  const project = task.projectId ? await Project.findById(task.projectId, "members").lean() : null;
  let leads = project ? await User.find({ _id: { $in: project.members ?? [] }, role: "Team Lead", status: { $ne: "deleted" } }, "_id").lean() : [];
  if (!leads.length) leads = await User.find({ orgId, role: "Team Lead", status: "active" }, "_id").lean();
  if (!leads.length) return res.status(409).json({ error: "No Team Lead to remind for this task." });

  await Promise.all(leads.map((l) => createNotification({
    userId: l._id, orgId, type: "review_nudge", title: "Review reminder",
    message: `${name ?? "Your Manager"} asks you to review "${task.title}".`,
    meta: { taskId: task._id, by: managerId },
  })));
  res.json({ ok: true, notified: leads.length });
}
