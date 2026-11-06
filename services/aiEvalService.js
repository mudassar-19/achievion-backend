// Runs the AI evaluation of a submission and records the TL's final score (V2 2.3, D-075).
// Never blocks the submit or the review: every failure ends in an aiEval status the UI explains.
import Task        from "../models/Task.js";
import AIPromptLog from "../models/AIPromptLog.js";
import { ROLE_CATEGORY_MAP } from "../models/User.js";
import { getPrompt } from "../ai/prompts/registry.js";
import { callChain, aiConfigured } from "./aiChain.js";
import { rubricFor, prepareSubmission, parseJsonLoose, validateEvaluation, underDailyLimit, isDisagreement } from "./aiEvalRules.js";
import { scoreToStars } from "./xpEngine.js";

export const EVAL_FEATURE = "submission_evaluate";

async function evaluationsToday(userId) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return AIPromptLog.countDocuments({ requestedBy: userId, feature: EVAL_FEATURE, createdAt: { $gte: start }, fromCache: { $ne: true } });
}

// Only writes if the task still holds the same submission (a resubmission starts a new evaluation).
const save = (taskId, submittedAt, aiEval, extra = {}) =>
  Task.updateOne({ _id: taskId, submittedAt }, { $set: { aiEval: { ...aiEval, at: new Date() }, ...extra } });

export async function evaluateSubmission({ taskId, userId, role, orgId }) {
  const task = await Task.findById(taskId).lean();
  if (!task) return;
  const { submittedAt } = task;
  const cat = ROLE_CATEGORY_MAP[role] ?? null;
  const rubric = rubricFor(cat);
  if (!rubric) return save(taskId, submittedAt, { status: "skipped", error: "There is no AI rubric for this role." });
  if (!aiConfigured()) return save(taskId, submittedAt, { status: "off", error: "AI is not configured." });
  if (!underDailyLimit(await evaluationsToday(userId))) return save(taskId, submittedAt, { status: "limit", error: "Daily limit of 10 AI evaluations reached." });

  const prep = prepareSubmission({ roleCategory: cat, content: task.submissionContent, note: task.submissionNote, checklist: task.submissionChecklist });
  if (prep.empty) return save(taskId, submittedAt, { status: "skipped", role: cat, error: "Nothing the AI can read was submitted." });

  const prompt = getPrompt(`submission-evaluate-${cat}`);
  const base = { role: cat, partial: prep.partial, promptId: prompt.id, promptVersion: prompt.version };
  await save(taskId, submittedAt, { ...base, status: "pending" });
  try {
    const r = await callChain({
      feature: EVAL_FEATURE, orgId, requestedBy: userId, promptId: prompt.id, promptVersion: prompt.version,
      systemPrompt: prompt.system, temperature: prompt.temperature, maxTokens: prompt.maxTokens, maxInvalid: 2,
      userMessage: prompt.userTemplate({ title: task.title, description: task.description, text: prep.text, partial: prep.partial }),
      validate: prompt.validate,
    });
    const v = validateEvaluation(parseJsonLoose(r.text), rubric).value;
    await save(taskId, submittedAt,
      { ...base, status: "done", evidence: v.evidence, strengths: v.strengths, improvements: v.improvements, confidence: prep.partial ? "partial" : v.confidence },
      { aiScore: v.total, aiScores: v.scores });
  } catch (err) {
    await save(taskId, submittedAt, { ...base, status: "failed", error: err.status === 422 ? "The AI answer was not usable." : "AI is busy or unavailable." });
  }
}

// What a viewer may see of the AI result. The score only when `reveal` (Manager/Director, or after review).
export function aiEvalView(task, reveal) {
  if (!task?.aiEval) return null;
  return { ...task.aiEval, ...(reveal ? { score: task.aiScore ?? null, scores: task.aiScores ?? null } : {}) };
}

// Final score from the TL (0-100) → stars for the existing XP engine; disagreement flag for the Manager.
export function finalScore({ tlScore, aiScore, by }) {
  const stars = scoreToStars(tlScore);
  const gap = Number.isFinite(aiScore) ? Math.abs(aiScore - tlScore) : null;
  const flag = isDisagreement(aiScore, tlScore) ? { kind: "ai_tl_disagreement", aiScore, tlScore, gap, by } : null;
  return { stars, gap, flag };
}
