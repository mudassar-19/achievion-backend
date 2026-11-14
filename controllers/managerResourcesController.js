// Manager Resources (V2 Phase 3 · M-4, UX §7): Workload (engine numbers), member drawer, threshold override,
// reassign, Assets. Every route: Manager only (route guard) + people/tasks/projects/assets in the caller's org.
// The tier formula is the workload engine's (D-072); rules for this screen live in services/resourceRules.js.
import { lastSeenFor } from "../services/presenceRules.js";
import mongoose from "mongoose";
import User     from "../models/User.js";
import Task     from "../models/Task.js";
import Project  from "../models/Project.js";
import Asset    from "../models/Asset.js";
import AuditLog from "../models/AuditLog.js";
import Notification from "../models/Notification.js";
import GamificationProfile from "../models/GamificationProfile.js";
import { createNotification } from "./notificationController.js";
import { orgScope } from "./managerProjectsController.js";
import { getBulkWorkloadSnapshots, ROLE_TASK_ELIGIBILITY, ROLE_TO_CATEGORY } from "../services/workloadService.js";
import { orgWorkTime, dailyHoursForTask } from "../services/workloadRules.js";
import {
  effectiveThreshold, validateThreshold, statusBadge, loadLabel, loadTone, barPct, hpTier, needsLighterLoad, dueThisWeek,
  reassignBlockers, reassignUpdate, previewLoad, candidateReason, rankCandidates, validateAssetInput, expiryState, REASSIGNABLE,
} from "../services/resourceRules.js";

const LEADERS = ["Director", "Manager"];
const CLOSED = ["Archived", "Deleted"];
const valid = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));

async function scopeOr404(req, res) {
  const scope = await orgScope(req.user.orgId);
  if (!scope) res.status(404).json({ error: "Organization not found." });
  return scope;
}
const thresholdOf = async (scope, managerId) => {
  const me = await User.findById(managerId, "workloadThresholdPct").lean();
  return { pct: effectiveThreshold(scope.org.workloadThresholdPct, me?.workloadThresholdPct), default: scope.org.workloadThresholdPct ?? 100, override: me?.workloadThresholdPct ?? null };
};
const log = (scope, req, action, detail, extra = {}) => AuditLog.create({ action, orgId: scope.org._id, performedBy: req.user.id, detail, ...extra })
  .catch((e) => console.error("[audit]", e.message));
const view = (s, threshold) => ({
  utilisation: s.utilisation, label: loadLabel(s.utilisation), tone: loadTone(s.utilisation), barPct: barPct(s.utilisation),
  status: statusBadge({ utilisation: s.utilisation, hp: s.hp, threshold }), tier: s.workloadTier,
});

// Bell alert to the Manager when someone is above their limit; once per person per day (existing notifications).
async function alertIfOver(req, snaps, threshold) {
  const over = snaps.filter((s) => s.utilisation > threshold);
  if (!over.length) return;
  const since = new Date(Date.now() - 86_400_000);
  const sent = await Notification.find({ userId: req.user.id, type: "workload_over_limit", createdAt: { $gte: since } }, "meta").lean();
  const done = new Set(sent.map((n) => String(n.meta?.memberId)));
  for (const s of over.filter((x) => !done.has(String(x.userId)))) {
    await createNotification({ userId: req.user.id, orgId: req.user.orgId, type: "workload_over_limit", title: "Someone is over their limit",
      message: `${s.name} is at ${loadLabel(s.utilisation)} of daily capacity (your limit is ${threshold}%).`, meta: { memberId: String(s.userId) } }).catch(() => {});
  }
}

