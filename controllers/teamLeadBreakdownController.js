// Team Lead breakdown workspace (V2 Phase 4 · T-3, UX TL v4 §4, TL-03/TL-04, D-012, D-017, D-019, D-119, D-126..D-129).
// Draft lives in the browser; the server writes only on Apply (all or nothing). AI suggests rows / benchmarks only
// (FR08-06). Scope: TL's own projects; an assigned module must be Accepted first (D-119). Done is never set here.
import mongoose from "mongoose";
import Task from "../models/Task.js";
import User from "../models/User.js";
import Milestone from "../models/Milestone.js";
import AuditLog from "../models/AuditLog.js";
import AIPromptLog from "../models/AIPromptLog.js";
import Organization from "../models/Organization.js";
import { getPrompt } from "../ai/prompts/registry.js";
import { callChain, aiConfigured } from "../services/aiChain.js";
import { parseJsonLoose } from "../services/aiEvalRules.js";
import { dailyLimit, usageState } from "../services/managerAiRules.js";
import { orgWorkTime } from "../services/workloadRules.js";
import { realismCheck } from "../services/realismRules.js";
import { validateBreakdownReply, validateBenchmarkReply, validateApplyRows, MAX_APPLY_ROWS, MAX_SUGGESTED_ROWS } from "../services/breakdownRules.js";
import { workloadView } from "./managerResourcesController.js";
import { createNotification } from "./notificationController.js";
import { tlScope, projectIn } from "./teamLeadWorkController.js";

const valid = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));
const OID = (x) => new mongoose.Types.ObjectId(String(x));
const LEADS = ["Director", "Manager", "Team Lead"];

// Project in the TL's scope + (optional) their module, which must be accepted. Answers 404 / 409 itself.
async function loadTarget(req, res, projectId, moduleId) {
  const s = await tlScope(req, res); if (!s) return null;
  const p = valid(projectId) ? projectIn(s, projectId) : null;
  if (!p) { res.status(404).json({ error: "Module not found in your projects." }); return null; }
  let mod = null;
  if (moduleId) {
    mod = valid(moduleId) ? await Milestone.findOne({ _id: moduleId, projectId: p._id, teamLeadId: req.user.id }).lean() : null;
    if (!mod) { res.status(404).json({ error: "Module not found in your projects." }); return null; }
    if (!mod.tlAcceptedAt) { res.status(409).json({ error: "Accept the module first. Tasks can be planned after you accept it.", code: "not_accepted" }); return null; }
  }
  const team = (p.members ?? []).filter((m) => !LEADS.includes(m.role) && s.team.has(String(m._id)));
  return { s, p, mod, team, deadline: mod?.dueDate ?? p.deadline ?? null };
}

async function teamLoad(t, viewerId) {
  if (!t.team.length) return [];
  const { snaps } = await workloadView(t.s.scope, viewerId, { userIds: t.team.map((m) => m._id), projectIds: [t.p._id] });
  return snaps.map((x) => ({ id: String(x.userId), name: x.name, role: x.role, roleCategory: x.roleCategory, capacityPerDay: x.dailyCapacityHours, allocatedPerDay: x.allocatedHours, utilisation: x.utilisation }));
}

// AI gate: configured (503) → per-user daily limit, same org setting as the Manager (aiSettings.managerDailyLimit).
async function aiGate(req, res, org) {
  if (!aiConfigured()) { res.status(503).json({ error: "AI is not configured on this server. The workspace works without it.", code: "ai_off" }); return null; }
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [settings, used] = await Promise.all([Organization.findById(org._id, "aiSettings.managerDailyLimit").lean(),
    AIPromptLog.countDocuments({ orgId: req.user.orgId, createdAt: { $gte: start }, requestedBy: req.user.id, feature: { $regex: "^tl_" }, fromCache: { $ne: true } })]);
  const usage = usageState(used, dailyLimit(settings));
  if (!usage.remaining) { res.status(429).json({ error: `You have used today's ${usage.limit} AI requests. They reset at midnight.`, code: "limit", usage }); return null; }
  return usage;
}
async function ask(req, promptId, feature, data, check) {
  const prompt = getPrompt(promptId);
  const r = await callChain({ feature, orgId: req.user.orgId, requestedBy: req.user.id, promptId: prompt.id, promptVersion: prompt.version,
    systemPrompt: prompt.system, temperature: prompt.temperature, maxTokens: prompt.maxTokens, maxInvalid: 2,
    userMessage: prompt.userTemplate(data), validate: (t) => !!check(parseJsonLoose(t)).ok });
  const v = check(parseJsonLoose(r.text));
  if (!v.ok) throw Object.assign(new Error("invalid"), { status: 422 });
  return v.value;
}
const aiFail = (res, err) => (err.status === 422
  ? res.status(502).json({ error: "The AI answer was not usable. Try again, or add the tasks yourself.", code: "invalid" })
  : res.status(503).json({ error: "AI is busy or unavailable right now. Try again shortly.", code: "busy" }));

