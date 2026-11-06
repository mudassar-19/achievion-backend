// Team Lead portal rules (V2 Phase 4 · T-1, D-113..D-116) — pure, no DB. Tests: server/tests/teamLeadRules.test.mjs.

import { levelFromTotalXp } from "./xpEngine.js";

const LEADS = ["Team Lead", "Manager"];
const EMPLOYEE = ["developer", "designer", "tester"];
const STATUSES = ["Backlog", "To-Do", "In-Progress", "In-Review", "Done"];

// Status change through PATCH /tasks/:id/status (board drag, quick actions). Same rules as the client
// board (client/src/utils/boardRules.js). Done is reached only by the review approval, never here.
// → null when allowed, else { status, error }.
export function statusMoveBlocker({ role, roleCategory, from, to, isAssignee }) {
  if (!STATUSES.includes(to)) return { status: 400, error: "Invalid status" };
  if (from === to) return null;
  if (to === "Done") return { status: 403, error: "Tasks reach Done when the Team Lead approves them on the review screen." };
  if (from === "Done") return { status: 403, error: "Done tasks can't be moved." };
  if (EMPLOYEE.includes(roleCategory)) {
    if (!isAssignee) return { status: 403, error: "You are not assigned to this task." };
    if ((from === "To-Do" && to === "In-Progress") || (from === "In-Progress" && to === "In-Review")) return null;
    return { status: 403, error: `Transition from '${from}' to '${to}' is not allowed.` };
  }
  if (LEADS.includes(role)) {
    if (from === "In-Review") return { status: 403, error: "Send a task back from the review screen, with feedback." };
    if (to === "In-Review") return { status: 403, error: "The assignee submits the task for review." };
    return null; // Backlog / To-Do / In-Progress
  }
  return { status: 403, error: "Your role can view tasks but not move them." };
}

// The TL's team = people (not Director / Manager / Team Lead) on the projects the TL is a member of.
const NOT_TEAM = ["Director", "Manager", "Team Lead"];
export function teamOf(projects = [], tlId) {
  const ids = new Map();
  for (const p of projects) for (const m of p.members ?? []) {
    const id = String(m?._id ?? m);
    if (id === String(tlId) || (m?.role && NOT_TEAM.includes(m.role))) continue;
    ids.set(id, m?.role ?? null);
  }
  return ids; // id → role (role null when members were not populated)
}

// Tasks list (DataTable): tab, filters, 25 per page.
export const TASK_PAGE = 25;
const TABS = ["all", "created", "review", "done"];
const IS_ID = /^[0-9a-f]{24}$/i;
export function parseTaskQuery(q = {}) {
  const tab = TABS.includes(q.tab) ? q.tab : "all";
  const status = STATUSES.includes(q.status) ? q.status : null;
  const assignee = IS_ID.test(String(q.assignee ?? "")) ? String(q.assignee) : q.assignee === "none" ? "none" : null;
  const module = IS_ID.test(String(q.module ?? "")) ? String(q.module) : null; // a project id (module = project or a module of it)
  const page = Math.max(1, Math.min(1000, parseInt(q.page, 10) || 1));
  return { tab, status, assignee, module, overdue: q.overdue === "1", page, search: String(q.q ?? "").trim().slice(0, 100) };
}

// Modules list status chip (UX §3): New = assigned but not accepted yet.
export function moduleState({ kind, acceptedAt, status, progress }) {
  if (kind === "module" && !acceptedAt) return "New";
  if (status === "Completed" || progress === 100) return "Completed";
  return "In progress";
}

// "1 alert" / "3 alerts"
export const alertLabel = (n) => `${n} alert${n === 1 ? "" : "s"}`;

export const QUESTION_MAX = 500;

// ── My stats + announcements (T-5, D-145, D-146) ────────────────────────────
const XP_LABEL = { tl_review_efficiency: "Task review", task_approved: "Task approved", quest: "Challenge reward", task_rejected: "Task sent back" };
const label = (src) => XP_LABEL[src] ?? String(src ?? "XP").replace(/^tl_/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const WEEK = 7 * 86_400_000;
// Light on purpose (D-020): no badges, avatar or titles here.
export function myStatsView({ profile, logs = [], now = new Date() }) {
  const totalXp = profile?.totalXp ?? 0;
  const { level, currentXp, maxXp } = levelFromTotalXp(totalXp);
  return {
    level, totalXp, currentXp, maxXp, xpToNext: maxXp - currentXp, levelPct: maxXp ? Math.round((currentXp / maxXp) * 100) : 0,
    streak: profile?.streaks?.daily ?? 0, reviewsGiven: profile?.stats?.reviewsGiven ?? 0,
    xpThisWeek: logs.filter((l) => +now - +new Date(l.createdAt) < WEEK).reduce((a, l) => a + (l.amount ?? 0), 0),
    recent: logs.slice(0, 10).map((l) => ({ id: l._id, amount: l.amount, label: label(l.source), at: l.createdAt })),
  };
}
export const announcementView = (m, channel, me) => ({
  id: m._id, text: m.content ?? "", at: m.createdAt, channel: channel?.name ?? "", from: m.sender?.name ?? "Someone", role: m.sender?.role ?? null,
  unread: !(m.readBy ?? []).map(String).includes(String(me)),
});


// D-176 (E-3): a PATCH to the status a task already has changes nothing (no save, no activity, no approval event).
export const isNoOpStatus = (from, to) => from === to;

// E-4c (D-199): one order on every call: severity, then the message (it carries the name), then the record id.
const SEVERITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const alertId = (a) => String(a.meta?.userId ?? a.meta?.taskId ?? a.meta?.milestoneId ?? a.type ?? "");
export const sortAlerts = (alerts) => [...alerts].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
  || String(a.message).localeCompare(String(b.message)) || alertId(a).localeCompare(alertId(b)));
