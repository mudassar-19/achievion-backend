// QA3 G-15 / B-17: audit events as sentences for the Director: who did what, no config keys, one date and time format. Pure.
import { dayText } from "./onTimeRule.js";

export function whenText(d, tz = "Asia/Karachi") {
  return `${dayText(d, tz)}, ${new Date(d).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`;
}

const days = (n) => `${n} working day${Number(n) === 1 ? "" : "s"}`;
export function cleanDetail(detail) {
  if (detail == null) return null;
  return String(detail)
    .replace(/exceeds extensionMaxDays \((\d+)\)/g, "more than the $1-working-day limit")
    .replace(/exceeds extensionMaxPct \((\d+)%\)/g, "more than $1% of the plan")
    .replace(/\+(\d+)d\b/g, (_, n) => days(n))
    .replace(/^Extension approve:/, "Extension approved:");
}

const PHRASE = {
  extension_requested: "asked for an extension", extension_approved: "approved an extension", extension_rejected: "declined an extension", extension_counter_proposed: "proposed a different extension",
  role_change: "changed the role of", account_status_change: "changed the account status of", account_deleted: "removed the account of", employee_created: "created the account of",
  project_created: "created the project", project_updated: "updated the project", project_status_changed: "changed the status of the project", report_exported: "exported a report",
  company_community_created: "created the Company community", company_members_added: "added people to the Company community", workspace_updated: "updated the workspace settings", settings_updated: "updated settings",
  xp_adjusted: "adjusted XP for", sprint_started: "started a sprint", sprint_closed: "closed a sprint", task_reassigned: "reassigned a task",
};
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const humanize = (a) => sentence(String(a).replace(/_/g, " ").toLowerCase());

// row: { action, performerName, targetName, projectTitle, oldRole, newRole, detail }
export function auditSentence(r) {
  const phrase = PHRASE[r.action];
  if (!phrase) return r.performerName ? `${r.performerName}: ${humanize(r.action).toLowerCase()}` : humanize(r.action);
  const who = r.performerName ?? "Someone";
  const subject = r.targetName ?? r.projectTitle ?? null;
  const change = r.oldRole && r.newRole ? `${r.oldRole} to ${r.newRole}` : null;
  const detail = cleanDetail(r.detail);
  const tail = change ? `: ${change}` : detail ? `: ${detail.replace(/^Extension approved:\s*/, "")}` : "";
  return `${who} ${phrase}${subject ? ` ${subject}` : ""}${tail}`;
}

// QA4 M-39: what a Manager's Activity may show. View as, session and organisation set-up events are for the Director / Org admin (and the person viewed).
export const HIDDEN_FROM_MANAGER = ["view_as_started", "view_as_ended", "company_community_created", "company_members_added", "workspace_updated", "settings_updated", "ORG_CREATED", "DIRECTOR_CREATED", "DIRECTOR_SETUP", "GAMIFICATION_RESET"];
// A Manager sees their own actions and the events of the projects they manage (e.g. their reports, their extension requests); other roles see all but the hidden kinds.
export function activityQuery({ role, userId, orgOid, projectIds = [] }) {
  const q = { orgId: orgOid, action: { $nin: HIDDEN_FROM_MANAGER }, scope: { $ne: "session" } };
  if (role === "Manager") q.$or = [{ performedBy: { $in: [].concat(userId) } }, { targetProjectId: { $in: projectIds } }];
  return q;
}
