// Anomaly flags written at XP award time (M-5, D-076). Same record as the AI/TL disagreement flag:
// Task.reviewFlags. One flag per task + kind + person (atomic $not/$elemMatch guard). Callers never await failure.
import Task     from "../models/Task.js";
import XpLog    from "../models/XpLog.js";
import AuditLog from "../models/AuditLog.js";
import { flagsForAward, BURST_WINDOW_MS } from "./anomalyRules.js";

export async function recordAwardFlags({ task, userId, xp, stars, approverId }) {
  const since = new Date(Date.now() - BURST_WINDOW_MS);
  const [past, recent] = await Promise.all([
    XpLog.find({ userId, source: "task_approved", taskId: { $ne: task._id } }, "amount").sort({ createdAt: -1 }).limit(30).lean(),
    AuditLog.find({ action: "xp_awarded", targetUserId: userId, createdAt: { $gte: since }, "after.taskId": { $exists: true } }, "performedBy createdAt").lean(),
  ]);
  const flags = flagsForAward({
    xp, history: past.map((l) => l.amount), stars, userId,
    submittedAt: task.submittedAt, approvedAt: task.reviewedAt ?? task.completedAt ?? new Date(),
    recentApprovals: recent.map((a) => ({ approverId: String(a.performedBy), userId: String(userId), at: a.createdAt })),
  });
  for (const f of flags) {
    await Task.updateOne(
      { _id: task._id, reviewFlags: { $not: { $elemMatch: { kind: f.kind, userId } } } },
      { $push: { reviewFlags: { kind: f.kind, userId, xp, evidence: f.evidence, by: approverId ?? null, status: "open" } } },
    );
  }
  return flags.length;
}
