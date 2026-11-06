// Manager AI (V2 Phase 3 · M-7, UX §2 + §17, D-105..D-108). Suggest only: no route here writes project,
// task, sprint, challenge or lesson data. "Apply" happens in the normal forms, which re-check on save.
//
// Numbers come from the same Manager handlers the screens use (called in-process with the caller's req,
// so org scope, 404s and figures are identical). The prompt gets a pruned snapshot with short references
// instead of ids (managerAiRules.makeRefs); replies that use any other reference are rejected.
// Order on every AI route: ids / scope (404) → AI configured (503) → per-user daily limit (429) → call.
import mongoose from "mongoose";
import Organization from "../models/Organization.js";
import Project     from "../models/Project.js";
import Sprint      from "../models/Sprint.js";
import User        from "../models/User.js";
import AIPromptLog from "../models/AIPromptLog.js";
import AIChat      from "../models/AIChat.js";
import AIFeedback  from "../models/AIFeedback.js";
import AICache     from "../models/AICache.js";
import { getPrompt } from "../ai/prompts/registry.js";
import { callChain, aiConfigured } from "../services/aiChain.js";
import { parseJsonLoose } from "../services/aiEvalRules.js";
import { getBulkWorkloadSnapshots } from "../services/workloadService.js";
import { orgWorkTime } from "../services/workloadRules.js";
import { effectiveThreshold, statusBadge, loadLabel } from "../services/resourceRules.js";
import {
  makeRefs, dailyLimit, usageState, dayKey, cacheKey, contextFromPath, resolveContext, PROMPTS_FOR, sourcesFor, proactiveCards, prune,
  withNames, validateChat, validateInsight, validateNarrative, validateScope, validateLessonsDraft, validateChallengeDraft, validateRebalance, validateExplain,
  FEATURE_PREFIX,
} from "../services/managerAiRules.js";
import { orgScope } from "./managerProjectsController.js";
import { capture, passOn } from "../utils/capture.js";
import { getHome } from "./managerHomeController.js";
import { getSprintDetail, getSprintBacklog, getSprintSummary } from "./sprintController.js";
import { getDelivery, getPeople, getWellbeing, getLessons } from "./managerReportsController.js";
import { getCandidates } from "./managerResourcesController.js";
import { getAnomaly, questOptions } from "./managerMotivationController.js";

const DAY = 86_400_000;
const LEADERS = ["Director", "Manager"];
const valid = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));
const FEATURES = ["mgr_chat", "mgr_insight", "mgr_sprint_narrative", "mgr_sprint_scope", "mgr_report_narrative", "mgr_lessons", "mgr_challenge_draft", "mgr_rebalance", "mgr_anomaly_explain", "tl_chat", "tl_insight", "tl_assign_hint", "tl_sprint_scope", "tl_realism_explain"];

// ── Gate: configured + per-user daily limit ──────────────────────────────────
async function usageOf(req, org) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [settings, used] = await Promise.all([Organization.findById(org._id, "aiSettings.managerDailyLimit").lean(), AIPromptLog.countDocuments({ orgId: req.user.orgId, createdAt: { $gte: start }, requestedBy: req.user.id, feature: { $regex: `^${FEATURE_PREFIX}` }, fromCache: { $ne: true } })]);
  return usageState(used, dailyLimit(settings)); // orgScope does not load aiSettings
}
// { cacheFirst: true }: the caller serves a cached result before checking the limit (a cache hit costs nothing),
// then calls overLimit() before a real AI call.
async function gate(req, res, { cacheFirst = false } = {}) {
  const scope = await orgScope(req.user.orgId);
  if (!scope) { res.status(404).json({ error: "Organization not found." }); return null; }
  if (!aiConfigured()) { res.status(503).json({ error: "AI is not configured on this server. Everything else works as usual.", code: "ai_off" }); return null; }
  const usage = await usageOf(req, scope.org);
  if (!cacheFirst && overLimit(res, usage)) return null;
  return { scope, usage };
}
function overLimit(res, usage) {
  if (usage.remaining) return false;
  res.status(429).json({ error: `You have used today's ${usage.limit} AI requests. They reset at midnight.`, code: "limit", usage });
  return true;
}
// Cached result → answer it; { cacheOnly } → say there is none; over the limit → 429. Returns true when answered.
async function served(req, res, g, key) {
  const hit = req.body?.refresh ? null : await cacheGet(key);
  if (hit) { res.json({ ...hit.value, cached: true, cachedAt: hit.updatedAt, key, usage: g.usage, aiGenerated: true }); return true; }
  if (req.body?.cacheOnly) { res.json({ cached: false, key, usage: g.usage }); return true; }
  return overLimit(res, g.usage);
}
const spent = (u, fromCache) => (fromCache ? u : { ...u, used: u.used + 1, remaining: Math.max(0, u.remaining - 1) });
function aiFail(res, err, usage) {
  if (err.status === 422) return res.status(502).json({ error: "The AI answer was not usable. Try again.", code: "invalid", usage });
  return res.status(503).json({ error: "AI is busy or unavailable right now. Try again shortly.", code: "busy", usage });
}

