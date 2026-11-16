// One-off repair of old notification records (items 32 and 34). Pure: planFix(notification, status of its approval) → the fields to
// $set, or null when the record is already right. Used by scripts/backfill-notifications.mjs. Tests: tests/notifBackfill.test.mjs.
const WORDS = {
  CREATE_EMPLOYEE: "create an employee", DELETE_EMPLOYEE: "delete an employee", SUSPEND_EMPLOYEE: "suspend an employee",
  REACTIVATE_EMPLOYEE: "reactivate an employee", ROLE_CHANGE: "change an employee's role", TASK_ASSIGNMENT: "assign a task",
};
const OLD_PENDING = /^New ([A-Z_]+) request pending your approval/;

export function planFix(n, approvalStatus) {
  const set = {};
  if (n.type === "approval_pending" || n.type === "approval_required") {
    if (n.tier !== "needs_action") set.tier = "needs_action";
    const m = OLD_PENDING.exec(n.message ?? "");
    const words = m && WORDS[m[1]];
    if (!n.title && words) set.title = `Approval needed: ${words}`;
    if (words && n.message === `New ${m[1]} request pending your approval`) set.message = `New request to ${words} is waiting for your approval`;
    if (!n.deepLink && n.meta?.approvalId) set.deepLink = `/director/approvals?id=${n.meta.approvalId}`;
    if (!n.read && approvalStatus && approvalStatus !== "PENDING") set.read = true; // decided long ago, still shown as waiting
  } else if (n.type === "approval_result") {
    const approved = /approved/i.test(n.message ?? "");
    if (!n.title) set.title = approved ? "Request approved" : "Request rejected";
    if (!n.deepLink) set.deepLink = "/org/approvals";
  }
  return Object.keys(set).length ? set : null;
}
