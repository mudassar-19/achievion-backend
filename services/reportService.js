// Manager Reports data (V2 Phase 3 · M-6). One builder per tab; the JSON endpoints, the PDF/CSV export
// and the project Report tab all call these, so every place shows the same numbers. Numbers come from
// services/reportRules.js (pure, tested). Queries are batched per tab (no per-user / per-task lookups).
import Project from "../models/Project.js";
import Task from "../models/Task.js";
import Sprint from "../models/Sprint.js";
import User from "../models/User.js";
import XpLog from "../models/XpLog.js";
import Notification from "../models/Notification.js";
import ExtensionRequest from "../models/ExtensionRequest.js";
import GamificationProfile from "../models/GamificationProfile.js";
import Lesson from "../models/Lesson.js";
import WellbeingSnapshot from "../models/WellbeingSnapshot.js";
import Organization from "../models/Organization.js";
import { velocity } from "./sprintRules.js";
import {
  deliveryNumbers, compare, timeBuckets, series, doneIn, peopleRows, sortRows, wellbeing, autoFacts, factsText,
} from "./reportRules.js";

const LEADERS = ["Director", "Manager"]; // no personal XP or rows for them (D-081)
const DONE_FIELDS = "title status xpValue deadline firstSubmittedAt submittedAt completedAt tlScore qualityScore assignees assignee";
const REWORK = "activity.kind activity.from activity.to";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymd = (d) => d.toISOString().slice(0, 10);
const short = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
const RANGE_LABEL = { "7d": "Last 7 days", "30d": "Last 30 days", month: "This month" };

export const filtersLabel = (ctx) => [ctx.project?.title ?? "All projects", ctx.moduleTitle, ctx.sprint?.name, RANGE_LABEL[ctx.q.range] ?? `${short(ctx.q.from)} – ${short(ctx.q.to)}`]
  .filter(Boolean).join(" · ");

// ctx = { scope: {org, filter}, q (parsed query), projects, project, sprint }
const taskFilter = (ctx) => ({
  ...ctx.scope.filter, isDeleted: { $ne: true },
  projectId: { $in: ctx.project ? [ctx.project._id] : ctx.projects.map((p) => p._id) },
  ...(ctx.sprint ? { _id: { $in: ctx.sprint.tasks ?? [] } } : {}),
  ...(ctx.moduleId ? { milestoneId: ctx.moduleId } : {}), // T-5 Team Lead Performance
});

// Team = non-leader members of the chosen project, or of the whole org.
export function teamMembers(ctx, fields = "_id name role") {
  const f = { ...ctx.scope.filter, status: { $ne: "deleted" }, role: { $nin: LEADERS } };
  if (ctx.project) f._id = { $in: (ctx.project.members ?? []).map((m) => m?._id ?? m) };
  // T-5 (D-144): a Team Lead sees only their own team.
  if (ctx.teamIds) f._id = { $in: ctx.project ? (ctx.project.members ?? []).map((m) => String(m?._id ?? m)).filter((id) => ctx.teamIds.includes(id)) : ctx.teamIds };
  return User.find(f, fields).sort({ name: 1 }).lean();
}

// XP rows belong to the chosen project / sprint through their task (reversals carry the task too).
async function xpTaskFilter(ctx) {
  if (!ctx.project && !ctx.teamIds) return {};
  const ids = await Task.find(taskFilter(ctx), "_id").lean();
  return { taskId: { $in: ids.map((t) => t._id) } };
}

// ── Delivery ────────────────────────────────────────────────────────────────
export async function buildDelivery(ctx) {
  const { q } = ctx;
  const sprintFilter = { ...ctx.scope.filter, projectId: { $in: ctx.project ? [ctx.project._id] : ctx.projects.map((p) => p._id) } };
  if (ctx.sprint) sprintFilter._id = ctx.sprint._id;
  // Closed by the end of the range (a sprint closed early still counts on its closing day).
  else { sprintFilter.status = "Completed"; sprintFilter.$or = [{ completedAt: { $lte: q.to } }, { completedAt: null, endDate: { $lte: q.to } }]; }
  const [tasks, sprints] = await Promise.all([
    Task.find({ ...taskFilter(ctx), status: "Done", completedAt: { $gte: q.prevFrom, $lte: q.to } }, `${DONE_FIELDS} ${REWORK}`).select("+aiScore").lean(),
    Sprint.find(sprintFilter, "name endDate completedAt closeSummary tasks").populate("tasks", "status xpValue").sort({ completedAt: -1, endDate: -1 }).limit(8).lean(),
  ]);
  // The /approve path keeps the stars on the XP award, not on the task: read them from there.
  const noStars = tasks.filter((t) => t.qualityScore == null).map((t) => t._id);
  if (noStars.length) {
    const logs = await XpLog.find({ taskId: { $in: noStars }, source: "task_approved", qualityScore: { $ne: null } }, "taskId qualityScore").lean();
    const stars = new Map(logs.map((l) => [String(l.taskId), l.qualityScore]));
    for (const t of tasks) if (t.qualityScore == null && stars.has(String(t._id))) t.qualityScore = stars.get(String(t._id));
  }
  const current = deliveryNumbers(tasks, q);
  const previous = deliveryNumbers(tasks, { from: q.prevFrom, to: new Date(+q.prevTo - 1) });
  return {
    filters: filtersLabel(ctx),
    current, previous, delta: compare(current, previous),
    done: series(doneIn(tasks, q), (t) => t.completedAt, () => 1, timeBuckets(q.from, q.to)).map(({ label, value }) => ({ label, value })),
    // Same number as the sprint page history (frozen at close, else computed from the tasks).
    sprints: sprints.reverse().map((s) => ({ id: s._id, name: s.name, velocity: s.closeSummary?.velocity ?? velocity(s.tasks ?? []) })),
  };
}

