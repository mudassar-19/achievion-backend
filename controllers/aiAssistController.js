// AI help for Team Leads outside the Director portal (V2 2.2, D-075). Suggestions only: never applied by the server.
import mongoose from "mongoose";
import Project from "../models/Project.js";
import { getPrompt } from "../ai/prompts/registry.js";
import { callChain, aiConfigured } from "../services/aiChain.js";
import { parseJsonLoose, validateTaskSuggestion } from "../services/aiEvalRules.js";

// ── POST /api/teamlead/ai/task-suggest { title, type, priority, difficulty, description, projectId } ──
export async function suggestTask(req, res) {
  const { orgId, id: userId } = req.user;
  const { title, type, priority, difficulty, description, projectId } = req.body ?? {};
  if (!String(title ?? "").trim()) return res.status(400).json({ error: "Write a task title first." });
  if (!aiConfigured()) return res.status(503).json({ error: "AI is not configured." });

  const project = mongoose.isValidObjectId(projectId) ? await Project.findOne({ _id: projectId, orgId }, "title").lean() : null;
  const prompt = getPrompt("task-suggest");
  try {
    const r = await callChain({
      feature: "task_suggest", orgId, requestedBy: userId, promptId: prompt.id, promptVersion: prompt.version,
      systemPrompt: prompt.system, temperature: prompt.temperature, maxTokens: prompt.maxTokens, maxInvalid: 2,
      userMessage: prompt.userTemplate({
        title: String(title).slice(0, 200), type, priority, difficulty, project: project?.title ?? "",
        description: String(description ?? "").slice(0, 1000),
      }),
      validate: prompt.validate,
    });
    res.json({ suggestion: validateTaskSuggestion(parseJsonLoose(r.text)).value, aiGenerated: true });
  } catch (err) {
    res.status(err.status === 422 ? 502 : (err.status ?? 503)).json({ error: err.status === 422 ? "The AI answer was not usable. Try again or write it yourself." : "AI is busy right now. Try again shortly." });
  }
}