// Workload rows for people in the org (or only `userIds`, for a Team Lead's team) — same numbers as Resources.
// seenBy: the viewer ({ role, viewAs }) when the roster may show last seen (X17); without it the field is not sent at all.
export async function workloadView(scope, viewerId, { userIds = null, projectIds = null, seenBy = null } = {}) {
  const users = await User.find({ ...scope.filter, status: { $ne: "deleted" }, role: { $nin: LEADERS }, ...(userIds ? { _id: { $in: userIds } } : {}) }, "_id lastSeenAt").lean();
  const seenAt = new Map(users.map((u) => [String(u._id), u.lastSeenAt ?? null]));
  const workTime = orgWorkTime(scope.org);
  const [snaps, projects, threshold] = await Promise.all([
    getBulkWorkloadSnapshots(users.map((u) => u._id), { workTime }),
    Project.find({ ...scope.filter, isDeleted: { $ne: true }, status: { $nin: CLOSED }, ...(projectIds ? { _id: { $in: projectIds } } : {}) }, "title members").sort({ title: 1 }).lean(),
    thresholdOf(scope, viewerId),
  ]);
  const projectsOf = (uid) => projects.filter((p) => (p.members ?? []).some((m) => String(m) === String(uid))).map((p) => String(p._id));
  return {
    snaps, threshold, workTime,
    projects: projects.map((p) => ({ id: p._id, title: p.title })),
    members: snaps.map((s) => ({
      id: s.userId, name: s.name, role: s.role, roleCategory: s.roleCategory, projectIds: projectsOf(s.userId),
      activeTasks: s.activeTaskCount, dueThisWeek: dueThisWeek(s.activeTasks), hp: s.hp, ...view(s, threshold.pct),
      ...(seenBy && { lastSeenAt: lastSeenFor(seenBy, seenAt.get(String(s.userId))) }),
    })).sort((a, b) => b.utilisation - a.utilisation || a.name.localeCompare(b.name)),
  };
}

// ── GET /api/manager/resources/workload ──────────────────────────────────────
export async function getWorkload(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const { snaps, threshold, ...out } = await workloadView(scope, req.user.id, { seenBy: { role: req.user.role, viewAs: req.viewAs } });
  alertIfOver(req, snaps, threshold.pct).catch(() => {});
  res.json({ threshold, ...out });
}

// ── GET /api/manager/resources/members/:userId  (drawer: workload and well-being only, no XP/score) ──
export async function getMember(req, res) {
  if (!valid(req.params.userId)) return res.status(404).json({ error: "Person not found." });
  const scope = await scopeOr404(req, res); if (!scope) return;
  const user = await User.findOne({ _id: req.params.userId, ...scope.filter, status: { $ne: "deleted" }, role: { $nin: LEADERS } }, "name role status").lean();
  if (!user) return res.status(404).json({ error: "Person not found." });
  const workTime = orgWorkTime(scope.org);
  const [[s], profile, threshold] = await Promise.all([
    getBulkWorkloadSnapshots([user._id], { workTime }),
    GamificationProfile.findOne({ userId: user._id }, "streaks").lean(),
    thresholdOf(scope, req.user.id),
  ]);
  const tasks = await Task.find({ _id: { $in: s.activeTasks.map((t) => t.id) } }, "title status type priority deadline estimatedHours projectId").populate("projectId", "title").lean();
  const days = workTime.workingDays.length;
  res.json({
    id: user._id, name: user.name, role: user.role, accountStatus: user.status, ...view(s, threshold.pct), threshold: threshold.pct,
    hoursPerWeek: Math.round(s.allocatedHours * days * 10) / 10, capacityPerWeek: s.dailyCapacityHours * days,
    dueThisWeek: dueThisWeek(s.activeTasks), hp: s.hp, hpTier: hpTier(s.hp), burnoutRisk: s.burnoutRisk, needsLighterLoad: needsLighterLoad(s.burnoutRisk),
    streak: profile?.streaks?.daily ?? 0,
    leave: null, // no leave records in Achievion yet
    tasks: tasks.map((t) => ({ id: t._id, title: t.title, status: t.status, type: t.type, priority: t.priority, deadline: t.deadline, estimatedHours: t.estimatedHours,
      project: t.projectId ? { id: t.projectId._id, title: t.projectId.title } : null, reassignable: REASSIGNABLE.includes(t.status) }))
      .sort((a, b) => (a.deadline ? new Date(a.deadline) : Infinity) - (b.deadline ? new Date(b.deadline) : Infinity)),
  });
}

