// People-management approval rules — pure functions, no DB.
// Tests: server/tests/orgAdminRules.test.mjs

export const SUSPEND_REASON_MIN = 5;
export const SUSPEND_REASON_MAX = 300;

/**
 * Every employee delete must go through Director approval — no bypass for suspended status.
 * Returns null if approval is required (always), or a string error if the action is blocked
 * for another reason (e.g., target is Director).
 */
export function deleteRequiresApproval(user) {
  if (!user) return false;
  if (user.role === "Director") return false; // Director is blocked outright (403), not routed to approval
  return true; // ALL employees need approval, regardless of status
}

/**
 * Validate the reason given for a suspend request.
 * Returns null if valid, or an error string if invalid.
 */
export function validateSuspendReason(reason) {
  if (reason == null || String(reason).trim().length === 0) {
    return `A reason is required to suspend an employee (${SUSPEND_REASON_MIN}–${SUSPEND_REASON_MAX} characters).`;
  }
  const trimmed = String(reason).trim();
  if (trimmed.length < SUSPEND_REASON_MIN) {
    return `Suspension reason must be at least ${SUSPEND_REASON_MIN} characters.`;
  }
  if (trimmed.length > SUSPEND_REASON_MAX) {
    return `Suspension reason must be at most ${SUSPEND_REASON_MAX} characters.`;
  }
  return null;
}

/**
 * Past-employees endpoint access: only the org admin (via org JWT) may call it.
 * The org JWT carries orgDbId; cross-org isolation is enforced by filtering on orgId.
 * Returns null if access is allowed, or { status, error } if not.
 */
export function pastEmployeesAccess(req) {
  if (!req?.org?.orgDbId) return { status: 401, error: "Org admin authentication required." };
  return null;
}
