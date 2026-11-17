import { callChain, neutralizeInjection } from "../services/aiChain.js";
import { getPrompt }    from "../ai/prompts/registry.js";
import AIPromptLog      from "../models/AIPromptLog.js";
import Organization     from "../models/Organization.js";
import Notification     from "../models/Notification.js";
import User             from "../models/User.js";
import { dailyCapUsd } from "../services/aiCap.js";
import { periodFor, recapCards, aiRecapSummary } from "../services/recapService.js";
import { periodRange, completedPeriodFor, weekDay, weekSoFarText } from "../services/recapMetrics.js";
import { citationUrl } from "../services/citationUrl.js";
import { computeOrgHealth } from "../services/orgHealthService.js";
import { bandOf } from "../services/orgHealthRules.js";
import { rebalanceBasis } from "../services/heatmapRules.js";

const IS_OID = /^[0-9a-f]{24}$/i;

function orgFilter(orgId) {
  return IS_OID.test(orgId) ? { _id: orgId } : { orgId };
}

function requireDirector(req, res) {
  if ((req.user.roleCategory ?? req.user.role?.toLowerCase()) !== "director") {
    res.status(403).json({ error: "Director only." });
    return false;
  }
  return true;
}

// ── POST /api/director/ai/explain ────────────────────────────────────────────
// Body: { chart: "org-health" | "capacity" }
// Returns: { explanation, aiGenerated: true }
export async function explainChart(req, res) {
  if (!requireDirector(req, res)) return;
  const { orgId, id: userId } = req.user;
  const { chart, data } = req.body;

  if (!chart) return res.status(400).json({ error: "chart is required." });

  try {
    const prompt = getPrompt("explain-chart");
    // QA3 G-3: for Org Health the numbers come from the server (points per factor, bands, inputs), never from what the page sent.
    let payload = data ?? {};
    if (chart === "org-health") {
      const h = await computeOrgHealth(orgId);
      payload = { overall: h.overall, band: bandOf(h.overall), note: "The factors' points add up to the overall score. For 'Risk control' a HIGHER score means FEWER open risks (good).",
        factors: h.explain.map(({ label, score, band, weightPct, points, input, enough }) => ({ label, score, band, weightPct, points, enough, input })) };
    }
    const result = await callChain({
      feature: "explain", orgId, requestedBy: userId,
      promptId: prompt.id, promptVersion: prompt.version,
      systemPrompt: prompt.system,
      userMessage:  prompt.userTemplate({ chart, ...payload }),
      validate: prompt.validate,
    });
    res.json({ explanation: result.text, aiGenerated: true });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

// ── POST /api/director/ai/rebalance ─────────────────────────────────────────
// Returns: { suggestion, aiGenerated: true }
export async function suggestRebalance(req, res) {
  if (!requireDirector(req, res)) return;
  const { orgId, id: userId } = req.user;
  const { data } = req.body;
  // QA2-20: ask the AI only when a team is over capacity and another has room; the AI sees names and loads, nothing else.
  const basis = rebalanceBasis(data);
  if (!basis.ok) return res.json({ suggestion: null, reason: basis.reason, aiGenerated: false });

  try {
    const prompt = getPrompt("rebalance-suggestion");
    const result = await callChain({
      feature: "rebalance", orgId, requestedBy: userId,
      promptId: prompt.id, promptVersion: prompt.version,
      systemPrompt: prompt.system,
      userMessage:  prompt.userTemplate({ teams: basis.teams }),
      validate: prompt.validate,
    });
    res.json({ suggestion: result.text, aiGenerated: true });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

// ── POST /api/director/ai/rebalance/send ─────────────────────────────────────
// Body: { note, managerId } — send editable note to Manager as Notification
export async function sendRebalanceToManager(req, res) {
  if (!requireDirector(req, res)) return;
  const { orgId, id: userId } = req.user;
  const { note, managerId } = req.body;

  if (!note || !managerId) return res.status(400).json({ error: "note and managerId are required." });

  const manager = await User.findOne({ _id: managerId, orgId, role: "Manager", isActive: true }).lean();
  if (!manager) return res.status(404).json({ error: "Manager not found." });

  await Notification.create({
    userId:  manager._id,
    orgId,
    type:    "system",
    tier:    "fyi",
    title:   "Capacity Rebalance Suggestion",
    message: `[AI-generated] ${note}`,
  });

  res.json({ ok: true });
}

// ── POST /api/director/ai/weekly-summary ────────────────────────────────────
// Generates a weekly summary if aiSettings.weeklySummaryEnabled is true.
// Stores as Notification (fyi) and returns the text.
export async function weeklySummary(req, res) {
  if (!requireDirector(req, res)) return;
  const { orgId, id: userId } = req.user;

  // Item 26 (D-538): the weekly summary is always on (item 42), so there is no "disabled in settings" refusal any more, and the AI is
  // given this week's real numbers (before, it was given only the organisation id and had nothing to say).
  const org = await Organization.findOne(orgFilter(orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });
  // QA3 G-18 (decision 6): the AI summarises the last COMPLETED week only. The running week gets plain "so far" numbers and no comparison.
  const period = completedPeriodFor("weekly");
  const cards = await recapCards(org, period);
  const running = periodFor("weekly"), day = weekDay();
  const weekSoFar = { day, period: periodRange(running.start, running.end), text: weekSoFarText(await recapCards(org, running), day) };
  const r = await aiRecapSummary({ orgId, userId, periodLabel: `Weekly recap, ${periodRange(period.start, period.end)}`, cards });
  if (!r.text) {
    const E = { not_configured: [503, "AI is not configured."], cap: [429, "The daily AI limit is reached. Try again tomorrow."], busy: [502, "The AI is busy right now. Try again in a moment."] }[r.error];
    return res.status(E[0]).json({ error: E[1], code: r.error });
  }
  // Store as fyi Notification for the Director
  await Notification.create({ userId, orgId, type: "system", tier: "fyi", title: "Weekly AI Summary", message: `[AI-generated] ${r.text}` });
  res.json({ summary: r.text, period: periodRange(period.start, period.end), label: "Last week", weekSoFar, aiGenerated: true });
}

// ── GET /api/director/ai/status ──────────────────────────────────────────────
// Returns whether AI is configured and daily usage.
export async function aiStatus(req, res) {
  if (!requireDirector(req, res)) return;
  const { orgId } = req.user;

  const configured = !!(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY);

  const org = await Organization.findOne(orgFilter(orgId), "aiSettings").lean();
  const cap = dailyCapUsd(org, 1.0); // env AI_DAILY_COST_CAP_USD wins (item 42)

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const agg = await AIPromptLog.aggregate([
    { $match: { orgId, createdAt: { $gte: start }, configured: true } },
    { $group: { _id: null, total: { $sum: "$costUsd" } } },
  ]);
  const spentToday = agg[0]?.total ?? 0;

  res.json({ configured, cap, spentToday, chain: { groq: !!process.env.GROQ_API_KEY, openrouter: !!process.env.OPENROUTER_API_KEY } });
}

// ── POST /api/director/ai/ask ─────────────────────────────────────────────────
// Body: { question: string }
// Returns: { answer, citations[], aiGenerated, fromCache }
export async function askAchievion(req, res) {
  if (!requireDirector(req, res)) return;
  const { orgId, id: userId, role } = req.user;
  const rawQuestion = req.body?.question;
  if (!rawQuestion?.trim()) return res.status(400).json({ error: "question is required." });
  const question = neutralizeInjection(rawQuestion);

  // Conversation history (last 6 turns) — only text + role kept
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory.slice(-6).map((m) => ({
    role: m.role === "user" ? "user" : "ai",
    text: String(m.text ?? "").slice(0, 200),
  }));

  try {
    // Lazy import ragStore (initialises embedder on first call)
    const { query: ragQuery, indexSize, ensureIndexFresh, hasEnoughData } = await import("../services/rag/ragStore.js");

    // QA2-66: build the index on the first question and rebuild it when a project or task changed since (no manual "reindex")
    const { default: mongoose } = await import("mongoose");
    await ensureIndexFresh(orgId, mongoose).catch(() => {});

    // "Not enough data" guard: nothing indexed at all (an empty organisation) → safe empty response
    if (!hasEnoughData(indexSize(orgId))) {
      return res.json({ answer: "Nothing has been added to this organisation yet, so there is nothing to answer from.", citations: [], aiGenerated: false, notEnoughData: true });
    }

    const hits = await ragQuery(question, { orgId, role, topK: 5 });
    // ponytail: truncate each hit to 300 chars — keeps context under ~1500 tokens total
    const context = hits.map((h, i) => `[${i + 1}] ${h.text.slice(0, 300)}`).join("\n").slice(0, 2000);
    const citations = hits.map((h) => ({ source: h.source, ref: h.ref, text: h.text.slice(0, 80), url: citationUrl(h.source, h.ref) }));

    // Build history string for the prompt
    const historyStr = history.length
      ? "\n\nConversation history:\n" + history.map((m) => `${m.role === "user" ? "Director" : "AI"}: ${m.text}`).join("\n")
      : "";

    const today = new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

    const prompt = getPrompt("ask-achievion");
    const result = await callChain({
      feature: "ask", orgId, requestedBy: userId,
      promptId: prompt.id, promptVersion: prompt.version,
      systemPrompt: prompt.system,
      userMessage:  prompt.userTemplate({ question, context: { retrieved: context }, history: historyStr, today }),
      validate: prompt.validate,
    });

    res.json({ answer: result.text, citations, aiGenerated: true, fromCache: result.fromCache ?? false });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

// ── POST /api/director/ai/reindex ─────────────────────────────────────────────
// Rebuilds RAG index for the Director's org.
export async function reindexRag(req, res) {
  if (!requireDirector(req, res)) return;
  const { orgId } = req.user;
  try {
    const { default: mongoose } = await import("mongoose");
    const { reindexOrg } = await import("../services/rag/ragStore.js");
    const { indexed } = await reindexOrg(orgId, mongoose);
    res.json({ ok: true, indexed });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}