// ── GET / PUT /api/manager/resources/threshold { pct | null } (FR11-03) ──────
export async function getThreshold(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  res.json(await thresholdOf(scope, req.user.id));
}
export async function setThreshold(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const v = validateThreshold(req.body?.pct ?? null);
  if (v.error) return res.status(400).json({ error: v.error, fields: { pct: v.error } });
  const before = await thresholdOf(scope, req.user.id);
  await User.updateOne({ _id: req.user.id }, { $set: { workloadThresholdPct: v.value } });
  const after = await thresholdOf(scope, req.user.id);
  log(scope, req, "workload_threshold_changed", `Workload limit ${before.pct}% → ${after.pct}%${v.value === null ? " (Director default)" : ""}.`, { before: { pct: before.override }, after: { pct: v.value } });
  res.json(after);
}

// Task in the org + its project members (team check) + engine numbers needed by both reassign routes.
async function loadTask(req, res, scope) {
  if (!valid(req.params.id)) { res.status(404).json({ error: "Task not found." }); return null; }
  const task = await Task.findOne({ _id: req.params.id, ...scope.filter }, "title status type assignee assignees projectId estimatedHours difficulty startDate deadline endDate").lean();
  if (!task) { res.status(404).json({ error: "Task not found." }); return null; }
  const project = task.projectId ? await Project.findOne({ _id: task.projectId, ...scope.filter }, "title members").lean() : null;
  return { task, project };
}
const fromOf = (task, id) => [task.assignee, ...(task.assignees ?? [])].filter(Boolean).map(String).find((x) => x === String(id)) ?? null;

// ── GET /api/manager/tasks/:id/candidates?from=<userId> ─────────────────────
export async function getCandidates(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const loaded = await loadTask(req, res, scope); if (!loaded) return;
  const { task, project } = loaded;
  const fromId = fromOf(task, req.query.from);
  if (!fromId) return res.status(400).json({ error: "Pick the person who gives the task away." });
  if (!REASSIGNABLE.includes(task.status)) return res.status(409).json({ error: reassignBlockers({ task, to: null, eligibleTypes: [] })[0] });
  const pool = await User.find({ ...scope.filter, status: "active", role: { $nin: [...LEADERS, "Team Lead"] }, _id: { $ne: fromId },
    ...(project ? { _id: { $in: (project.members ?? []).filter((m) => String(m) !== fromId) } } : {}) }, "name role status").lean();
  const workTime = orgWorkTime(scope.org);
  const [snaps, threshold, fromUser] = await Promise.all([
    getBulkWorkloadSnapshots([fromId, ...pool.map((u) => u._id)], { workTime }), thresholdOf(scope, req.user.id), User.findById(fromId, "name role").lean(),
  ]);
  const snapOf = new Map(snaps.map((s) => [String(s.userId), s]));
  const delta = dailyHoursForTask(task, new Date(), workTime.workingDays);
  const eligible = [], other = [];
  for (const u of pool) {
    const s = snapOf.get(String(u._id)); if (!s) continue;
    const blockers = reassignBlockers({ task, to: u, fromId, eligibleTypes: ROLE_TASK_ELIGIBILITY[s.roleCategory] ?? [], projectMemberIds: project?.members ?? null });
    const after = previewLoad(s, delta);
    const row = { id: u._id, name: u.name, role: u.role, availableHours: s.availableHours, utilisation: s.utilisation, label: loadLabel(s.utilisation),
      after, afterLabel: loadLabel(after), afterTone: loadTone(after), afterStatus: statusBadge({ utilisation: after, hp: s.hp, threshold: threshold.pct }),
      reason: candidateReason({ workloadTier: s.workloadTier, sameRole: u.role === fromUser?.role, availableHours: s.availableHours, workingDaysPerWeek: workTime.workingDays.length }) };
    (blockers.length ? other : eligible).push(blockers.length ? { ...row, blocked: blockers[0] } : row);
  }
  const fs = snapOf.get(fromId);
  const fromAfter = fs ? previewLoad(fs, -delta) : 0;
  res.json({
    task: { id: task._id, title: task.title, type: task.type, status: task.status, project: project ? { id: project._id, title: project.title } : null, hoursPerDay: Math.round(delta * 10) / 10 },
    from: { id: fromId, name: fromUser?.name, role: fromUser?.role, utilisation: fs?.utilisation ?? 0, label: loadLabel(fs?.utilisation ?? 0), after: fromAfter, afterLabel: loadLabel(fromAfter), afterTone: loadTone(fromAfter) },
    threshold: threshold.pct,
    candidates: rankCandidates(eligible, fromUser?.role),
    notEligible: other.length,
  });
}