// One validated call: the validator runs on every reply (one retry, then 422 → "not usable").
async function ask(req, { feature, promptId, data, check }) {
  const prompt = getPrompt(promptId);
  const r = await callChain({
    feature, orgId: req.user.orgId, requestedBy: req.user.id, promptId: prompt.id, promptVersion: prompt.version,
    systemPrompt: prompt.system, temperature: prompt.temperature, maxTokens: prompt.maxTokens, maxInvalid: 2,
    userMessage: prompt.userTemplate(data), validate: (t) => check(parseJsonLoose(t)).ok,
  });
  const v = check(parseJsonLoose(r.text));
  if (!v.ok) throw Object.assign(new Error("invalid"), { status: 422 });
  return { value: v.value, fromCache: !!r.fromCache };
}

// AICache (D-106)
const cacheGet = (key) => AICache.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
const cachePut = (key, orgId, feature, value, ttlMs) => AICache.findOneAndUpdate({ key },
  { $set: { orgId, feature, value, dismissed: false, expiresAt: new Date(Date.now() + ttlMs) } }, { upsert: true, new: true }).lean();
const endOfDay = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return +d - Date.now(); };

// ── Snapshots (numbers only, short references) ───────────────────────────────
async function workload(scope, userId) {
  const users = await User.find({ ...scope.filter, status: { $ne: "deleted" }, role: { $nin: LEADERS } }, "_id").lean();
  const [snaps, me] = await Promise.all([getBulkWorkloadSnapshots(users.map((u) => u._id), { workTime: orgWorkTime(scope.org) }), User.findById(userId, "workloadThresholdPct").lean()]);
  const threshold = effectiveThreshold(scope.org.workloadThresholdPct, me?.workloadThresholdPct);
  return { threshold, members: snaps.map((s) => ({ id: s.userId, name: s.name, role: s.role, utilisation: s.utilisation, load: loadLabel(s.utilisation),
    status: statusBadge({ utilisation: s.utilisation, hp: s.hp, threshold }), activeTasks: s.activeTaskCount, freeHoursPerDay: s.availableHours })).sort((a, b) => b.utilisation - a.utilisation) };
}

async function teamSnapshot(req, scope, refs, { projectId = null } = {}) {
  const [home, wl] = await Promise.all([capture(getHome, req), workload(scope, req.user.id)]);
  const h = home.body ?? {};
  const projects = (h.projects ?? []).filter((p) => !projectId || String(p.id) === String(projectId));
  let members = wl.members;
  if (projectId) {
    const p = await Project.findById(projectId, "members").lean();
    const set = new Set((p?.members ?? []).map(String));
    members = members.filter((m) => set.has(String(m.id)));
  }
  const tiers = members.reduce((a, m) => ({ ...a, [m.status]: (a[m.status] ?? 0) + 1 }), {});
  return {
    projects: projects.slice(0, 10).map((p) => ({ ref: refs.add("p", p.id), title: p.title, health: p.healthScore == null ? p.healthBand : `${p.healthScore} (${p.healthBand})`, progressPct: p.progressPct, overdueTasks: p.overdueTasks, deadline: p.deadline })),
    tasks: h.tasks, dueThisWeek: h.deadlinesThisWeek ? { tasks: h.deadlinesThisWeek.tasks, projects: h.deadlinesThisWeek.projects.length } : undefined,
    activeSprints: (h.sprints ?? []).slice(0, 6).map((s) => ({ ref: refs.add("s", s.id), name: s.name, done: s.done, total: s.total, endDate: s.endDate })),
    teamActivity: h.teamActivity, openAnomalies: h.openAnomalies, runningChallenges: h.runningChallenges,
    workloadLimitPct: wl.threshold, membersByStatus: tiers,
    members: members.slice(0, 15).map((m) => ({ ref: refs.add("m", m.id), name: m.name, role: m.role, load: m.load, status: m.status, activeTasks: m.activeTasks, freeHoursPerDay: m.freeHoursPerDay })),
    _overloaded: members.filter((m) => m.status === "Overloaded").length, _sprints: h.sprints ?? [], _overdue: h.tasks?.overdue ?? 0,
  };
}
const strip = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.startsWith("_")));

