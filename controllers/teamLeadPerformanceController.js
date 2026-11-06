// Team Lead Performance, My stats, Announcements (T-5, D-144..D-146; UX TL v4 §11, §12, §14; FR10-03/05, TL-11, TL-13).
// Numbers come from the Manager's report builders (M-6) with ctx.teamIds, so a TL sees only their own team and the same
// formulas as the Manager. Read-only.
import mongoose from "mongoose";
import Task from "../models/Task.js";
import User from "../models/User.js";
import Sprint from "../models/Sprint.js";
import Milestone from "../models/Milestone.js";
import XpLog from "../models/XpLog.js";
import GamificationProfile from "../models/GamificationProfile.js";
import ChatChannel from "../models/ChatChannel.js";
import ChatMessage from "../models/ChatMessage.js";
import { tlScope, projectIn } from "./teamLeadWorkController.js";
import { sendExport } from "./managerReportsController.js";
import { parseReportQuery, activityFeed, sprintHealth } from "../services/reportRules.js";
import { buildDelivery, buildPeople, buildXp, filtersLabel } from "../services/reportService.js";
import { myStatsView, announcementView } from "../services/teamLeadRules.js";

const IS_OID = /^[0-9a-f]{24}$/i;
const SORTS = ["name", "role", "tasksDone", "onTimePct", "avgScore", "rework", "xp"];
const OID = (x) => new mongoose.Types.ObjectId(String(x));

// Filters → ctx, always inside the TL's projects and team. Answers 400 / 404 itself and returns null.
async function context(req, res) {
  const { errors, value: q } = parseReportQuery(req.query);
  if (Object.keys(errors).length) { res.status(400).json({ error: Object.values(errors)[0], fields: errors }); return null; }
  for (const k of ["project", "sprint", "member", "module"]) if (req.query[k] && !IS_OID.test(String(req.query[k]))) { res.status(404).json({ error: `That ${k} was not found.` }); return null; }
  const s = await tlScope(req, res); if (!s) return null;
  const project = q.project ? projectIn(s, q.project) : null;
  if (q.project && !project) { res.status(404).json({ error: "Project not found in your projects." }); return null; }
  let mod = null;
  if (req.query.module) {
    mod = project ? await Milestone.findOne({ _id: req.query.module, projectId: project._id, teamLeadId: req.user.id }, "title").lean() : null;
    if (!mod) { res.status(404).json({ error: "Module not found in your projects." }); return null; }
  }
  const sprint = q.sprint ? await Sprint.findOne({ _id: q.sprint, projectId: project._id, ...s.scope.filter }, "name status tasks startDate endDate").lean() : null;
  if (q.sprint && !sprint) { res.status(404).json({ error: "Sprint not found in this project." }); return null; }
  return { scope: s.scope, q, projects: s.projects, project, sprint, teamIds: [...s.team.keys()], moduleId: mod?._id ?? null, moduleTitle: mod?.title ?? null, s };
}

