// Employee AI (Batch 4: E14, E15, N11, N12; FR08-01/03, UC-13 step 4, UC-15, UC-16). Developers, Designers and Testers only
// (routes/workspaceRoutes.js). Suggest only: the one thing these routes write is the caller's own chat history and the AI
// cache; no task, XP or score is touched. Every prompt is built from the caller's own data (employeeAiRules.snapshotFor),
// never an AI score (D-075), never another person. Order on every AI route: input (400) → AI configured (503) → daily
// limit (429) → call. Slash commands and the charts make no AI call, so they work with the AI down.
import Task from "../models/Task.js";
import GamificationProfile from "../models/GamificationProfile.js";
import AIPromptLog from "../models/AIPromptLog.js";
import AIChat from "../models/AIChat.js";
import AICache from "../models/AICache.js";
import { getPrompt } from "../ai/prompts/registry.js";
import { callChain, aiConfigured } from "../services/aiChain.js";
import { parseJsonLoose } from "../services/aiEvalRules.js";
import { dayKey, cacheKey } from "../services/managerAiRules.js";
import { capture } from "../utils/capture.js";
import { today, listTasks } from "./workspaceController.js";
import { getLeaderboard } from "./gamificationController.js";
import { makeEmployeeAi, AI_OFF } from "../services/employeeAiService.js";
import {
  FEATURE_PREFIX, QUICK_PROMPTS, HELP_REPLY, personasFor, readPersona, readChat, readBoardQuery, commandOf, tasksReply, xpReply, snapshotFor,
  checkChat, checkTips, checkCommentary, checkSummary, fallbackTips, fallbackCommentary, fallbackSummary, analyticsOf,
} from "../services/employeeAiRules.js";

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const endOfDay = () => new Date(+startOfDay() + 86_400_000);
const ai = makeEmployeeAi({
  configured: aiConfigured,
  usedToday: (user) => AIPromptLog.countDocuments({ orgId: user.orgId, requestedBy: user.id, createdAt: { $gte: startOfDay() }, feature: { $regex: `^${FEATURE_PREFIX}` }, fromCache: { $ne: true } }),
  async call({ feature, promptId, data, check, orgId, requestedBy }) {
    const p = getPrompt(promptId);
    const r = await callChain({ feature, orgId, requestedBy, promptId: p.id, promptVersion: p.version, systemPrompt: p.system, temperature: p.temperature, maxTokens: p.maxTokens,
      maxInvalid: 2, userMessage: p.userTemplate(data), validate: (t) => check(parseJsonLoose(t)).ok });
    return r.text;
  },
});
const send = (res, r, shape = (v) => v) => res.status(r.status).json(r.status === 200 ? { ...shape(r.body.value), usage: r.body.usage, aiGenerated: r.body.aiGenerated, ...(r.body.fallback && { fallback: true, note: r.body.note }) } : r.body);

// The caller's own numbers. Reuses the Today and My tasks handlers, so the scope and the D-075 rules are theirs.
const MINE = (req) => ({ orgId: req.user.orgId, $or: [{ assignees: req.user.id }, { assignee: req.user.id }] });
const myAnalytics = async (req) => analyticsOf(await Task.find(MINE(req), "status deadline completedAt reviewedAt tlScore").limit(1000).lean());
// ponytail: Today and My tasks each load the task rows (two reads of ≤300 rows); share one loader if this page gets slow.
async function mine(req) {
  const [t, list, analytics] = await Promise.all([capture(today, req), capture(listTasks, req), myAnalytics(req)]);
  const d = t.body ?? {}, rows = list.body?.rows ?? [];
  const weekXp = (d.trend?.week ?? []).reduce((s, p) => s + p.xp, 0);
  return { d, rows, weekXp, analytics, snapshot: snapshotFor({ kind: req.user.roleCategory, tiles: d.tiles, hp: d.hp, weekXp, rank: d.rank, rows, totals: analytics.totals }) };
}
const ver = (id) => getPrompt(id).version; // a changed prompt starts a fresh cache
const cached = (key) => AICache.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
const remember = (req, key, feature, value) => AICache.updateOne({ key }, { $set: { orgId: req.user.orgId, feature, value, dismissed: false, expiresAt: endOfDay() } }, { upsert: true }).catch(() => {});
const view = (m) => ({ id: String(m._id), role: m.role, text: m.text, sources: (m.sources ?? []).map((s) => ({ key: s.key, label: s.label, to: s.to })), persona: m.context ?? null });