async function sprintSnapshot(req, id) {
  const d = await capture(getSprintDetail, req, { params: { id } });
  if (d.status !== 200) return { error: d };
  const s = d.body;
  const out = { name: s.name, status: s.status, goal: s.goal, startDate: s.startDate, endDate: s.endDate, project: s.project?.title, stats: s.stats, capacity: s.capacity,
    tasks: s.tasks.slice(0, 20).map((t) => ({ title: t.title, status: t.status, priority: t.priority, estimatedHours: t.estimatedHours, deadline: t.deadline, people: t.assignees.map((a) => a.name) })) };
  if (s.status === "Closed") { const sum = await capture(getSprintSummary, req, { params: { id } }); if (sum.status === 200) out.summary = prune(sum.body.summary); }
  return { snap: out, detail: s };
}

async function reportSnapshot(req, query) {
  const [del, ppl, wb] = await Promise.all([capture(getDelivery, req, { query }), capture(getPeople, req, { query }), capture(getWellbeing, req, { query })]);
  if (del.status !== 200) return { error: del };
  const rows = ppl.body?.rows ?? [];
  return { snap: {
    filters: del.body.filters, current: del.body.current, previous: del.body.previous, change: del.body.delta,
    velocityPerSprint: (del.body.sprints ?? []).map((s) => ({ name: s.name, velocity: s.velocity })),
    people: { count: rows.length, totalRework: rows.reduce((a, r) => a + (r.rework ?? 0), 0), withNoDoneTask: rows.filter((r) => !r.tasksDone).length },
    wellbeing: wb.status === 200 ? { counts: wb.body.current, scope: wb.body.trendScope } : undefined,
  } };
}

// Lists for the context chip: the caller's org only.
async function contextLists(scope) {
  const [projects, sprints] = await Promise.all([
    Project.find({ ...scope.filter, isDeleted: { $ne: true }, status: { $nin: ["Deleted"] } }, "title status").sort({ updatedAt: -1 }).limit(200).lean(),
    Sprint.find({ ...scope.filter }, "name status").sort({ updatedAt: -1 }).limit(200).lean(),
  ]);
  return { projects: projects.map((p) => ({ id: String(p._id), title: p.title, status: p.status })), sprints: sprints.map((s) => ({ id: String(s._id), name: s.name, status: s.status })) };
}
function readContext(body, lists) {
  const c = body?.context ?? {};
  if (c.kind === "path") return resolveContext(contextFromPath(c.path, c.search), lists);
  return resolveContext({ kind: c.kind, id: c.id, query: c.query }, lists);
}

// ── GET /api/manager/ai/context?path=&search=&kind=&id=&query= ───────────────
// Panel header data: AI on/off, usage, the chip (+ choices), suggested prompts, proactive cards. No AI call.
export async function getContext(req, res) {
  const scope = await orgScope(req.user.orgId);
  if (!scope) return res.status(404).json({ error: "Organization not found." });
  const lists = await contextLists(scope);
  const ctx = readContext({ context: req.query.kind ? req.query : { ...req.query, kind: "path" } }, lists);
  const refs = makeRefs();
  const [usage, snap, insight] = await Promise.all([
    usageOf(req, scope.org), teamSnapshot(req, scope, refs),
    cacheGet(cacheKey("mgr_insight", { user: req.user.id, day: dayKey() })),
  ]);
  const soon = snap._sprints.filter((s) => s.endDate && +new Date(s.endDate) - Date.now() < 3 * DAY && s.total > s.done)
    .map((s) => ({ id: s.id, name: s.name, days: Math.max(0, Math.ceil((+new Date(s.endDate) - Date.now()) / DAY)), left: s.total - s.done }));
  res.json({
    configured: aiConfigured(), usage, context: ctx, prompts: PROMPTS_FOR[ctx.kind] ?? PROMPTS_FOR.team,
    cards: proactiveCards({ overloaded: snap._overloaded, overdue: snap._overdue, openAnomalies: snap.openAnomalies, sprintsEndingSoon: soon }),
    insight: insight && !insight.dismissed && insight.value?.kind !== "none" ? insight.value : null,
    choices: [{ kind: "team", label: "Team" },
      ...lists.projects.filter((p) => p.status !== "Archived").slice(0, 25).map((p) => ({ kind: "project", id: p.id, label: `Project: ${p.title}` })),
      ...lists.sprints.filter((s) => s.status !== "Completed").slice(0, 25).map((s) => ({ kind: "sprint", id: s.id, label: `Sprint: ${s.name}` })),
      ...(ctx.kind === "reports" ? [ctx] : [])],
  });
}

