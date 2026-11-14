// View as (AUTH-11, M-8, D-109) — pure rules. Tests: server/tests/viewAsRules.test.mjs.
// A viewer (Director / Manager) sees the portal through a target's eyes, read-only, for 30 minutes.

export const VIEW_AS_MINUTES = 30;
export const READ_ONLY_ERROR = "View-as is read-only";
export const EXIT_PATH = "/api/auth/view-as/exit";

const TL_STAFF = ["Developer", "Designer", "Tester"];
const STAFF    = ["Team Lead", ...TL_STAFF];
export const TARGET_ROLES = { Director: ["Manager", ...STAFF], Manager: STAFF, "Team Lead": TL_STAFF };
// "Senior Tester" → "Tester"
export const baseRole = (role) => String(role ?? "").replace(/^(Senior|Junior) /, "");

// → null when allowed, else { status, error }. teamIds: Set of user ids on the Manager's/TL's own projects.
export function viewAsBlocker({ viewer, target, teamIds = null }) {
  if (viewer?.viewAs) return { status: 403, error: "You are already viewing as someone. Exit that view first." };
  const allowed = TARGET_ROLES[viewer?.role];
  if (!allowed) return { status: 403, error: "Only Directors, Managers, and Team Leads can use View as." };
  if (!target || String(target.orgId) !== String(viewer.orgId)) return { status: 404, error: "Person not found." };
  if (String(target.id) === String(viewer.id)) return { status: 400, error: "You are already you." };
  if (!allowed.includes(baseRole(target.role))) return { status: 403, error: `You can't view as a ${target.role}.` };
  if (target.status && target.status !== "active") return { status: 409, error: "This account is not active." };
  if ((viewer.role === "Manager" || viewer.role === "Team Lead") && !teamIds?.has(String(target.id))) return { status: 403, error: "This person is not on your projects." };
  return null;
}

// Private/communication sections blocked even for GET in view-as (D-109 P3).
// Work-data GETs (tasks, projects, dashboard, quests, leaderboard, achievements, quality) pass through.
const SENSITIVE_GET_RE = /^\/(api\/(notifications|chat|communities|files|voice)|uploads|api\/auth\/sessions)(\/|$|\?)/;

// What a view-as request may do. → { block: { status, error } } | { readOnly: boolean }
export function guardDecision({ method, path, viewAs }) {
  if (!viewAs) return { readOnly: false };
  let p = String(path ?? "").split("?")[0];
  try { p = decodeURIComponent(p); } catch { return { block: { status: 400, error: "Bad path." } }; }
  p = p.replace(/\/+$/, "").toLowerCase(); // Express routes ignore case; %61i = ai
  if (method === "POST" && p === EXIT_PATH) return { readOnly: false };
  if (/\/ai(\/|$)/.test(p)) return { block: { status: 403, error: `${READ_ONLY_ERROR}: AI is off while viewing as someone.` } };
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) return { block: { status: 403, error: READ_ONLY_ERROR } };
  if (SENSITIVE_GET_RE.test(p)) return { block: { status: 403, error: `${READ_ONLY_ERROR}: this section is off while viewing as someone.` } };
  return { readOnly: true };
}

// Token claims (the token's `id` is the target, so every handler answers as the target would see it).
export function viewAsClaims({ viewer, target }) {
  return {
    id: String(target._id ?? target.id), email: target.email, role: target.role, roleCategory: target.roleCategory, name: target.name,
    orgId: target.orgId ? String(target.orgId) : null, tokenVersion: target.tokenVersion ?? 0,
    viewAs: { viewerId: String(viewer._id ?? viewer.id), viewerRole: viewer.role, viewerName: viewer.name, viewerTokenVersion: viewer.tokenVersion ?? 0, readOnly: true },
  };
}
