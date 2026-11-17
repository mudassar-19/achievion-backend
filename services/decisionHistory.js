// Items 10 and 55 (D-533): decided account requests with both notes, for the Director and the Org admin. Pure.
// Tests: server/tests/decisionHistory.test.mjs. Credentials in the payload never leave: only the named fields are copied.
const ACTION = { CREATE_EMPLOYEE: "Create account", DELETE_EMPLOYEE: "Delete", SUSPEND_EMPLOYEE: "Suspend", REACTIVATE_EMPLOYEE: "Reactivate", ROLE_CHANGE: "Change role", TASK_ASSIGNMENT: "Assign task" };
const DECIDED = ["APPROVED", "REJECTED", "EXPIRED"];
const BY_A_PERSON = ["APPROVED", "REJECTED"]; // "Decided" tab; a request that ran out of time has its own "Expired" tab (item 11)

export function decisionRow(a) {
  const t = a.targetEmployeeId, p = a.payload ?? {};
  return {
    id: String(a._id), actionType: a.actionType, action: ACTION[a.actionType] ?? a.actionType, status: a.status,
    target: t?.name ?? p.name ?? "Unknown", targetRole: t?.role ?? p.role ?? null,
    change: p.oldRole && p.newRole ? `${p.oldRole} to ${p.newRole}` : null,   // A-5: "Tester to Junior Tester", not only the new role
    requesterReason: p.reason ?? null,                                // why the Org admin asked (mandatory for suspend and delete)
    directorNote: a.directorNote ?? a.rejectionReason ?? null,       // the Director's note (optional on approve, mandatory on reject)
    requestedAt: a.createdAt ?? null, decidedAt: a.resolvedAt ?? null, decidedBy: a.resolvedBy?.name ?? null,
  };
}

// scope: "decided" (default), "rejected", "suspended" → Mongo filter on top of the org.
export function decisionFilter(scope) {
  if (scope === "rejected") return { status: "REJECTED" };
  if (scope === "expired") return { status: "EXPIRED" };
  if (scope === "suspended") return { actionType: "SUSPEND_EMPLOYEE", status: { $in: DECIDED } };
  return { status: { $in: BY_A_PERSON } };
}
