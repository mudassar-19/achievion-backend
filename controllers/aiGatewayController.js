import { callChain, neutralizeInjection } from "../services/aiChain.js";
import { getPrompt }    from "../ai/prompts/registry.js";
import AIPromptLog      from "../models/AIPromptLog.js";
import Organization     from "../models/Organization.js";
import Notification     from "../models/Notification.js";
import User             from "../models/User.js";

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
    const result = await callChain({
      feature: "explain", orgId, requestedBy: userId,
      promptId: prompt.id, promptVersion: prompt.version,
      systemPrompt: prompt.system,
      userMessage:  prompt.userTemplate({ chart, ...(data ?? {}) }),
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

  try {
    const prompt = getPrompt("rebalance-suggestion");
    const result = await callChain({
      feature: "rebalance", orgId, requestedBy: userId,
      promptId: prompt.id, promptVersion: prompt.version,
      systemPrompt: prompt.system,
      userMessage:  prompt.userTemplate(data ?? {}),
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

  const org = await Organization.findOne(orgFilter(orgId), "aiSettings _id").lean();
  if (!org?.aiSettings?.weeklySummaryEnabled) {
    return res.status(400).json({ error: "Weekly summary is disabled in AI settings." });
  }

  try {
    const prompt = getPrompt("weekly-summary");
    const result = await callChain({
      feature: "weekly_summary", orgId, requestedBy: userId,
      promptId: prompt.id, promptVersion: prompt.version,
      systemPrompt: prompt.system,
      userMessage:  prompt.userTemplate({ orgId }),
      validate: prompt.validate,
    });

    // Store as fyi Notification for the Director
    await Notification.create({
      userId:  userId,
      orgId,
      type:    "system",
      tier:    "fyi",
      title:   "Weekly AI Summary",
      message: `[AI-generated] ${result.text}`,
    });

    res.json({ summary: result.text, aiGenerated: true });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

// ── GET /api/director/ai/status ──────────────────────────────────────────────
// Returns whether AI is configured and daily usage.
export async function aiStatus(req, res) {
  if (!requireDirector(req, res)) return;
  const { orgId } = req.user;

  const configured = !!(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY);

  const org = await Organization.findOne(orgFilter(orgId), "aiSettings").lean();
  const cap = org?.aiSettings?.costCapUsdPerDay ?? 1.0;

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
    const { query: ragQuery, indexSize, reindexOrg } = await import("../services/rag/ragStore.js");

    // Reindex if empty
    if (indexSize(orgId) === 0) {
      const { default: mongoose } = await import("mongoose");
      await reindexOrg(orgId, mongoose).catch(() => {});
    }

    // "Not enough data" guard: fewer than 5 indexed docs → safe empty response
    if (indexSize(orgId) < 5) {
      return res.json({ answer: "Not enough data to answer.", citations: [], aiGenerated: false, notEnoughData: true });
    }

    const hits = await ragQuery(question, { orgId, role, topK: 5 });
    // ponytail: truncate each hit to 300 chars — keeps context under ~1500 tokens total
    const context = hits.map((h, i) => `[${i + 1}] ${h.text.slice(0, 300)}`).join("\n").slice(0, 2000);
    const citations = hits.map((h) => ({ source: h.source, ref: h.ref, text: h.text.slice(0, 80) }));

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
