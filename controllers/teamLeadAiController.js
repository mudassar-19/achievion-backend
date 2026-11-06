// Team Lead AI (T-6, D-149..D-152; UX TL v4 §13, FR08-01/04/09/10). The task planner. Suggest only: no route here writes data;
// "Apply" fills a form or a selection and the normal routes re-check on save (FR08-06).
// Snapshots hold only the TL's own modules, team, tasks and sprints, with short references instead of ids, and never an AI score (D-075).
// Order on every route: scope (404) → AI configured (503) → per-user daily limit (429) → call.
import mongoose from "mongoose";
import Organization from "../models/Organization.js";
import Task from "../models/Task.js";
import Sprint from "../models/Sprint.js";
import Milestone from "../models/Milestone.js";
import AIPromptLog from "../models/AIPromptLog.js";
import AIChat from "../models/AIChat.js";
import AICache from "../models/AICache.js";
import { getPrompt } from "../ai/prompts/registry.js";
import { callChain, aiConfigured } from "../services/aiChain.js";
import { parseJsonLoose } from "../services/aiEvalRules.js";
import { makeRefs, dailyLimit, usageState, dayKey, cacheKey, prune, withNames, validateChat, validateScope } from "../services/managerAiRules.js";
import { tlContextFromPath, resolveTlContext, TL_PROMPTS_FOR, tlSourcesFor, tlProactiveCards, tlTaskForAi, validateTlInsight, validateAssignHint, validateRealismExplain, FEATURE_PREFIX } from "../services/tlAiRules.js";
import { ROLE_TASK_ELIGIBILITY, ROLE_TO_CATEGORY } from "../services/workloadService.js";
import { capture, passOn } from "../utils/capture.js";
import { tlScope, projectIn, taskIn, getHome, sprintDetail, tlSprintBacklog, writableSprint, blockedTaskIds } from "./teamLeadWorkController.js";
import { workloadView, getCandidates } from "./managerResourcesController.js";
import { postRealism } from "./teamLeadBreakdownController.js";

const valid = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));
const OID = (x) => new mongoose.Types.ObjectId(String(x));
const pids = (s) => [...s.ids].map(OID);

async function usageOf(req, org) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [settings, used] = await Promise.all([Organization.findById(org._id, "aiSettings.managerDailyLimit").lean(),
    AIPromptLog.countDocuments({ orgId: req.user.orgId, createdAt: { $gte: start }, requestedBy: req.user.id, feature: { $regex: `^${FEATURE_PREFIX}` }, fromCache: { $ne: true } })]);
  return usageState(used, dailyLimit(settings));
}
function overLimit(res, usage) {
  if (usage.remaining) return false;
  res.status(429).json({ error: `You have used today's ${usage.limit} AI requests. They reset at midnight.`, code: "limit", usage });
  return true;
}
async function gate(req, res, s, { cacheFirst = false } = {}) {
  if (!aiConfigured()) { res.status(503).json({ error: "AI is not configured on this server. Everything else works as usual.", code: "ai_off" }); return null; }
  const usage = await usageOf(req, s.scope.org);
  if (!cacheFirst && overLimit(res, usage)) return null;
  return usage;
}
const spent = (u, fromCache) => (fromCache ? u : { ...u, used: u.used + 1, remaining: Math.max(0, u.remaining - 1) });
function aiFail(res, err, usage) {
  if (err.status === 422) return res.status(502).json({ error: "The AI answer was not usable. Try again.", code: "invalid", usage });
  return res.status(503).json({ error: "AI is busy or unavailable right now. Try again shortly.", code: "busy", usage });
}
// One validated call: the validator runs on every reply (one retry, then 422).
async function ask(req, { feature, promptId, data, check }) {
  const prompt = getPrompt(promptId);
  const r = await callChain({ feature, orgId: req.user.orgId, requestedBy: req.user.id, promptId: prompt.id, promptVersion: prompt.version, systemPrompt: prompt.system,
    temperature: prompt.temperature, maxTokens: prompt.maxTokens, maxInvalid: 2, userMessage: prompt.userTemplate(data), validate: (t) => check(parseJsonLoose(t)).ok });
  const v = check(parseJsonLoose(r.text));
  if (!v.ok) throw Object.assign(new Error("invalid"), { status: 422 });
  return { value: v.value, fromCache: !!r.fromCache };
}
const endOfDay = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return +d - Date.now(); };