async function buildActivity(ctx, req) {
  const { q, scope } = ctx;
  const filter = { ...scope.filter, projectId: ctx.project ? ctx.project._id : { $in: ctx.projects.map((p) => p._id) }, ...(ctx.moduleId ? { milestoneId: ctx.moduleId } : {}), ...(ctx.sprint ? { _id: { $in: ctx.sprint.tasks ?? [] } } : {}), "activity.at": { $gte: q.from, $lte: q.to } };
  const tasks = await Task.find(filter, "title activity").sort({ updatedAt: -1 }).limit(300).lean(); // ponytail: latest 300 tasks with activity; enough for a 100-row feed
  const ids = [...new Set(tasks.flatMap((t) => (t.activity ?? []).map((a) => String(a.by))).filter((x) => IS_OID.test(x)))];
  const names = Object.fromEntries((await User.find({ _id: { $in: ids } }, "name").lean()).map((u) => [String(u._id), u.name]));
  return { filters: filtersLabel(ctx), ...activityFeed(tasks, { from: q.from, to: q.to, kind: req.query.kind, names }) };
}
async function buildSprints(ctx) {
  const { q, scope } = ctx;
  const f = { ...scope.filter, projectId: ctx.project ? ctx.project._id : { $in: ctx.projects.map((p) => p._id) }, ...(ctx.sprint ? { _id: ctx.sprint._id } : { $or: [{ status: { $ne: "Completed" } }, { completedAt: { $gte: q.from } }] }) };
  const sprints = await Sprint.find(f, "name status startDate endDate projectId tasks closeSummary").populate("tasks", "status xpValue").sort({ startDate: -1 }).limit(30).lean();
  const now = new Date();
  return { filters: filtersLabel(ctx), rows: sprints.map((x) => ({ id: x._id, name: x.name, project: ctx.projects.find((p) => String(p._id) === String(x.projectId))?.title ?? "—", startDate: x.startDate, endDate: x.endDate,
    ...sprintHealth({ status: x.status, startDate: x.startDate, endDate: x.endDate, tasks: (x.tasks ?? []).filter(Boolean), now, summary: x.closeSummary ?? null }) })) };
}
const BUILD = {
  delivery: (ctx) => buildDelivery(ctx),
  people: (ctx, req) => buildPeople(ctx, { sort: SORTS.includes(req.query.sort) ? req.query.sort : "tasksDone", dir: req.query.dir === "asc" ? "asc" : "desc" }),
  xp: (ctx) => buildXp(ctx),
  activity: buildActivity,
  sprints: (ctx) => buildSprints(ctx),
};
export const tab = (name) => async (req, res) => {
  const ctx = await context(req, res); if (!ctx) return;
  const data = await BUILD[name](ctx, req);
  if (!data) return res.status(404).json({ error: "That person is not in your team." });
  res.json(data);
};
export async function exportPerformance(req, res) {
  const name = String(req.query.tab ?? "");
  if (!BUILD[name]) return res.status(400).json({ error: "Choose a report tab to export." });
  const ctx = await context(req, res); if (!ctx) return;
  const data = await BUILD[name](ctx, req);
  if (!data) return res.status(404).json({ error: "That person is not in your team." });
  sendExport(req, res, name, data, ctx.scope.org);
}
// GET /performance/options: the TL's projects, own modules, sprints.
export async function getOptions(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const ids = s.projects.map((p) => p._id);
  const [mods, sprints] = await Promise.all([
    Milestone.find({ projectId: { $in: ids }, teamLeadId: req.user.id }, "title projectId").sort({ order: 1 }).lean(),
    Sprint.find({ ...s.scope.filter, projectId: { $in: ids } }, "name status projectId").sort({ startDate: -1 }).limit(100).lean(),
  ]);
  res.json({ projects: s.projects.map((p) => ({ id: p._id, title: p.title })), modules: mods.map((m) => ({ id: m._id, title: m.title, projectId: m.projectId })), sprints: sprints.map((x) => ({ id: x._id, name: x.name, projectId: x.projectId })) });
}

// ── GET /my-stats (D-145, D-020: light) ─────────────────────────────────────
export async function getMyStats(req, res) {
  const [profile, logs] = await Promise.all([
    GamificationProfile.findOne({ userId: req.user.id }, "totalXp streaks stats").lean(),
    XpLog.find({ userId: req.user.id }, "amount source createdAt").sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  res.json(myStatsView({ profile, logs }));
}

// ── Announcements read (D-146): messages of announcement channels the TL belongs to. ──
const myChannels = (req) => ChatChannel.find({ orgId: OID(req.user.orgId), type: "announcement", memberIds: OID(req.user.id) }, "name").lean();
export async function getAnnouncements(req, res) {
  const channels = await myChannels(req);
  const byId = new Map(channels.map((c) => [String(c._id), c]));
  const msgs = await ChatMessage.find({ channelId: { $in: channels.map((c) => c._id) }, deletedAt: null }, "channelId sender content createdAt readBy").populate("sender", "name role").sort({ createdAt: -1 }).limit(100).lean();
  // Only what leaders posted: an employee's post in such a channel is chat, not an announcement.
  const items = msgs.filter((m) => ["Manager", "Director"].includes(m.sender?.role)).map((m) => announcementView(m, byId.get(String(m.channelId)), req.user.id));
  res.json({ items, unread: items.filter((i) => i.unread).length });
}
// POST /announcements/read { ids? } → marks these, or all, as read for this person only.
export async function markAnnouncementsRead(req, res) {
  const channels = await myChannels(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => IS_OID.test(String(x))) : null;
  const r = await ChatMessage.updateMany({ channelId: { $in: channels.map((c) => c._id) }, readBy: { $ne: OID(req.user.id) }, ...(ids ? { _id: { $in: ids.map(OID) } } : {}) }, { $addToSet: { readBy: OID(req.user.id) } });
  res.json({ ok: true, marked: r.modifiedCount });
}