// ── POST /api/manager/tasks/:id/reassign { fromUserId, toUserId } ────────────
// Only the task's assignee fields change (D-027); everything else on the task stays as the Team Lead set it.
export async function reassignTask(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const loaded = await loadTask(req, res, scope); if (!loaded) return;
  const { task, project } = loaded;
  const fromId = fromOf(task, req.body?.fromUserId);
  if (!fromId) return res.status(400).json({ error: "That person does not have this task." });
  const to = valid(req.body?.toUserId) ? await User.findOne({ _id: req.body.toUserId, ...scope.filter }, "name role status").lean() : null;
  const roleCategory = ROLE_TO_CATEGORY[to?.role] ?? "developer";
  const reasons = reassignBlockers({ task, to, fromId, eligibleTypes: ROLE_TASK_ELIGIBILITY[roleCategory] ?? [], projectMemberIds: project?.members ?? null });
  if (reasons.length) return res.status(409).json({ error: reasons[0], reasons });
  const update = reassignUpdate(task, fromId, to._id);
  const r = await Task.updateOne({ _id: task._id, status: { $in: REASSIGNABLE }, $or: [{ assignee: fromId }, { assignees: fromId }] }, update);
  if (!r.modifiedCount) return res.status(409).json({ error: "The task changed in the meantime. Open it again." });

  const fromUser = await User.findById(fromId, "name").lean();
  const where = project ? ` in "${project.title}"` : "";
  const meta = { taskId: task._id, projectId: project?._id ?? null };
  createNotification({ userId: to._id, orgId: req.user.orgId, type: "task_assigned", title: "A task moved to you", message: `"${task.title}"${where} is now yours (from ${fromUser?.name ?? "a teammate"}).`, meta }).catch(() => {});
  createNotification({ userId: fromId, orgId: req.user.orgId, type: "task_reassigned", title: "A task moved off your list", message: `"${task.title}"${where} now goes to ${to.name}, to balance the load.`, meta }).catch(() => {});
  log(scope, req, "task_reassigned", `"${task.title}" reassigned from ${fromUser?.name ?? fromId} to ${to.name}.`,
    { targetUserId: to._id, targetProjectId: project?._id ?? null, projectTitle: project?.title, before: { assignee: task.assignee, assignees: task.assignees }, after: update.$set });
  const workTime = orgWorkTime(scope.org);
  const [threshold, snaps] = await Promise.all([thresholdOf(scope, req.user.id), getBulkWorkloadSnapshots([to._id], { workTime })]);
  alertIfOver(req, snaps, threshold.pct).catch(() => {});
  res.json({ ok: true, to: { id: to._id, name: to.name }, from: { id: fromId, name: fromUser?.name } });
}

// ── Assets (FR11-05) ─────────────────────────────────────────────────────────
const assetOut = (a, titles) => ({ id: a._id, name: a.name, type: a.type, url: a.url, notes: a.notes, expiresAt: a.expiresAt, expiry: expiryState(a.expiresAt),
  projects: (a.projectIds ?? []).map((p) => ({ id: p, title: titles[String(p)] ?? "—" })).filter((p) => p.title !== "—"), updatedAt: a.updatedAt });
const projectTitles = async (scope) => Object.fromEntries((await Project.find({ ...scope.filter, isDeleted: { $ne: true } }, "title").lean()).map((p) => [String(p._id), p.title]));
async function projectsInOrg(scope, ids) {
  if (!ids?.length) return true;
  return (await Project.countDocuments({ _id: { $in: ids }, ...scope.filter, isDeleted: { $ne: true } })) === ids.length;
}

