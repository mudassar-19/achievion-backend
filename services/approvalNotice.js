// Item 32: the words, the link and the duplicate rule for approval notifications. Pure (no DB); the DB part is approvalService.js.
// Tests: server/tests/approvalNotice.test.mjs.
const who = (t) => (t?.name ? `${t.name}${t.role ? ` (${t.role})` : ""}` : "the employee");

// What the request asks for, as a verb phrase ("create an account for Saim Khan (Senior Developer)").
function phrase(actionType, payload = {}, target) {
  switch (actionType) {
    case "CREATE_EMPLOYEE":     return `create an account for ${payload.name ?? "a new employee"}${payload.role ? ` (${payload.role})` : ""}`;
    case "DELETE_EMPLOYEE":     return `delete ${who(target)}`;
    case "SUSPEND_EMPLOYEE":    return `suspend ${who(target)}`;
    case "REACTIVATE_EMPLOYEE": return `reactivate ${who(target)}`;
    case "ROLE_CHANGE":         return `change ${target?.name ?? "the employee"}'s role from ${payload.oldRole ?? "?"} to ${payload.newRole ?? "?"}`;
    case "TASK_ASSIGNMENT":     return `assign "${payload.taskTitle ?? "a task"}"`;
    default:                    return "make a change";
  }
}
// Short form without the role in brackets, for the title.
const short = (actionType, payload, target) => phrase(actionType, payload, target ? { name: target.name } : target).replace(/ \(.*?\)$/, "");

// Director: a request is waiting. { title, message, deepLink, tier }
export function approvalNotice({ actionType, payload = {}, requester, target, approvalId }) {
  const reason = actionType === "SUSPEND_EMPLOYEE" && payload.reason ? ` Reason: ${String(payload.reason).slice(0, 120)}` : "";
  return {
    title: `Approval needed: ${short(actionType, payload, target)}`,
    message: `${requester?.name ?? "The Org Admin"} asks you to ${phrase(actionType, payload, target)}.${reason}`,
    deepLink: `/director/approvals?id=${approvalId}`,
    tier: "needs_action",
  };
}

// Requester (Org Admin): the decision. { title, message, deepLink }
export function resultNotice({ actionType, payload = {}, target, status, directorNote, reason }) {
  const done = status === "APPROVED";
  const note = done ? (directorNote ? ` Note: ${directorNote}` : "") : (reason ? ` Reason: ${reason}` : "");
  return {
    title: done ? "Request approved" : "Request rejected",
    message: `Your request to ${phrase(actionType, payload, target)} was ${done ? "approved by the Director" : "rejected"}.${note}`,
    deepLink: "/org/approvals",
  };
}

// The open request that makes a new one a duplicate: same action on the same person, or the same e-mail for a new account.
export function pendingDuplicateQuery({ orgId, actionType, targetEmployeeId, payload = {} }) {
  if (targetEmployeeId) return { orgId, actionType, targetEmployeeId, status: "PENDING" };
  if (actionType === "CREATE_EMPLOYEE" && payload.email) return { orgId, actionType, status: "PENDING", "payload.email": String(payload.email).trim().toLowerCase() };
  return null;
}