// ── Chat history ─────────────────────────────────────────────────────────────
export async function listChats(req, res) {
  const chats = await AIChat.find({ userId: req.user.id, orgId: req.user.orgId }, "title updatedAt").sort({ updatedAt: -1 }).limit(30).lean();
  res.json({ chats: chats.map((c) => ({ id: c._id, title: c.title, updatedAt: c.updatedAt })) });
}
export async function getChat(req, res) {
  if (!valid(req.params.id)) return res.status(404).json({ error: "Chat not found." });
  const c = await AIChat.findOne({ _id: req.params.id, userId: req.user.id, orgId: req.user.orgId }).lean();
  if (!c) return res.status(404).json({ error: "Chat not found." });
  res.json({ id: c._id, title: c.title, messages: c.messages.map((m) => ({ id: m._id, role: m.role, text: m.text, sources: m.sources, context: m.context, at: m.createdAt })) });
}

// ── POST /api/manager/ai/chat { chatId?, message, context: { kind, id?, query? } | { kind: "path", path, search } } ──
export async function chat(req, res) {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Type a question first." });
  if (message.length > 1000) return res.status(400).json({ error: "Keep the question under 1000 characters." });
  const chatId = req.body?.chatId;
  if (chatId && !valid(chatId)) return res.status(404).json({ error: "Chat not found." });
  const existing = chatId ? await AIChat.findOne({ _id: chatId, userId: req.user.id, orgId: req.user.orgId }) : null;
  if (chatId && !existing) return res.status(404).json({ error: "Chat not found." });
  const g = await gate(req, res); if (!g) return;

  const lists = await contextLists(g.scope);
  const ctx = readContext(req.body, lists);
  const refs = makeRefs();
  const team = await teamSnapshot(req, g.scope, refs, { projectId: ctx.kind === "project" ? ctx.id : null });
  const snapshot = strip(team);
  if (ctx.kind === "sprint") { const s = await sprintSnapshot(req, ctx.id); if (s.snap) snapshot.sprint = s.snap; }
  if (ctx.kind === "reports") { const r = await reportSnapshot(req, Object.fromEntries(new URLSearchParams(ctx.query))); if (r.snap) snapshot.report = r.snap; }
  const sources = sourcesFor(ctx);
  const history = (existing?.messages ?? []).slice(-6).map((m) => ({ role: m.role, text: m.text.slice(0, 400) }));
  try {
    const { value, fromCache } = await ask(req, {
      feature: "mgr_chat", promptId: "mgr-chat", check: (o) => validateChat(o, sources),
      data: { today: new Date().toISOString().slice(0, 10), context: ctx.label, sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.label])), snapshot, history, question: message },
    });
    const chatDoc = existing ?? new AIChat({ orgId: req.user.orgId, userId: req.user.id, title: message.slice(0, 60) });
    const cited = value.sources.map((k) => ({ key: k, ...sources[k] }));
    value.answer = named(value.answer, team);
    chatDoc.messages.push({ role: "user", text: message, context: ctx.label }, { role: "ai", text: value.answer, sources: cited, context: ctx.label });
    if (chatDoc.messages.length > 200) chatDoc.messages.splice(0, chatDoc.messages.length - 200);
    await chatDoc.save();
    const last = chatDoc.messages[chatDoc.messages.length - 1];
    res.json({ chatId: chatDoc._id, title: chatDoc.title, message: { id: last._id, role: "ai", text: last.text, sources: cited, context: ctx.label }, usage: spent(g.usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, g.usage); }
}