// ── Snapshot: numbers and names of the TL's own world ───────────────────────
const TASK_FIELDS = "title status priority type estimatedHours deadline assignee assignees qaRequired tlScore aiEval.status aiEval.partial dependsOn";
const taskQuery = (s, extra) => Task.find({ ...s.scope.filter, projectId: { $in: pids(s) }, ...extra }, TASK_FIELDS).populate("assignee", "name").populate("assignees", "name");
async function teamSnapshot(req, s, refs) {
  const [home, wl, blockedIds] = await Promise.all([capture(getHome, req), s.team.size ? workloadView(s.scope, req.user.id, { userIds: [...s.team.keys()], projectIds: pids(s) }) : { members: [] }, blockedTaskIds(s.scope, pids(s))]);
  const h = home.body ?? {}, now = new Date();
  const [blocked, overdue, sprints] = await Promise.all([
    blockedIds.length ? taskQuery(s, { _id: { $in: blockedIds.slice(0, 8) } }).lean() : [],
    taskQuery(s, { status: { $ne: "Done" }, deadline: { $lt: now, $ne: null } }).sort({ deadline: 1 }).limit(8).lean(),
    Sprint.find({ ...s.scope.filter, projectId: { $in: pids(s) }, status: { $in: ["Active", "Under Review", "Delayed"] } }, "name endDate tasks").populate("tasks", "status").limit(6).lean(),
  ]);
  const tRow = (t, more) => ({ ref: refs.add("t", t._id), ...tlTaskForAi(t), ...more });
  const modules = (h.activeModules ?? []).map((m) => ({ ref: refs.add("k", `${m.projectId}|${m.kind === "module" ? m.id : ""}`), title: m.title, project: m.project, state: m.state, progressPct: m.progress, deadline: m.deadline }));
  const members = (wl.members ?? []).slice(0, 15).map((m) => ({ ref: refs.add("m", m.id), name: m.name, role: m.role, load: m.label, status: m.status, activeTasks: m.activeTasks }));
  return {
    tasks: h.tasks, reviewQueue: h.reviewQueue, overloaded: h.overloaded, unassigned: h.unassigned, newModules: h.newModules, blocked: h.blocked,
    modules, members, blockedTasks: blocked.map((t) => tRow(t, { blocked: true })), overdueTasks: overdue.map((t) => tRow(t)),
    activeSprints: sprints.map((x) => { const ts = (x.tasks ?? []).filter(Boolean); return { ref: refs.add("s", x._id), name: x.name, endDate: x.endDate, done: ts.filter((t) => t.status === "Done").length, total: ts.length }; }),
  };
}
const namesOf = (snap) => Object.fromEntries([...snap.members.map((m) => [m.ref, m.name]), ...snap.modules.map((m) => [m.ref, m.title]), ...snap.blockedTasks.map((t) => [t.ref, t.title]), ...snap.overdueTasks.map((t) => [t.ref, t.title]), ...snap.activeSprints.map((x) => [x.ref, x.name])]);

async function contextLists(s, ctx) {
  const sprints = await Sprint.find({ ...s.scope.filter, projectId: { $in: pids(s) } }, "name status").sort({ updatedAt: -1 }).limit(100).lean();
  const task = ctx?.kind === "task" && valid(ctx.id) ? await Task.findOne({ _id: ctx.id, ...s.scope.filter, projectId: { $in: pids(s) } }, "title").lean() : null;
  return { projects: s.projects.map((p) => ({ id: String(p._id), title: p.title, status: p.status })), sprints: sprints.map((x) => ({ id: String(x._id), name: x.name, status: x.status })), tasks: task ? [{ id: String(task._id), title: task.title }] : [] };
}
async function resolve(req, s, raw) {
  let ctx = raw;
  if (ctx?.kind === "module" && ctx.moduleId) { // a module the TL does not lead falls back to the whole project
    const m = valid(ctx.moduleId) && valid(ctx.id) ? await Milestone.findOne({ _id: ctx.moduleId, projectId: ctx.id, teamLeadId: req.user.id }, "title").lean() : null;
    ctx = m ? { ...ctx, moduleTitle: m.title } : { ...ctx, moduleId: null };
  }
  return resolveTlContext(ctx, await contextLists(s, ctx));
}
const readContext = (c = {}) => (c.kind === "path" ? tlContextFromPath(c.path, c.search) : { kind: c.kind, id: c.id, moduleId: c.moduleId ?? null });