export async function listAssets(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const [assets, titles] = await Promise.all([Asset.find(scope.filter).sort({ name: 1 }).lean(), projectTitles(scope)]);
  res.json({ assets: assets.map((a) => assetOut(a, titles)),
    projects: (await Project.find({ ...scope.filter, isDeleted: { $ne: true }, status: { $nin: CLOSED } }, "title").sort({ title: 1 }).lean()).map((p) => ({ id: p._id, title: p.title })) });
}

export async function createAsset(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const { errors, value } = validateAssetInput(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
  if (!await projectsInOrg(scope, value.projectIds)) return res.status(400).json({ error: "Pick projects from your organization.", fields: { projectIds: "Pick projects from your organization." } });
  const a = await Asset.create({ ...value, orgId: req.user.orgId, createdBy: req.user.id });
  log(scope, req, "asset_created", `Asset "${a.name}" (${a.type}) added.`);
  res.status(201).json(assetOut(a.toObject(), await projectTitles(scope)));
}

async function loadAsset(req, res, scope, id = req.params.id) {
  const a = valid(id) ? await Asset.findOne({ _id: id, ...scope.filter }) : null;
  if (!a) res.status(404).json({ error: "Asset not found." });
  return a;
}

export async function updateAsset(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const a = await loadAsset(req, res, scope); if (!a) return;
  const { errors, value } = validateAssetInput({ type: a.type, ...req.body }, { partial: true });
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
  if (!await projectsInOrg(scope, value.projectIds)) return res.status(400).json({ error: "Pick projects from your organization.", fields: { projectIds: "Pick projects from your organization." } });
if (value.type === "File link" && !(value.url ?? a.url)) return res.status(400).json({ error: "A file link needs the link.", fields: { url: "A file link needs the link." } });
  Object.assign(a, value); await a.save();
  log(scope, req, "asset_updated", `Asset "${a.name}" updated.`);
  res.json(assetOut(a.toObject(), await projectTitles(scope)));
}

export async function deleteAsset(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const a = await loadAsset(req, res, scope); if (!a) return;
  await Asset.deleteOne({ _id: a._id });
  log(scope, req, "asset_deleted", `Asset "${a.name}" (${a.type}) deleted.`, { before: { name: a.name, type: a.type, url: a.url, projectIds: a.projectIds } });
  res.json({ ok: true });
}

// Project detail → Assets tab: linked assets + link / unlink.
async function projectOr404(req, res, scope) {
  const p = valid(req.params.id) ? await Project.findOne({ _id: req.params.id, ...scope.filter, isDeleted: { $ne: true } }, "title").lean() : null;
  if (!p) res.status(404).json({ error: "Project not found." });
  return p;
}
export async function getProjectAssets(req, res) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const p = await projectOr404(req, res, scope); if (!p) return;
  const [assets, titles] = await Promise.all([Asset.find({ ...scope.filter, projectIds: p._id }).sort({ name: 1 }).lean(), projectTitles(scope)]);
  res.json({ assets: assets.map((a) => assetOut(a, titles)) });
}
export async function linkProjectAsset(req, res, unlink = false) {
  const scope = await scopeOr404(req, res); if (!scope) return;
  const p = await projectOr404(req, res, scope); if (!p) return;
  const a = await loadAsset(req, res, scope, unlink ? req.params.assetId : req.body?.assetId); if (!a) return;
  await Asset.updateOne({ _id: a._id }, unlink ? { $pull: { projectIds: p._id } } : { $addToSet: { projectIds: p._id } });
  log(scope, req, "asset_updated", `Asset "${a.name}" ${unlink ? "unlinked from" : "linked to"} "${p.title}".`, { targetProjectId: p._id, projectTitle: p.title });
  res.json({ ok: true });
}
export const unlinkProjectAsset = (req, res) => linkProjectAsset(req, res, true);
