import SatisfactionSurvey from "../models/SatisfactionSurvey.js";
import AITestCase         from "../models/AITestCase.js";
import PerformanceLog     from "../models/PerformanceLog.js";
import StressTestResult   from "../models/StressTestResult.js";
import Task from "../models/Task.js";
import AIFeedback from "../models/AIFeedback.js";
import { buildSuccessMetrics, TARGETS } from "../services/successMetrics.js";

// ── GET /api/director/success-criteria ───────────────────────────────────────
// Item 22 (D-537): progress toward each proposal target; the rules are in services/successMetrics.js (tested).
export async function getSuccessCriteria(req, res) {
  const { orgId } = req.user;
  const [surveys, aiCases, perfRows, stress, aiPairs, feedback] = await Promise.all([
    SatisfactionSurvey.find({ orgId }).lean(),
    AITestCase.find({ orgId }).lean(),
    PerformanceLog.find({ orgId }).lean(),
    StressTestResult.findOne({ orgId }).sort({ runAt: -1 }).lean(),
    Task.find({ orgId, aiScore: { $ne: null }, tlScore: { $ne: null } }, "aiScore tlScore").select("+aiScore").limit(1000).lean(), // QA4 D-QA4-13
    AIFeedback.find({ orgId }, "rating").lean(), // QA4 M-34(f)
  ]);
  res.json({ ...buildSuccessMetrics({ surveys, aiCases, perfRows, stress, aiPairs, feedback }), targets: TARGETS });
}