// ── GET /api/workspace/ai/status (no AI call) ────────────────────────────────
export async function getStatus(req, res) {
  const kind = req.user.roleCategory;
  const [usage, last] = await Promise.all([ai.usage(req.user), AIChat.findOne({ userId: req.user.id, orgId: req.user.orgId }).sort({ updatedAt: -1 }).lean()]);
  res.json({
    configured: ai.configured(), usage, personas: personasFor(kind).map(({ id, name, blurb }) => ({ id, name, blurb })), prompts: QUICK_PROMPTS[kind] ?? QUICK_PROMPTS.developer,
    commands: [{ command: "/tasks", label: "My open tasks" }, { command: "/xp", label: "My XP and level" }],
    chat: last ? { chatId: String(last._id), messages: last.messages.slice(-50).map(view) } : null,
  });
}

// ── POST /api/workspace/ai/chat { message, persona?, chatId? } (UC-15) ────────
export async function chat(req, res) {
  const v = readChat(req.body, req.user.roleCategory);
  if (!v.ok) return res.status(400).json({ error: v.error, field: v.field });
  const existing = v.chatId ? await AIChat.findOne({ _id: v.chatId, userId: req.user.id, orgId: req.user.orgId }) : null;
  if (v.chatId && !existing) return res.status(404).json({ error: "This chat could not be found." });
  const command = commandOf(v.message);
  let reply, usage, persona = v.persona.name;
  if (command) { // structured answer from the caller's own data; not an AI call, so it does not count and works with the AI off
    persona = "Command";
    if (command === "help") reply = HELP_REPLY;
    else {
      const m = await mine(req);
      if (command === "tasks") reply = tasksReply(m.rows);
      else {
        const p = await GamificationProfile.findOne({ userId: req.user.id }, "totalXp").lean();
        reply = xpReply({ ...m.d.tiles, totalXp: p?.totalXp ?? 0, weekXp: m.weekXp, rank: m.d.rank });
      }
    }
    usage = await ai.usage(req.user);
  } else {
    const m = await mine(req);
    const history = (existing?.messages ?? []).slice(-4).map((x) => ({ role: x.role, text: x.text.slice(0, 300) }));
    const r = await ai.ask({ user: req.user, feature: "emp_chat", promptId: v.persona.promptId, check: checkChat, data: { today: dayKey(), snapshot: m.snapshot, history, question: v.message } });
    if (r.status !== 200) return res.status(r.status).json(r.body);
    reply = { text: r.body.value.answer, sources: [] }; usage = r.body.usage;
  }
  const doc = existing ?? new AIChat({ orgId: req.user.orgId, userId: req.user.id, title: v.message.slice(0, 60) });
  doc.messages.push({ role: "user", text: v.message, context: persona }, { role: "ai", text: reply.text.slice(0, 2000), sources: reply.sources, context: persona });
  if (doc.messages.length > 200) doc.messages.splice(0, doc.messages.length - 200);
  await doc.save();
  res.json({ chatId: String(doc._id), message: view(doc.messages.at(-1)), usage, aiGenerated: !command });
}

// ── GET /api/workspace/ai/tips?persona=momentum|expert&refresh=1 (E15, FR08-03): once a day per persona ───────────
export async function getTips(req, res) {
  const persona = readPersona(req.query.persona, req.user.roleCategory);
  if (!persona) return res.status(400).json({ error: "Pick MomentumCoach or your expert.", field: "persona" });
  if (!ai.configured()) return res.status(503).json(AI_OFF);
  const key = cacheKey("emp_tips", { user: req.user.id, persona: persona.id, day: dayKey(), v: ver(persona.tipsPromptId) });
  const hit = req.query.refresh ? null : await cached(key);
  const who = { id: persona.id, name: persona.name };
  if (hit) return res.json({ ...hit.value, persona: who, cached: true, usage: await ai.usage(req.user), aiGenerated: true });
  const m = await mine(req);
  const r = await ai.ask({ user: req.user, feature: "emp_tips", promptId: persona.tipsPromptId, data: m.snapshot, check: checkTips, fallback: () => fallbackTips(m.snapshot) });
  if (r.status === 200 && r.body.aiGenerated) remember(req, key, "emp_tips", r.body.value);
  send(res, r, (value) => ({ ...value, persona: who }));
}

