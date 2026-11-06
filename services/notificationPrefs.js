// U-1 (D-131): notification preferences that really work. Groups per role map to the notification types the server
// sends today (no dead toggle); "needs action" groups are locked on. Enforced once, when a notification is saved
// (models/Notification.js). Tests: server/tests/u1Rules.test.mjs.
const G = (key, label, desc, types, locked = false) => ({ key, label, desc, types, locked });
const LEADS = [
  G("module_updates", "Module questions and updates", "A Team Lead asks a question, accepts a module or marks it ready for QA.", ["module_question", "module_accepted", "module_qa_ready"]),
  G("deadline_requests", "Deadline requests", "Requests to move a module or task deadline. They need your answer.", ["deadline_change_request", "extension_requested"], true),
  G("overload", "Someone over their limit", "A person on your projects goes above the workload limit or is at burnout risk.", ["workload_over_limit", "burnout_alert"]),
  G("sprint_events", "Sprint started or closed", "A sprint of your projects starts or closes.", ["sprint_started", "sprint_closed"]),
  G("mention", "Mentions", "Someone names you in a task comment.", ["mention"]),
  G("decisions", "Approvals and decisions", "Things that wait for your decision.", ["approval_required", "needs_action", "manager_decision_required", "critical"], true),
];
const TEAM_LEAD = [
  G("new_module", "New module for you", "Your Manager assigns you a module. You accept it or ask a question.", ["project_module_assigned"], true),
  G("task_assigned", "Task assigned or moved", "A task is assigned to you or moved between people.", ["task_assigned", "task_reassigned"]),
  G("deadline_24h", "Deadline in 24 hours or missed", "Tasks that are due soon or past their deadline.", ["deadline_soon", "deadline_missed"], true),
  G("submissions", "Submission waiting for review", "Someone submits work, or your Manager reminds you about a review.", ["review_requested", "review_nudge"], true),
  G("task_unblocked", "Task unblocked", "A task can start because its prerequisites are done.", ["task_unblocked"]),
  G("qa_done", "QA sign-off result", "A Tester passes or fails a task of yours.", ["qa_signoff_done"]),
  G("sprint_events", "Sprint started or closed", "A sprint of your projects starts or closes.", ["sprint_started", "sprint_closed"]),
  G("mention", "Mentions", "Someone names you in a task comment.", ["mention"]),
  G("xp_gained", "XP and badges", "XP you earn from reviews and badges you unlock.", ["xp", "badge"]),
];
const CONTRIBUTOR = [
  G("task_assigned", "Task assigned to me", "When a task is assigned or moved to you.", ["task_assigned", "task_reassigned"]),
  G("task_approved", "Task approved", "When a submission is approved and XP is awarded.", ["task_approved", "xp:approved"]),
  G("task_rejected", "Task sent back", "When your submission is sent back with feedback.", ["task_rejected", "revision_requested"]),
  G("review_requested", "Review requested", "When a task is submitted for your review.", ["review_requested"]),
  G("deadline_24h", "Deadline in 24 hours or missed", "Tasks that are due soon or past their deadline.", ["deadline_soon", "deadline_missed"], true),
  G("task_unblocked", "Task unblocked", "A task can start because its prerequisites are done.", ["task_unblocked"]),
  G("sprint_events", "Sprint started or closed", "A sprint of your projects starts or closes.", ["sprint_started", "sprint_closed"]),
  G("qa_needed", "QA sign-off needed", "A task on your project waits for your sign-off.", ["qa_signoff_needed"], true),
  G("mention", "Mentions", "Someone names you in a task comment.", ["mention"]),
  G("badge_earned", "Badge unlocked", "When you earn a new badge.", ["badge"]),
  G("level_up", "Level up", "When you reach a new level.", ["system:level_up"]),
  G("xp_gained", "Other XP activity", "Bonuses, challenge rewards and other XP notices.", ["xp"]),
];
const base = (role) => String(role ?? "").replace(/^(Senior|Junior) /, "");
export function groupsFor(role) {
  const r = base(role);
  if (r === "Manager" || r === "Director") return LEADS;
  if (r === "Team Lead") return TEAM_LEAD;
  return CONTRIBUTOR;
}
// ponytail: the XP engine sends "Level Up!" as type "system" and approvals as type "xp"; matched by text so the
// engine stays untouched. Give them their own types if the engine is ever changed.
function typeKey({ type, message }) {
  if (type === "system" && /^Level Up!/.test(String(message ?? ""))) return "system:level_up";
  if (type === "xp" && /approved!/.test(String(message ?? ""))) return "xp:approved";
  return type;
}
export function prefKeyFor(notif, role) {
  const t = typeKey(notif);
  const groups = groupsFor(role);
  return (groups.find((g) => g.types.includes(t)) ?? groups.find((g) => g.types.includes(notif.type)))?.key ?? null;
}
export function isMuted({ role, prefs = {}, type, message }) {
  const key = prefKeyFor({ type, message }, role);
  if (!key) return false; // types without a group are always delivered
  const g = groupsFor(role).find((x) => x.key === key);
  return !g.locked && prefs?.[key] === false;
}
export function sanitizePrefs(input = {}, role) {
  const out = {};
  for (const g of groupsFor(role)) if (!g.locked && typeof input?.[g.key] === "boolean") out[g.key] = input[g.key];
  return out;
}

// ── Preferences (U-1, D-131): default landing page, date/time format, time zone, AI panel ──────────────────────
const BASE = { Manager: "/manager", Director: "/director", "Team Lead": "/teamlead" };
export const LANDINGS = {
  Manager: [["home", "Dashboard"], ["projects", "Projects"], ["inbox", "Inbox"], ["sprints", "Sprints"]],
  Director: [["home", "Dashboard"], ["projects", "Projects"], ["reports", "Reports"]],
  "Team Lead": [["home", "Dashboard"], ["modules", "Modules"], ["tasks", "Tasks"], ["team", "Team"]],
  contributor: [["home", "Dashboard"], ["tasks", "My tasks"], ["board", "Board"], ["leaderboard", "Leaderboard"]],
};
const landingsOf = (role) => LANDINGS[role] ?? LANDINGS.contributor;
// Path for a saved landing key; null = the role's normal home.
export function landingFor(role, key) {
  if (!key || key === "home" || !landingsOf(role).some(([k]) => k === key)) return null;
  return `${BASE[role] ?? "/workspace"}/${key}`;
}
const ZONES = new Set(Intl.supportedValuesOf("timeZone"));
export function validatePreferences(input, role) {
  if (!input || typeof input !== "object") return { error: "Preferences must be an object." };
  const v = {};
  if (input.landing !== undefined) { if (!landingsOf(role).some(([k]) => k === input.landing)) return { error: "Pick a landing page from the list." }; v.landing = input.landing; }
  if (input.dateFormat !== undefined) { if (!["mdy", "dmy", "iso"].includes(input.dateFormat)) return { error: "Pick a date format from the list." }; v.dateFormat = input.dateFormat; }
  if (input.timeFormat !== undefined) { if (!["12h", "24h"].includes(input.timeFormat)) return { error: "Pick 12-hour or 24-hour time." }; v.timeFormat = input.timeFormat; }
  if (input.timezone !== undefined) { if (input.timezone !== "" && !ZONES.has(input.timezone) && input.timezone !== "UTC") return { error: "Pick a time zone from the list." }; v.timezone = input.timezone; }
  if (input.aiPanel !== undefined) { if (typeof input.aiPanel !== "boolean") return { error: "AI panel must be on or off." }; v.aiPanel = input.aiPanel; }
  return { value: v };
}