// ── POST /api/manager/ai/feedback { feature, refId, rating: up|down, snippet? } ──
export async function feedback(req, res) {
  const { feature, refId, rating } = req.body ?? {};
  if (!FEATURES.includes(feature)) return res.status(400).json({ error: "Unknown AI feature." });
  if (typeof refId !== "string" || !refId.trim() || refId.length > 200) return res.status(400).json({ error: "Which answer is this about?" });
  if (!["up", "down"].includes(rating)) return res.status(400).json({ error: "Rating is up or down." });
  if ((feature === "mgr_chat" || feature === "tl_chat") && !(valid(refId) && await AIChat.exists({ userId: req.user.id, orgId: req.user.orgId, "messages._id": refId }))) return res.status(404).json({ error: "Answer not found." });
  await AIFeedback.findOneAndUpdate({ userId: req.user.id, feature, refId },
    { $set: { orgId: req.user.orgId, rating, snippet: String(req.body?.snippet ?? "").slice(0, 500) } }, { upsert: true });
  res.json({ ok: true, rating });
}

// ── (a) Dashboard insight: GET /api/manager/ai/insight?refresh=1 · POST /ai/insight/dismiss ──
const targetLink = (refs, ref, snap) => {
  if (!ref) return null;
  const id = refs.id(ref);
  if (ref.startsWith("m")) return { kind: "member", id, label: `Open ${snap.members.find((m) => m.ref === ref)?.name ?? "person"} in Resources`, to: `/manager/resources?member=${id}` };
  if (ref.startsWith("p")) return { kind: "project", id, label: `Open ${snap.projects.find((p) => p.ref === ref)?.title ?? "project"}`, to: `/manager/projects/${id}` };
  return { kind: "sprint", id, label: `Open ${snap.activeSprints.find((s) => s.ref === ref)?.name ?? "sprint"}`, to: `/manager/sprints/${id}` };
};
// Names instead of references in the text the Manager reads.
const namesOf = (snap) => Object.fromEntries([...snap.members.map((m) => [m.ref, m.name]), ...snap.projects.map((p) => [p.ref, p.title]), ...snap.activeSprints.map((x) => [x.ref, x.name])]);
const named = (text, snap) => withNames(text, namesOf(snap));

