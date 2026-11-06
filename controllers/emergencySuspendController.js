/**
 * flagStaleSuspensions — cron helper called hourly from server.js.
 * Design: 72h guzarne par sirf FLAG lage (staleFlagged = true).
 * Item PENDING rahta hai — auto-void aur auto-reactivate nahi.
 * Director approve/reject karne par approvalController 410 return karta hai.
 *
 * Suspend flow:
 *   Org admin  → PATCH /api/org/employees/:id/status {status:"suspended"}
 *              → creates SUSPEND_EMPLOYEE approval (expiresAt = now + 72h)
 *   Director   → POST /api/approvals/:id/approve  (410 if staleFlagged/expired)
 *   Director   → POST /api/approvals/:id/reject   (revert)
 */
import Approval from "../models/Approval.js";
import AuditLog from "../models/AuditLog.js";

export async function flagStaleSuspensions() {
  const stale = await Approval.find({
    actionType:   "SUSPEND_EMPLOYEE",
    status:       "PENDING",
    staleFlagged: false,
    expiresAt:    { $lt: new Date() },
  }).lean();

  for (const a of stale) {
    // Flag only — keep PENDING so Director still sees it with a stale indicator
    await Approval.updateOne({ _id: a._id }, { $set: { staleFlagged: true } });
    await AuditLog.create({
      orgId:        a.orgId,
      performedBy:  "system",
      action:       "member_suspend_flagged",
      detail:       `72h window expired — SUSPEND_EMPLOYEE approval ${a._id} flagged stale (not voided)`,
      scope:        "account",
      targetUserId: a.targetEmployeeId,
    }).catch(() => {});
  }

  if (stale.length > 0) {
    console.log(`[suspend-cron] flagged ${stale.length} stale SUSPEND_EMPLOYEE approval(s)`);
  }
}
