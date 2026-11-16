// LB-2: the organisation's quality number, in ONE place. RND-06: final Team Lead scores of tasks completed in the
// last 30 days, mapped (stars - 1) / 4 x 100. Org Health (Quality factor) and the Director home "Avg Quality Score"
// both call this, so the two screens always agree. The AI score is not mixed in.
import Task from "../models/Task.js";
import { qualityScore } from "./orgHealthRules.js";

const DAY = 86_400_000;

// orgHex = the organisation's _id as a hex string (how Task.orgId is stored). → { score: 0..100 | null, samples }
export async function orgQualityFactor(orgHex, now = new Date()) {
  const scored = await Task.find({ orgId: orgHex, tlScore: { $ne: null }, completedAt: { $gte: new Date(+now - 30 * DAY) } }, "tlScore").lean();
  return { score: qualityScore(scored.map((t) => t.tlScore)), samples: scored.length };
}