// Extra detail for the chosen context; still scoped and without AI scores.
async function contextDetail(req, s, ctx) {
  if (ctx.kind === "module") {
    const tasks = await taskQuery(s, { projectId: OID(ctx.id), ...(ctx.moduleId ? { milestoneId: OID(ctx.moduleId) } : {}) }).sort({ deadline: 1 }).limit(25).lean();
    return { module: { name: ctx.label, tasks: tasks.map(tlTaskForAi) } };
  }
  if (ctx.kind === "task") {
    const t = await taskQuery(s, { _id: OID(ctx.id) }).lean().then((x) => x[0]);
    if (!t) return {};
    const pre = await Task.find({ _id: { $in: t.dependsOn ?? [] } }, "title status").lean();
    return { task: { ...tlTaskForAi(t), waitingFor: pre.filter((p) => p.status !== "Done").map((p) => p.title), reviewNote: "Submission feedback and the AI review are on the review page." } };
  }
  if (ctx.kind === "sprint") {
    const d = await capture(sprintDetail, req, { params: { id: ctx.id } });
    if (d.status !== 200) return {};
    const x = d.body;
    return { sprint: { name: x.name, status: x.status, goal: x.goal, startDate: x.startDate, endDate: x.endDate, stats: x.stats, capacity: x.capacity, tasks: x.tasks.slice(0, 20).map((t) => ({ title: t.title, status: t.status, priority: t.priority, estimatedHours: t.estimatedHours, deadline: t.deadline, people: t.assignees.map((a) => a.name) })) } };
  }
  return {};
}

// ── GET /api/teamlead/ai/context?path=&search= or ?kind=&id=&moduleId= (no AI call) ──
export async function getContext(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const ctx = await resolve(req, s, req.query.kind ? readContext(req.query) : tlContextFromPath(req.query.path, req.query.search));
  const refs = makeRefs();
  const [usage, snap, insight, lists] = await Promise.all([usageOf(req, s.scope.org), teamSnapshot(req, s, refs), AICache.findOne({ key: cacheKey("tl_insight", { user: req.user.id, day: dayKey() }), expiresAt: { $gt: new Date() } }).lean(), contextLists(s, null)]);
  res.json({
    configured: aiConfigured(), usage, context: ctx, prompts: TL_PROMPTS_FOR[ctx.kind] ?? TL_PROMPTS_FOR.team,
    cards: tlProactiveCards({ overloaded: snap.overloaded, blocked: snap.blocked, reviewQueue: snap.reviewQueue }),
    insight: insight && !insight.dismissed && insight.value?.kind !== "none" ? insight.value : null,
    choices: [{ kind: "team", label: "My team" }, ...lists.projects.filter((p) => p.status !== "Archived").slice(0, 25).map((p) => ({ kind: "module", id: p.id, label: `Module: ${p.title}` })),
      ...lists.sprints.filter((x) => x.status !== "Completed").slice(0, 25).map((x) => ({ kind: "sprint", id: x.id, label: `Sprint: ${x.name}` })), ...(ctx.kind === "task" ? [ctx] : [])],
  });
}

// ── POST /api/teamlead/ai/chat (tl-chat) ─────────────────────────────────────
export async function chat(req, res) {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Type a question first." });
  if (message.length > 1000) return res.status(400).json({ error: "Keep the question under 1000 characters." });
  const chatId = req.body?.chatId;
  if (chatId && !valid(chatId)) return res.status(404).json({ error: "Chat not found." });
  const existing = chatId ? await AIChat.findOne({ _id: chatId, userId: req.user.id, orgId: req.user.orgId }) : null;
  if (chatId && !existing) return res.status(404).json({ error: "Chat not found." });
  const s = await tlScope(req, res); if (!s) return;
  const usage = await gate(req, res, s); if (!usage) return;
  const ctx = await resolve(req, s, readContext(req.body?.context));
  const refs = makeRefs();
  const team = await teamSnapshot(req, s, refs);
  const snapshot = { ...team, ...(await contextDetail(req, s, ctx)) };
  const sources = tlSourcesFor(ctx);
  const history = (existing?.messages ?? []).slice(-4).map((m) => ({ role: m.role, text: m.text.slice(0, 300) }));
  try {
    const { value, fromCache } = await ask(req, { feature: "tl_chat", promptId: "tl-chat", check: (o) => validateChat(o, sources),
      data: { today: new Date().toISOString().slice(0, 10), context: ctx.label, sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.label])), snapshot: prune(snapshot, { maxArray: 15 }), history, question: message } });
    const doc = existing ?? new AIChat({ orgId: req.user.orgId, userId: req.user.id, title: message.slice(0, 60) });
    const cited = value.sources.map((k) => ({ key: k, ...sources[k] }));
    const answer = withNames(value.answer, namesOf(team));
    doc.messages.push({ role: "user", text: message, context: ctx.label }, { role: "ai", text: answer, sources: cited, context: ctx.label });
    if (doc.messages.length > 200) doc.messages.splice(0, doc.messages.length - 200);
    await doc.save();
    const last = doc.messages[doc.messages.length - 1];
    res.json({ chatId: doc._id, title: doc.title, message: { id: last._id, role: "ai", text: last.text, sources: cited, context: ctx.label }, usage: spent(usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, usage); }
}

