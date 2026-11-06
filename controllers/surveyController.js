import { createHmac } from "crypto";
import SatisfactionSurvey from "../models/SatisfactionSurvey.js";

// Compute SUS score from 10 items (1–5 scale)
// Standard SUS: odd items: (score - 1) × 2.5; even items: (5 - score) × 2.5
function computeSus(scores) {
  if (!Array.isArray(scores) || scores.length !== 10) return null;
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const s = Number(scores[i]);
    if (!Number.isFinite(s) || s < 1 || s > 5) return null;
    total += i % 2 === 0 ? (s - 1) * 2.5 : (5 - s) * 2.5;
  }
  return Math.round(total);
}

// ── POST /api/survey ──────────────────────────────────────────────────────────
// Body: { period, enjoyableScore, easyScore, susScores[] }
export async function submitSurvey(req, res) {
  const { id: userId, orgId, role } = req.user;
  const { period, susScores, enjoyableScore, easyScore } = req.body;

  if (!period || typeof period !== "string" || !/^\d{4}-W\d{2}$/.test(period))
    return res.status(400).json({ error: "period must be in ISO week format YYYY-WNN." });

  if (enjoyableScore != null && (typeof enjoyableScore !== "number" || enjoyableScore < 1 || enjoyableScore > 5))
    return res.status(400).json({ error: "enjoyableScore must be 1–5." });
  if (easyScore != null && (typeof easyScore !== "number" || easyScore < 1 || easyScore > 5))
    return res.status(400).json({ error: "easyScore must be 1–5." });

  const secret = process.env.SURVEY_HMAC_SECRET;
  if (!secret) return res.status(503).json({ error: "Survey endpoint not configured (SURVEY_HMAC_SECRET missing)." });
  const respondentHash = createHmac("sha256", secret)
    .update(`${userId}:${period}`)
    .digest("hex");

  const susScore = computeSus(susScores);
  if (susScore === null)
    return res.status(400).json({ error: "susScores must be 10 integers from 1 to 5." });

  try {
    await SatisfactionSurvey.create({
      orgId,
      respondentHash,
      period,
      role,
      enjoyableScore: enjoyableScore ?? null,
      easyScore:      easyScore      ?? null,
      susScores,
      susScore,
    });
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ error: "Survey already submitted for this period." });
    throw err;
  }

  res.status(201).json({ ok: true, susScore });
}