// ── People ──────────────────────────────────────────────────────────────────
export async function buildPeople(ctx, { sort = "tasksDone", dir = "desc" } = {}) {
  const { q } = ctx;
  const [users, xpScope] = await Promise.all([teamMembers(ctx), xpTaskFilter(ctx)]);
  const [tasks, xp] = await Promise.all([
    Task.find({ ...taskFilter(ctx), status: "Done", completedAt: { $gte: q.from, $lte: q.to } }, `${DONE_FIELDS} ${REWORK}`).lean(),
    XpLog.aggregate([
      { $match: { userId: { $in: users.map((u) => u._id) }, createdAt: { $gte: q.from, $lte: q.to }, ...xpScope } },
      { $group: { _id: "$userId", xp: { $sum: "$amount" } } }, // net: reversal rows are negative
    ]),
  ]);
  const xpByUser = Object.fromEntries(xp.map((r) => [String(r._id), r.xp]));
  return { filters: filtersLabel(ctx), rows: sortRows(peopleRows(tasks, users, xpByUser, q), sort, dir) };
}

// ── XP trend ────────────────────────────────────────────────────────────────
export async function buildXp(ctx) {
  const { q } = ctx;
  const [users, xpScope] = await Promise.all([teamMembers(ctx), xpTaskFilter(ctx)]);
  const member = q.member ? users.find((u) => String(u._id) === q.member) : null;
  if (q.member && !member) return null; // not in this team → 404
  // Exact range edges for the totals (same window as the Dashboard "XP this week"); days for the chart.
  const [agg] = await XpLog.aggregate([
    { $match: { userId: { $in: member ? [member._id] : users.map((u) => u._id) }, createdAt: { $gte: q.prevFrom, $lte: q.to }, ...xpScope } },
    { $facet: {
      days: [{ $match: { createdAt: { $gte: q.from } } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, xp: { $sum: "$amount" } } }],
      totals: [{ $group: { _id: { $cond: [{ $gte: ["$createdAt", q.from] }, "cur", "prev"] }, xp: { $sum: "$amount" } } }],
    } },
  ]);
  const rows = agg.days.map((d) => ({ at: new Date(`${d._id}T12:00:00Z`), xp: d.xp }));
  const totals = Object.fromEntries(agg.totals.map((t) => [t._id, t.xp]));
  return {
    filters: filtersLabel(ctx) + (member ? ` · ${member.name}` : ""),
    bucket: q.bucket,
    memberName: member?.name ?? null,
    members: users.map((u) => ({ id: u._id, name: u.name })),
    points: series(rows, (r) => r.at, (r) => r.xp, timeBuckets(q.from, q.to, q.bucket)).map(({ label, value }) => ({ label, value })),
    total: totals.cur ?? 0,
    previousTotal: totals.prev ?? 0,
  };
}

// ── Well-being (aggregate only) ─────────────────────────────────────────────
// Members without a profile yet count with the defaults (HP 100, no streak).
async function wellbeingOf(users) {
  const profiles = await GamificationProfile.find({ userId: { $in: users.map((u) => u._id) } }, "userId hp streaks.daily").lean();
  const by = new Map(profiles.map((p) => [String(p.userId), p]));
  return wellbeing(users.map((u) => by.get(String(u._id)) ?? {}));
}
const orgWellbeing = async (orgFilter) => wellbeingOf(await User.find({ ...orgFilter, status: { $ne: "deleted" }, role: { $nin: LEADERS } }, "_id").lean());

export async function snapshotWellbeing(org, now = new Date()) {
  const ids = [String(org._id), ...(org.orgId ? [org.orgId] : [])];
  const w = await orgWellbeing({ orgId: { $in: ids } });
  await WellbeingSnapshot.updateOne({ orgId: String(org._id), day: ymd(now) }, { $set: w }, { upsert: true });
  return w;
}

// Midnight cron, after the streak/HP update.
export async function snapshotAllOrgs(now = new Date()) {
  const orgs = await Organization.find({}, "_id orgId").lean();
  for (const org of orgs) await snapshotWellbeing(org, now).catch((e) => console.error("[wellbeing-snapshot]", e.message));
}