// ── GET /api/teamlead/ai/insight?refresh=1 · POST /ai/insight/dismiss (tl-insight, daily cache) ──
const targetLink = (refs, ref, snap) => {
  if (!ref) return null;
  const id = refs.id(ref);
  const titled = (list) => list.find((x) => x.ref === ref);
  if (ref.startsWith("m")) return { label: `Open ${titled(snap.members)?.name ?? "person"} on Team`, to: `/teamlead/team?member=${id}` };
  if (ref.startsWith("t")) return { label: "Open the task", to: `/teamlead/tasks?task=${id}` };
  if (ref.startsWith("s")) return { label: "Open the sprint", to: `/teamlead/sprints/${id}` };
  const [p, m] = id.split("|");
  return { label: "Open the module", to: `/teamlead/modules/${p}${m ? `?module=${m}` : ""}` };
};
export async function getInsight(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const usage = await gate(req, res, s, { cacheFirst: true }); if (!usage) return;
  const key = cacheKey("tl_insight", { user: req.user.id, day: dayKey() });
  const hit = req.query.refresh ? null : await AICache.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
  if (hit) return res.json({ insight: hit.value, dismissed: hit.dismissed, cached: true, cachedAt: hit.updatedAt, key, usage, aiGenerated: true });
  if (overLimit(res, usage)) return;
  const refs = makeRefs();
  const snap = await teamSnapshot(req, s, refs);
  try {
    const { value, fromCache } = await ask(req, { feature: "tl_insight", promptId: "tl-insight", data: prune(snap, { maxArray: 15 }), check: (o) => validateTlInsight(o, refs) });
    const names = namesOf(snap), named = (t) => withNames(t, names);
    const view = value.kind === "none" ? { kind: "none" } : { kind: value.kind, title: named(value.title), body: named(value.body), why: value.why.map(named), target: targetLink(refs, value.target, snap) };
    const saved = await AICache.findOneAndUpdate({ key }, { $set: { orgId: req.user.orgId, feature: "tl_insight", value: view, dismissed: false, expiresAt: new Date(Date.now() + endOfDay()) } }, { upsert: true, returnDocument: "after" }).lean();
    res.json({ insight: view, dismissed: false, cachedAt: saved.updatedAt, key, usage: spent(usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, usage); }
}
export async function dismissInsight(req, res) {
  const r = await AICache.updateOne({ key: cacheKey("tl_insight", { user: req.user.id, day: dayKey() }) }, { $set: { dismissed: !req.body?.undo } });
  if (!r.matchedCount) return res.status(404).json({ error: "There is no insight to dismiss today." });
  res.json({ ok: true, dismissed: !req.body?.undo });
}

// ── POST /api/teamlead/ai/assign-hint (tl-assign-hint): the engine's candidates only ──
// { taskId, from } = reassign an existing task (D-095 candidates) · { projectId, type, title, hours } = a task being created.
export async function assignHint(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const { taskId, projectId } = req.body ?? {};
  let task, candidates;
  if (taskId) {
    if (!(await taskIn(s, taskId, res))) return;
    const c = await capture(getCandidates, req, { params: { id: taskId }, query: { from: req.body.from } });
    if (c.status !== 200) return passOn(res, c);
    task = prune(c.body.task);
    candidates = c.body.candidates.map((x) => ({ id: x.id, name: x.name, role: x.role, load: x.label, loadAfter: x.afterLabel, statusAfter: x.afterStatus, freeHoursPerDay: x.freeHoursPerDay ?? x.availableHours }));
  } else {
    const p = valid(projectId) ? projectIn(s, projectId) : null;
    if (!p) return res.status(404).json({ error: "Project not found in your projects." });
    const ids = (p.members ?? []).map((m) => String(m._id ?? m)).filter((id) => s.team.has(id));
    const wl = ids.length ? await workloadView(s.scope, req.user.id, { userIds: ids, projectIds: [p._id] }) : { members: [] };
    const type = String(req.body?.type ?? "Feature");
    task = { title: String(req.body?.title ?? "").slice(0, 120), type, estimatedHours: Number(req.body?.hours) || null };
    candidates = wl.members.filter((m) => (ROLE_TASK_ELIGIBILITY[ROLE_TO_CATEGORY[m.role] ?? "developer"] ?? []).includes(type)).map((m) => ({ id: m.id, name: m.name, role: m.role, load: m.label, status: m.status, activeTasks: m.activeTasks }));
  }
  if (!candidates.length) return res.status(409).json({ error: "Nobody on this project can take this task, so there is nothing to suggest." });
  const usage = await gate(req, res, s); if (!usage) return;
  const refs = makeRefs();
  const data = { task, candidates: candidates.slice(0, 10).map(({ id, ...x }) => ({ ref: refs.add("c", id), ...x })) };
  try {
    const { value, fromCache } = await ask(req, { feature: "tl_assign_hint", promptId: "tl-assign-hint", data, check: (o) => validateAssignHint(o, refs) });
    const pick = candidates.find((x) => String(x.id) === refs.id(value.candidate));
    res.json({ candidateId: pick.id, name: pick.name, reason: withNames(value.reason, Object.fromEntries(data.candidates.map((x) => [x.ref, x.name]))), usage: spent(usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, usage); }
}

// ── POST /api/teamlead/ai/sprints/:id/scope (tl-sprint-scope): numbers from the engine; Apply only fills the selection ──
export async function sprintScope(req, res) {
  const w = await writableSprint(req, res); if (!w) return;
  const d = await capture(sprintDetail, req, { params: { id: req.params.id } });
  if (d.status !== 200) return passOn(res, d);
  if (d.body.status !== "Planned") return res.status(409).json({ error: "Scope suggestions are for sprints that have not started." });
  const back = await capture(tlSprintBacklog, req, { params: { id: req.params.id } });
  if (back.status !== 200) return passOn(res, back);
  const usage = await gate(req, res, w.s); if (!usage) return;
  const refs = makeRefs(), sprintHours = {}, backlogHours = {}, byRef = {};
  const row = (t, into) => { const ref = refs.add("t", t.id); into[ref] = t.estimatedHours ?? 0; byRef[ref] = t; return { ref, title: t.title, priority: t.priority, status: t.status, estimatedHours: t.estimatedHours ?? 0, deadline: t.deadline }; };
  const capacity = d.body.capacity.hours;
  const data = { capacity: { hours: capacity, people: d.body.capacity.people, days: d.body.capacity.days }, plannedHours: d.body.stats.estimatedHours, sprintTasks: d.body.tasks.slice(0, 20).map((t) => row(t, sprintHours)), backlog: back.body.tasks.slice(0, 20).map((t) => row(t, backlogHours)) };
  if (!data.sprintTasks.length && !data.backlog.length) return res.status(409).json({ error: "There are no tasks to plan yet." });
  try {
    const { value, fromCache } = await ask(req, { feature: "tl_sprint_scope", promptId: "tl-sprint-scope", data, check: (o) => validateScope(o, refs, { sprintHours, backlogHours, capacity }) });
    const out = (r) => ({ id: byRef[r].id, title: byRef[r].title, hours: byRef[r].estimatedHours ?? 0 });
    res.json({ add: value.add.map(out), remove: value.remove.map(out), why: withNames(value.why, Object.fromEntries(Object.entries(byRef).map(([r, t]) => [r, t.title]))), hoursAfter: value.hoursAfter, capacity, usage: spent(usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, usage); }
}

// ── POST /api/teamlead/ai/realism-explain { projectId, moduleId, rows } (tl-realism-explain): words only, no new numbers ──
export async function realismExplain(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const r = await capture(postRealism, req, { params: { projectId: req.body?.projectId }, body: { moduleId: req.body?.moduleId, rows: req.body?.rows } });
  if (r.status !== 200) return passOn(res, r);
  if (r.body.verdict === "empty") return res.status(409).json({ error: "Add tasks first, then there is something to explain." });
  const usage = await gate(req, res, s); if (!usage) return;
  const realism = { verdict: r.body.verdict, totals: r.body.totals, issues: (r.body.issues ?? []).slice(0, 8).map((i) => ({ level: i.level, message: i.message })), people: (r.body.people ?? []).slice(0, 8).map(({ id, userId, ...p }) => p), suggestions: (r.body.suggestions ?? []).slice(0, 4) };
  try {
    const { value, fromCache } = await ask(req, { feature: "tl_realism_explain", promptId: "tl-realism-explain", data: prune(realism), check: (o) => validateRealismExplain(o, realism) });
    res.json({ ...value, usage: spent(usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, usage); }
}
