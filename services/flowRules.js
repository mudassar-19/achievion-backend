// QA4 Y-6 / Y-7 / Y-8: pure rules of Change Team Lead, Reassign and Remove member. Tests: tests/qa4FlowRules.test.mjs.
export const NUDGE_COOLDOWN_HOURS = 24;
// null when a new request / nudge is allowed, else the moment it is allowed again.
export function cooldownLeft(lastAt, now = new Date(), hours = NUDGE_COOLDOWN_HOURS) {
  if (!lastAt) return null;
  const next = new Date(+new Date(lastAt) + hours * 3_600_000);
  return next > now ? next : null;
}
export const remainingHours = (estimate, logged) => Math.max(0, (Number(estimate) || 0) - (Number(logged) || 0));
// The dialog says "the deadline has to change" when the work left does not fit into the working hours until the deadline.
export const needsExtension = (remaining, hoursUntilDue) => remaining > 0 && remaining > hoursUntilDue;

const LEADERS = ["Director", "Manager", "Team Lead"];
const base = (r) => String(r ?? "").replace(/^(Senior|Junior) /, "");
// input: { task: { status, assignee }, toUserId, reason, sharePct, to: { role, status, inProject } } -> an error text or null
export function reassignError({ task, toUserId, reason, sharePct = 0, to }) {
  if (String(reason ?? "").trim().length < 5) return "Give a reason for the reassign (at least 5 characters).";
  if (["Done", "Cancelled"].includes(task.status)) return "A finished or cancelled task cannot be reassigned.";
  if (String(task.assignee ?? "") === String(toUserId)) return "That is the same person who has the task now.";
  if (!Number.isInteger(sharePct)) return "The handover share must be a whole number.";
  if (sharePct < 0 || sharePct > 50) return "The handover share must be between 0 and 50 percent.";
  if (!to || to.status !== "active") return "The new assignee must be an active person.";
  if (LEADERS.includes(base(to.role))) return "A task goes to an employee, not to a Director, Manager or Team Lead.";
  if (!to.inProject) return "The new assignee is not part of this project.";
  return null;
}
// The final assignee keeps the rest; the previous assignee gets the share (rounded down); together exactly the task's XP.
export function splitHandover(xp, sharePct = 0) {
  const previous = Math.floor((xp * sharePct) / 100);
  return { final: xp - previous, previous };
}
// Open tasks (reassign first) and leading a module (replace the Team Lead first) block removing a person from a project.
export function removeBlockers({ openTasks = [], ledModules = [] }) {
  const out = [];
  if (openTasks.length) out.push({ type: "open_tasks", message: `${openTasks.length} open task${openTasks.length === 1 ? "" : "s"} must be reassigned first.`, tasks: openTasks });
  if (ledModules.length) out.push({ type: "team_lead", message: `${ledModules.length === 1 ? "This person leads a module" : "This person leads modules"}: change the Team Lead first.`, modules: ledModules });
  return out;
}
export function changeLeadError({ current, newLead, reason, project, module }) {
  if (String(reason ?? "").trim().length < 5) return "Give a reason for changing the Team Lead (at least 5 characters).";
  if (["Completed", "Archived", "Deleted"].includes(project?.status)) return `The project is closed (${project.status}); its Team Lead cannot change.`;
  if (module?.status === "Completed") return "This module is Completed (finished); its Team Lead cannot change.";
  if (!newLead || base(newLead.role) !== "Team Lead") return "Pick a Team Lead.";
  if (newLead.status !== "active") return "The new Team Lead must be an active person.";
  if (String(newLead.id) === String(current ?? "")) return "That person is already the Team Lead of this module.";
  return null;
}