export async function getInsight(req, res) {
  const g = await gate(req, res, { cacheFirst: true }); if (!g) return;
  const key = cacheKey("mgr_insight", { user: req.user.id, day: dayKey() });
  const hit = req.query.refresh ? null : await cacheGet(key);
  if (hit) return res.json({ insight: hit.value, dismissed: hit.dismissed, cached: true, cachedAt: hit.updatedAt, key, usage: g.usage, aiGenerated: true });
  if (overLimit(res, g.usage)) return;
  const refs = makeRefs();
  const snap = await teamSnapshot(req, g.scope, refs);
  try {
    const { value, fromCache } = await ask(req, { feature: "mgr_insight", promptId: "mgr-insight", data: strip(snap), check: (o) => validateInsight(o, refs) });
    const view = value.kind === "none" ? { kind: "none" } : {
      kind: value.kind, title: named(value.title, snap), body: named(value.body, snap), why: value.why.map((w) => named(w, snap)), target: targetLink(refs, value.target, snap),
    };
    const saved = await cachePut(key, req.user.orgId, "mgr_insight", view, endOfDay());
    res.json({ insight: view, dismissed: false, cachedAt: saved.updatedAt, key, usage: spent(g.usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, g.usage); }
}
export async function dismissInsight(req, res) {
  const key = cacheKey("mgr_insight", { user: req.user.id, day: dayKey() });
  const r = await AICache.updateOne({ key }, { $set: { dismissed: !req.body?.undo } });
  if (!r.matchedCount) return res.status(404).json({ error: "There is no insight to dismiss today." });
  res.json({ ok: true, dismissed: !req.body?.undo });
}

// ── (b) Sprint narrative (closed) and capacity-fit scope (planned) ───────────
export async function sprintNarrative(req, res) {
  if (!valid(req.params.id)) return res.status(404).json({ error: "Sprint not found." });
  const sum = await capture(getSprintSummary, req, { params: { id: req.params.id } });
  if (sum.status !== 200) return passOn(res, sum);
  const g = await gate(req, res, { cacheFirst: true }); if (!g) return;
  const key = cacheKey("mgr_sprint_narrative", { sprint: req.params.id });
  if (await served(req, res, g, key)) return;
  const s = sum.body;
  try {
    const { value, fromCache } = await ask(req, { feature: "mgr_sprint_narrative", promptId: "mgr-sprint-narrative", check: validateNarrative,
      data: prune({ sprint: s.name, goal: s.goal, startDate: s.startDate, endDate: s.endDate, summary: { ...s.summary, topContributors: (s.summary.topContributors ?? []).length }, velocityHistory: s.history.map((h) => ({ name: h.name, velocity: h.velocity, done: h.done, planned: h.planned })) }) });
    const saved = await cachePut(key, req.user.orgId, "mgr_sprint_narrative", value, 30 * DAY); // a closed sprint does not change
    res.json({ ...value, cachedAt: saved.updatedAt, key, usage: spent(g.usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, g.usage); }
}

export async function sprintScope(req, res) {
  if (!valid(req.params.id)) return res.status(404).json({ error: "Sprint not found." });
  const s = await sprintSnapshot(req, req.params.id);
  if (s.error) return passOn(res, s.error);
  if (s.detail.status !== "Planned") return res.status(409).json({ error: "Scope suggestions are for sprints that have not started." });
  const back = await capture(getSprintBacklog, req, { params: { id: req.params.id } });
  if (back.status !== 200) return passOn(res, back);
  const g = await gate(req, res); if (!g) return;
  const refs = makeRefs(), sprintHours = {}, backlogHours = {}, byRef = {};
  const row = (t, into) => { const ref = refs.add("t", t.id); into[ref] = t.estimatedHours ?? 0; byRef[ref] = t; return { ref, title: t.title, priority: t.priority, status: t.status, estimatedHours: t.estimatedHours, deadline: t.deadline }; };
  const capacity = s.detail.capacity.hours;
  const data = { capacity: { hours: capacity, people: s.detail.capacity.people, days: s.detail.capacity.days }, plannedHours: s.detail.stats.estimatedHours,
    sprintTasks: s.detail.tasks.slice(0, 30).map((t) => row(t, sprintHours)), backlog: back.body.tasks.slice(0, 30).map((t) => row(t, backlogHours)) };
  if (!data.sprintTasks.length && !data.backlog.length) return res.status(409).json({ error: "There are no tasks to plan yet." });
  try {
    const { value, fromCache } = await ask(req, { feature: "mgr_sprint_scope", promptId: "mgr-sprint-scope", data, check: (o) => validateScope(o, refs, { sprintHours, backlogHours, capacity }) });
    const out = (r) => ({ id: byRef[r].id, title: byRef[r].title, hours: byRef[r].estimatedHours ?? 0 });
    res.json({ add: value.add.map(out), remove: value.remove.map(out), why: value.why, hoursAfter: value.hoursAfter, capacity, usage: spent(g.usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, g.usage); }
}

// ── (c) Report narrative + lessons draft (query = the Reports filters) ──────
export async function reportNarrative(req, res) {
  const r = await reportSnapshot(req, req.query);
  if (r.error) return passOn(res, r.error);
  const g = await gate(req, res, { cacheFirst: true }); if (!g) return;
  const key = cacheKey("mgr_report_narrative", { org: req.user.orgId, query: new URLSearchParams(req.query).toString(), day: dayKey() });
  if (await served(req, res, g, key)) return;
  try {
    const { value, fromCache } = await ask(req, { feature: "mgr_report_narrative", promptId: "mgr-report-narrative", data: prune(r.snap), check: validateNarrative });
    const saved = await cachePut(key, req.user.orgId, "mgr_report_narrative", value, endOfDay());
    res.json({ ...value, cachedAt: saved.updatedAt, key, usage: spent(g.usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, g.usage); }
}

export async function lessonsDraft(req, res) {
  const les = await capture(getLessons, req, { query: req.query });
  if (les.status !== 200) return passOn(res, les);
  const g = await gate(req, res); if (!g) return;
  try {
    // Reuses the registry's lessons-learned prompt (D-075); the reply only fills the note box.
    const { value, fromCache } = await ask(req, { feature: "mgr_lessons", promptId: "lessons-learned", check: validateLessonsDraft,
      data: prune({ scope: les.body.filters, facts: les.body.facts, existingNotes: les.body.notes.slice(0, 5).map((n) => n.text.slice(0, 200)) }) });
    res.json({ ...value, draft: value.lessons.map((l) => `- ${l}`).join("\n"), usage: spent(g.usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, g.usage); }
}

// ── (d) Challenge draft from the team's weakest numbers (last 30 days) ──────
export async function challengeDraft(req, res) {
  const g = await gate(req, res); if (!g) return;
  const [del, ppl, opts] = await Promise.all([capture(getDelivery, req, { query: { range: "30d" } }), capture(getPeople, req, { query: { range: "30d" } }), capture(questOptions, req)]);
  if (opts.status !== 200) return passOn(res, opts);
  const metrics = opts.body.metrics.map((m) => m.value), cap = opts.body.cap;
  const rows = ppl.body?.rows ?? [];
  try {
    const { value, fromCache } = await ask(req, { feature: "mgr_challenge_draft", promptId: "mgr-challenge-draft", check: (o) => validateChallengeDraft(o, { metrics, cap }),
      data: prune({ last30Days: del.body?.current, previous30Days: del.body?.previous, team: { people: rows.length, totalRework: rows.reduce((a, r) => a + (r.rework ?? 0), 0) }, metrics: opts.body.metrics, cap }) });
    res.json({ draft: value, usage: spent(g.usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, g.usage); }
}

// ── (e) Rebalance hint: pick one of the engine's candidates (D-095) ─────────
export async function rebalanceHint(req, res) {
  if (!valid(req.params.id)) return res.status(404).json({ error: "Task not found." });
  const c = await capture(getCandidates, req, { params: { id: req.params.id }, query: { from: req.query.from } });
  if (c.status !== 200) return passOn(res, c);
  if (!c.body.candidates.length) return res.status(409).json({ error: "Nobody on this project can take this task, so there is nothing to suggest." });
  const g = await gate(req, res); if (!g) return;
  const refs = makeRefs();
  const data = { task: prune(c.body.task), from: { name: c.body.from.name, role: c.body.from.role, load: c.body.from.label, loadAfter: c.body.from.afterLabel }, workloadLimitPct: c.body.threshold,
    candidates: c.body.candidates.slice(0, 10).map((x, i) => ({ ref: refs.add("c", x.id), name: x.name, role: x.role, load: x.label, loadAfter: x.afterLabel, statusAfter: x.afterStatus, freeHoursPerDay: x.availableHours, engineRank: i + 1, engineReason: x.reason })) };
  try {
    const { value, fromCache } = await ask(req, { feature: "mgr_rebalance", promptId: "mgr-rebalance", data, check: (o) => validateRebalance(o, refs) });
    const pick = c.body.candidates.find((x) => String(x.id) === refs.id(value.candidate));
    res.json({ candidateId: pick.id, name: pick.name, reason: withNames(value.reason, Object.fromEntries(data.candidates.map((x) => [x.ref, x.name]))), usage: spent(g.usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, g.usage); }
}

// ── (f) Anomaly explain: neutral, no names in the prompt ────────────────────
export async function explainAnomaly(req, res) {
  if (!valid(req.params.flagId)) return res.status(404).json({ error: "Flag not found." });
  const a = await capture(getAnomaly, req, { params: { flagId: req.params.flagId } });
  if (a.status !== 200) return passOn(res, a);
  const g = await gate(req, res, { cacheFirst: true }); if (!g) return;
  const key = cacheKey("mgr_anomaly_explain", { flag: req.params.flagId });
  if (await served(req, res, g, key)) return;
  const f = a.body;
  const data = prune({ flag: f.label, rule: f.reason, status: f.status,
    task: { status: f.task.status, submittedAt: f.task.submittedAt, approvedAt: f.task.approvedAt, minutesToApprove: f.task.minutesToApprove, stars: f.task.stars, teamLeadScore: f.task.tlScore, aiScore: f.task.aiScore },
    xpAwarded: f.awards.map((x) => x.xp), people: f.people.map((p, i) => ({ who: `Person ${String.fromCharCode(65 + i)}`, role: p.role, last90Days: p.last90 })), otherFlagsSamePeople: f.otherFlags });
  try {
    const { value, fromCache } = await ask(req, { feature: "mgr_anomaly_explain", promptId: "mgr-anomaly-explain", data, check: validateExplain });
    const saved = await cachePut(key, req.user.orgId, "mgr_anomaly_explain", value, 7 * DAY);
    res.json({ ...value, cachedAt: saved.updatedAt, key, usage: spent(g.usage, fromCache), aiGenerated: true });
  } catch (err) { aiFail(res, err, g.usage); }
}