// ── GET /api/teamlead/modules/:projectId/breakdown?module= ──────────────────
export async function getBreakdown(req, res) {
  const t = await loadTarget(req, res, req.params.projectId, req.query.module); if (!t) return;
  const [team, existing] = await Promise.all([teamLoad(t, req.user.id),
    Task.find({ ...t.s.scope.filter, projectId: t.p._id, isDeleted: { $ne: true } }, "title status").sort({ createdAt: 1 }).limit(200).lean()]);
  res.json({
    projectId: t.p._id, moduleId: t.mod?._id ?? null, title: t.mod?.title ?? t.p.title, project: t.p.title,
    brief: (t.mod?.description || t.p.description || "").trim(), deadline: t.deadline, workTime: orgWorkTime(t.s.scope.org),
    team: team.map(({ id, name, role, roleCategory, utilisation }) => ({ id, name, role, roleCategory, utilisation })),
    existingTasks: existing.map((x) => ({ id: x._id, title: x.title, status: x.status })),
    ai: { configured: aiConfigured() }, maxRows: MAX_APPLY_ROWS,
  });
}

// ── POST /api/teamlead/modules/:projectId/realism { moduleId?, rows } ───────
export async function postRealism(req, res) {
  const t = await loadTarget(req, res, req.params.projectId, req.body?.moduleId); if (!t) return;
  const rows = (Array.isArray(req.body?.rows) ? req.body.rows : []).slice(0, MAX_APPLY_ROWS).map((r) => ({
    key: String(r.key ?? ""), title: String(r.title ?? "").slice(0, 120) || "Untitled task", hours: r.hours === "" ? null : r.hours,
    type: r.type, assigneeId: r.assigneeId ? String(r.assigneeId) : null, acceptanceCriteria: Array.isArray(r.acceptanceCriteria) ? r.acceptanceCriteria : [], qaRequired: !!r.qaRequired }));
  const team = await teamLoad(t, req.user.id);
  res.json(realismCheck({ rows, team, workTime: orgWorkTime(t.s.scope.org), today: new Date(), deadline: t.deadline ? new Date(t.deadline) : null }));
}

// ── POST /api/teamlead/ai/breakdown { projectId, moduleId?, section?, draft: [titles] } ──
export async function suggestBreakdown(req, res) {
  const t = await loadTarget(req, res, req.body?.projectId, req.body?.moduleId); if (!t) return;
  if (!(await aiGate(req, res, t.s.scope.org))) return;
  const existingTasks = await Task.find({ ...t.s.scope.filter, projectId: t.p._id, isDeleted: { $ne: true } }, "title status").sort({ createdAt: -1 }).limit(25).lean();
  const existing = new Map(existingTasks.map((x, i) => [`e${i + 1}`, String(x._id)]));
  const team = await teamLoad(t, req.user.id);
  const data = {
    module: t.mod?.title ?? t.p.title, project: t.p.title, brief: (t.mod?.description || t.p.description || "").slice(0, 1200),
    section: String(req.body?.section ?? "").trim().slice(0, 120) || null, deadline: t.deadline,
    teamRoles: [...new Set(team.map((m) => m.roleCategory))],
    existingTasks: existingTasks.map((x, i) => ({ ref: `e${i + 1}`, title: x.title.slice(0, 70) })),
    draft: (Array.isArray(req.body?.draft) ? req.body.draft : []).slice(0, 30).map((x) => String(x).slice(0, 70)),
  };
  try {
    const rows = await ask(req, "tl-breakdown", "tl_breakdown", data, (o) => validateBreakdownReply(o, { existing, maxRows: MAX_SUGGESTED_ROWS }));
    res.json({ rows, aiGenerated: true });
  } catch (err) { aiFail(res, err); }
}