// ── GET /api/workspace/ai/leaderboard-line?scope=&period=&projectId= (N11, UC-13 step 4) ─────────────────────────
// One line about the caller's own place. Only their rank, the number of people ranked and the XP gap go to the AI.
export async function getBoardLine(req, res) {
  const q = readBoardQuery(req.query);
  if (!q.ok) return res.status(400).json({ error: q.error, field: q.field });
  if (!ai.configured()) return res.status(503).json(AI_OFF);
  const board = await capture(getLeaderboard, req, { query: q.query });
  const rows = board.status === 200 && board.body.enough ? board.body.rows : [];
  const me = rows.find((r) => r.isUser);
  if (!me) return res.json({ ...fallbackCommentary(null), aiGenerated: false });
  const above = rows.filter((r) => r.xp > me.xp).sort((a, b) => a.xp - b.xp)[0];
  const rank = { rank: me.rank, total: rows.length, xpToNextRank: above ? above.xp - me.xp : 0 };
  const data = { role: req.user.roleCategory, view: board.body.scope, period: board.body.period, rank: rank.rank, peopleRanked: rank.total, ...(rank.rank === 1 ? { leads: true } : { xpToNextRank: rank.xpToNextRank }), myXp: me.xp, movedSinceLastWeek: me.change?.dir === "up" ? me.change.by : me.change?.dir === "down" ? -me.change.by : 0 };
  const key = cacheKey("emp_board", { user: req.user.id, day: dayKey(), scope: board.body.scope, period: board.body.period, project: q.query.projectId, rank: me.rank, gap: rank.xpToNextRank, xp: me.xp, v: ver("emp-board-line") });
  const hit = await cached(key);
  if (hit) return res.json({ ...hit.value, cached: true, aiGenerated: true });
  const r = await ai.ask({ user: req.user, feature: "emp_board", promptId: "emp-board-line", data, check: checkCommentary, fallback: () => fallbackCommentary(rank) });
  if (r.status === 429) return res.json({ ...fallbackCommentary(rank), aiGenerated: false, fallback: true }); // the page stays whole at the limit
  if (r.status === 200 && r.body.aiGenerated) remember(req, key, "emp_board", r.body.value);
  send(res, r);
}

// ── GET /api/workspace/analytics (N12, UC-16 step 3): charts from the caller's own tasks, no AI call ─────────────
export async function getAnalytics(req, res) {
  res.json(await myAnalytics(req));
}

// ── GET /api/workspace/ai/analytics-summary?refresh=1 (N12, UC-16 step 4) ─────────────────────────────────────────
export async function getAnalyticsSummary(req, res) {
  if (!ai.configured()) return res.status(503).json(AI_OFF);
  const a = await myAnalytics(req), t = a.totals;
  const key = cacheKey("emp_analytics", { user: req.user.id, day: dayKey(), done: t.done, total: t.total, quality: t.avgQuality, v: ver("emp-analytics-summary") });
  const hit = req.query.refresh ? null : await cached(key);
  if (hit) return res.json({ ...hit.value, cached: true, usage: await ai.usage(req.user), aiGenerated: true });
  if (!t.total) return res.json({ ...fallbackSummary(t), aiGenerated: false });
  const data = { role: req.user.roleCategory, results: snapshotFor({ kind: req.user.roleCategory, totals: t }).results, last8Weeks: a.weeks.map((w) => ({ weekOf: w.weekStart, tasksDue: w.due, tasksDone: w.done, completionPct: w.completionPct, avgReviewScore: w.quality })) };
  const r = await ai.ask({ user: req.user, feature: "emp_analytics", promptId: "emp-analytics-summary", data, check: checkSummary, fallback: () => fallbackSummary(t) });
  if (r.status === 429) return res.json({ ...fallbackSummary(t), usage: r.body.usage, aiGenerated: false, fallback: true, note: "Today's AI requests are used, so this comes from your numbers." });
  if (r.status === 200 && r.body.aiGenerated) remember(req, key, "emp_analytics", r.body.value);
  send(res, r);
}