export async function buildWellbeing(ctx) {
  const { q } = ctx;
  const ids = [String(ctx.scope.org._id), ...(ctx.scope.org.orgId ? [ctx.scope.org.orgId] : [])];
  const [current, orgToday, saved] = await Promise.all([
    ctx.project ? teamMembers(ctx, "_id").then(wellbeingOf) : null,
    orgWellbeing({ orgId: { $in: ids } }),
    WellbeingSnapshot.find({ orgId: String(ctx.scope.org._id), day: { $gte: ymd(q.from), $lte: ymd(q.to) } }, "day tiers avgHp").sort({ day: 1 }).lean(),
  ]);
  // Today's row is saved in the background (the midnight cron saves the rest) and shown right away.
  const now = new Date();
  WellbeingSnapshot.updateOne({ orgId: String(ctx.scope.org._id), day: ymd(now) }, { $set: orgToday }, { upsert: true }).catch((e) => console.error("[wellbeing-snapshot]", e.message));
  const trend = saved.filter((t) => t.day !== ymd(now));
  if (q.to >= new Date(`${ymd(now)}T00:00:00Z`)) trend.push({ day: ymd(now), tiers: orgToday.tiers, avgHp: orgToday.avgHp });
  return {
    filters: filtersLabel(ctx),
    current: current ?? orgToday,
    trendScope: "organisation", // snapshots are org-wide; a project filter changes "today" only
    trend: trend.map((s) => ({ day: s.day, label: short(new Date(`${s.day}T00:00:00Z`)).replace(/, \d{4}$/, ""), Healthy: s.tiers?.Healthy ?? 0, Tired: s.tiers?.Tired ?? 0, Low: s.tiers?.Low ?? 0, avgHp: s.avgHp })),
  };
}

// ── Lessons learned ─────────────────────────────────────────────────────────
// Facts cover the whole project (or sprint) life, not the date range.
export async function factsFor(scope, project, sprint = null) {
  const tf = { ...scope.filter, projectId: project._id, isDeleted: { $ne: true }, ...(sprint ? { _id: { $in: sprint.tasks ?? [] } } : {}) };
  const tasks = await Task.find(tf, `title status deadline firstSubmittedAt submittedAt completedAt assignees assignee ${REWORK} reviewFlags.status extensionRequests.status`).lean();
  const since = sprint?.startDate ?? project.startDate ?? project.createdAt ?? new Date(0);
  const until = sprint?.endDate ? new Date(+new Date(sprint.endDate) + 86_400_000) : new Date();
  const ids = [String(scope.org._id), ...(scope.org.orgId ? [scope.org.orgId] : [])];
  const [overloadEvents, extensions] = await Promise.all([
    Notification.countDocuments({ orgId: { $in: ids }, type: "workload_over_limit", "meta.memberId": { $in: (project.members ?? []).map(String) }, createdAt: { $gte: since, $lte: until } }),
    ExtensionRequest.countDocuments({ orgId: scope.org._id, status: { $in: ["approved", "auto_applied"] },
      $or: [...(sprint ? [] : [{ projectId: project._id, taskId: null }]), { taskId: { $in: tasks.map((t) => t._id) } }] }),
  ]);
  const embedded = tasks.reduce((a, t) => a + (t.extensionRequests ?? []).filter((e) => e.status === "APPROVED").length, 0);
  return autoFacts({ tasks, flags: tasks.reduce((a, t) => a + (t.reviewFlags?.length ?? 0), 0), overloadEvents, extensions: extensions + embedded });
}

export const lessonView = (l, names = {}) => ({ id: l._id, kind: l.kind, text: l.text, createdAt: l.createdAt, updatedAt: l.updatedAt,
  by: names[String(l.updatedBy ?? l.createdBy)] ?? null, edited: +new Date(l.updatedAt) - +new Date(l.createdAt) > 1000 });

export async function buildLessons(ctx) {
  const [facts, notes] = await Promise.all([
    factsFor(ctx.scope, ctx.project, ctx.sprint),
    Lesson.find({ ...ctx.scope.filter, projectId: ctx.project._id, sprintId: ctx.sprint?._id ?? null }).sort({ kind: 1, createdAt: -1 }).limit(200).lean(),
  ]);
  const people = await User.find({ _id: { $in: notes.flatMap((n) => [n.createdBy, n.updatedBy]).filter(Boolean) } }, "name").lean();
  const names = Object.fromEntries(people.map((u) => [String(u._id), u.name]));
  return {
    filters: [ctx.project.title, ctx.sprint?.name].filter(Boolean).join(" · "),
    project: { id: ctx.project._id, title: ctx.project.title, status: ctx.project.status },
    sprint: ctx.sprint ? { id: ctx.sprint._id, name: ctx.sprint.name } : null,
    facts, factsText: factsText(facts),
    notes: notes.map((n) => ({ ...lessonView(n, names), date: short(new Date(n.updatedAt ?? n.createdAt)) })),
  };
}

// Project closed or archived → one editable facts note, once (unique index on kind "auto").
export async function prefillLessons(scope, projectId, by) {
  const project = await Project.findById(projectId, "_id title members startDate createdAt").lean();
  if (!project) return;
  const text = factsText(await factsFor(scope, project));
  await Lesson.create({ orgId: String(scope.org._id), projectId: project._id, kind: "auto", text, createdBy: by, updatedBy: by })
    .catch((e) => { if (e.code !== 11000) throw e; });
}