// ── POST /api/teamlead/ai/benchmark { projectId, title, description, type, acceptanceCriteria } ──
export async function suggestBenchmark(req, res) {
  const title = String(req.body?.title ?? "").trim();
  if (title.length < 3) return res.status(400).json({ error: "Write the task title first." });
  const s = await tlScope(req, res); if (!s) return;
  if (!valid(req.body?.projectId) || !projectIn(s, req.body.projectId)) return res.status(404).json({ error: "Project not found in your projects." });
  if (!(await aiGate(req, res, s.scope.org))) return;
  try {
    const v = await ask(req, "tl-benchmark", "tl_benchmark", { title: title.slice(0, 120), type: req.body?.type, description: String(req.body?.description ?? "").slice(0, 1500),
      acceptanceCriteria: (Array.isArray(req.body?.acceptanceCriteria) ? req.body.acceptanceCriteria : []).slice(0, 10).map((c) => String(c).slice(0, 200)) }, validateBenchmarkReply);
    res.json({ ...v, aiGenerated: true });
  } catch (err) { aiFail(res, err); }
}

// ── POST /api/teamlead/modules/:projectId/breakdown/apply { moduleId?, rows } ──
export async function applyBreakdown(req, res) {
  const t = await loadTarget(req, res, req.params.projectId, req.body?.moduleId); if (!t) return;
  const existingIds = new Set((await Task.find({ ...t.s.scope.filter, projectId: t.p._id }, "_id").lean()).map((x) => String(x._id)));
  const v = validateApplyRows(req.body?.rows, { teamIds: new Set(t.team.map((m) => String(m._id))), existingIds });
  if (!v.ok) return res.status(400).json({ error: v.error, rowErrors: v.rowErrors ?? {} });
  // D-160: validateApplyRows already limits assignees to the team on this project; the department does not matter.
  const me = await User.findById(req.user.id, "name").lean();

  const idOf = new Map(v.value.map((r) => [r.key, new mongoose.Types.ObjectId()]));
  const docs = v.value.map((r) => ({
    _id: idOf.get(r.key), orgId: req.user.orgId, projectId: t.p._id, milestoneId: t.mod?._id ?? null, createdBy: req.user.id, assignedBy: r.assigneeId ? req.user.id : null, assignerRole: "Team Lead",
    title: r.title, description: r.description ?? "", type: r.type, priority: r.priority, difficulty: r.difficulty, estimatedHours: r.estimatedHours, deadline: r.deadline ?? null,
    tags: r.tags ?? [], acceptanceCriteria: r.acceptanceCriteria ?? [], benchmark: r.benchmark ?? "", qaRequired: !!r.qaRequired,
    status: r.assigneeId ? "To-Do" : "Backlog", assignee: r.assigneeId ? OID(r.assigneeId) : null, assignees: r.assigneeId ? [OID(r.assigneeId)] : [],
    dependsOn: [...r.dependsOnRows.map((k) => idOf.get(k)), ...r.dependsOnTasks.map(OID)],
  }));
  try { await Task.create(docs); }
  catch (err) { // all or nothing
    await Task.deleteMany({ _id: { $in: [...idOf.values()] } }).catch(() => {});
    return res.status(400).json({ error: `Nothing was created: ${err.message?.slice(0, 160) ?? "a task could not be saved"}.` });
  }
  const per = {};
  for (const r of v.value) if (r.assigneeId) per[r.assigneeId] = (per[r.assigneeId] ?? 0) + 1;
  const where = t.mod?.title ?? t.p.title;
  for (const [userId, n] of Object.entries(per)) createNotification({ userId, orgId: req.user.orgId, type: "task_assigned", title: n === 1 ? "A new task for you" : `${n} new tasks for you`,
    message: `${me?.name ?? "Your Team Lead"} planned "${where}": ${n} task${n === 1 ? "" : "s"} for you.`, meta: { projectId: t.p._id, milestoneId: t.mod?._id ?? null } }).catch(() => {});
  AuditLog.create({ action: "breakdown_applied", orgId: t.s.scope.org._id, performedBy: req.user.id, targetProjectId: t.p._id, projectTitle: t.p.title,
    detail: `${docs.length} task(s) created from the breakdown of "${where}"; ${Object.keys(per).length} people notified.`, scope: "project" }).catch((e) => console.error("[audit]", e.message));
  res.status(201).json({ created: docs.length, notified: Object.keys(per).length, ids: docs.map((d) => d._id) });
}
