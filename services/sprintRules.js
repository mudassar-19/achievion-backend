// Manager Sprints rules (V2 Phase 3 · M-3). Pure: no DB, no clock unless passed in.
// DB status → UI label: Planning = Planned, Active / Under Review / Delayed = Active, Completed = Closed.
export const PAGE_SIZE = 25;
export const ACTIVE_STATUSES = ["Active", "Under Review", "Delayed"];
export const OPEN_STATUSES = ["Planning", ...ACTIVE_STATUSES];
export const STATUS_FILTER = { Planned: ["Planning"], Active: ACTIVE_STATUSES, Closed: ["Completed"] };
const DAY = 86_400_000;
const OID = /^[0-9a-f]{24}$/i;

export const statusLabel = (s) => (s === "Planning" ? "Planned" : s === "Completed" ? "Closed" : "Active");

const toDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

// Create / edit form. Edit never changes the project.
export function validateSprintInput(body = {}, { mode = "create" } = {}) {
  const errors = {};
  const name = String(body.name ?? "").trim();
  const goal = String(body.goal ?? "").trim();
  const startDate = toDate(body.startDate), endDate = toDate(body.endDate);
  if (name.length < 2 || name.length > 80) errors.name = "Give the sprint a name (2–80 characters).";
  if (goal.length > 500) errors.goal = "Keep the goal under 500 characters.";
  if (!startDate) errors.startDate = "Pick a start date.";
  if (!endDate) errors.endDate = "Pick an end date.";
  else if (startDate && endDate <= startDate) errors.endDate = "The end date must be after the start date.";
  const value = { name, goal, startDate, endDate };
  if (mode === "create") {
    if (!OID.test(String(body.projectId ?? ""))) errors.projectId = "Choose the project this sprint belongs to.";
    else value.projectId = String(body.projectId);
  }
  return { errors, value };
}

// Open sprints of the same project whose dates touch [start, end]. A warning, not a block.
export function overlappingSprints(sprints, { startDate, endDate, excludeId = null }) {
  const s = toDate(startDate), e = toDate(endDate);
  if (!s || !e) return [];
  return sprints.filter((x) => String(x._id ?? x.id) !== String(excludeId) && OPEN_STATUSES.includes(x.status)
    && x.startDate && x.endDate && new Date(x.startDate) <= e && new Date(x.endDate) >= s);
}

// Why the sprint cannot start yet; empty array = it can.
export function startBlockers({ status, teamLeadCount, taskCount, otherActive = null }) {
  const reasons = [];
  if (status !== "Planning") reasons.push("Only a planned sprint can be started.");
  if (!teamLeadCount) reasons.push("The project has no Team Lead. Add one on the project's Team tab first.");
  if (!taskCount) reasons.push("Add at least one task to the sprint first.");
  if (otherActive) reasons.push(`"${otherActive}" is already active in this project. Close it first.`);
  return reasons;
}

// The only write the planning screen makes: the sprint's task list. Task documents are never touched (D-027).
export function membershipUpdate(action, taskId) {
  if (!OID.test(String(taskId ?? ""))) return null;
  if (action === "add") return { $addToSet: { tasks: String(taskId) } };
  if (action === "remove") return { $pull: { tasks: String(taskId) } };
  return null;
}

// Working days in [start, end] (UTC dates, inclusive) × hours/day × people.
export function teamCapacity({ memberCount, hoursPerDay = 7, workingDays = [1, 2, 3, 4, 5], startDate, endDate }) {
  const s = toDate(startDate), e = toDate(endDate);
  let days = 0;
  if (s && e) for (let t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()); t <= e.getTime(); t += DAY) {
    if (workingDays.includes(new Date(t).getUTCDay())) days++;
  }
  return { days, people: memberCount, hoursPerDay, hours: days * hoursPerDay * memberCount };
}

export const estimatedHours = (tasks) => tasks.reduce((a, t) => a + (t.estimatedHours ?? 0), 0);

// Velocity = XP of the Done tasks (the points the team delivered).
export const velocity = (tasks) => tasks.filter((t) => t.status === "Done").reduce((a, t) => a + (t.xpValue ?? 0), 0);

// Lateness is judged at the first submission (D-057), falling back to completion.
const finishedAt = (t) => toDate(t.firstSubmittedAt ?? t.submittedAt ?? t.completedAt);

// Share of Done tasks with a deadline that were finished by it; null when none had a deadline.
export function onTimePct(tasks) {
  const judged = tasks.filter((t) => t.status === "Done" && t.deadline && finishedAt(t));
  if (!judged.length) return null;
  const onTime = judged.filter((t) => finishedAt(t) <= new Date(t.deadline)).length;
  return Math.round((onTime / judged.length) * 100);
}

export function daysLeft(endDate, now = new Date()) {
  const e = toDate(endDate);
  return e ? Math.max(0, Math.ceil((e.getTime() - now.getTime()) / DAY)) : null;
}

export const progressPct = (tasks) => (tasks.length ? Math.round((tasks.filter((t) => t.status === "Done").length / tasks.length) * 100) : 0);

const people = (t) => {
  const all = [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].filter(Boolean);
  return all.filter((p, i) => all.findIndex((q) => String(q._id ?? q) === String(p._id ?? p)) === i);
};

// Numbers for the closed-sprint summary. aiScore counts only where the TL scored too (D-075).
export function sprintSummary(tasks, { endDate = null, now = new Date() } = {}) {
  const done = tasks.filter((t) => t.status === "Done");
  const ai = done.filter((t) => t.aiScore != null && t.tlScore != null).map((t) => t.aiScore);
  const by = new Map();
  for (const t of done) for (const p of people(t)) {
    const id = String(p._id ?? p);
    const row = by.get(id) ?? { id, name: p.name ?? "Unknown", tasksDone: 0, xp: 0 };
    row.tasksDone++; row.xp += t.xpValue ?? 0; by.set(id, row);
  }
  const cutoff = toDate(endDate) ?? now;
  const delays = tasks.flatMap((t) => {
    if (!t.deadline) return [];
    const due = new Date(t.deadline);
    const at = t.status === "Done" ? finishedAt(t) : null;
    const late = t.status === "Done" ? at && at > due : due < cutoff;
    if (!late) return [];
    const daysLate = Math.max(1, Math.ceil(((at ?? cutoff).getTime() - due.getTime()) / DAY));
    return [{ id: String(t._id ?? t.id), title: t.title, deadline: t.deadline, finishedAt: at, done: t.status === "Done", daysLate }];
  }).sort((a, b) => b.daysLate - a.daysLate);
  return {
    planned: tasks.length,
    done: done.length,
    unfinished: tasks.length - done.length,
    velocity: velocity(tasks),
    onTimePct: onTimePct(tasks),
    avgAiScore: ai.length ? Math.round(ai.reduce((a, b) => a + b, 0) / ai.length) : null,
    topContributors: [...by.values()].sort((a, b) => b.xp - a.xp || b.tasksDone - a.tasksDone).slice(0, 5),
    delays,
  };
}

export function parseSprintListQuery(q = {}) {
  const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => x.trim()).filter(Boolean);
  return {
    status: list(q.status).filter((s) => STATUS_FILTER[s]),
    project: list(q.project).filter((p) => OID.test(p)),
    page: Math.max(1, Number.parseInt(q.page, 10) || 1),
  };
}

// T-5 (D-143, D-121): only a sprint nothing has happened in can be deleted; its tasks stay.
export const canDeleteSprint = (status) => status === "Planning";
// A Team Lead writes sprints of their projects, but never another Team Lead's sprint (answered as 404).
export const tlSprintBlock = ({ createdBy, creatorRole, userId }) => creatorRole === "Team Lead" && String(createdBy) !== String(userId);

// T-6 (D-153): who hears that a sprint started or closed: project members + Manager, once each, not the person who did it.
export function sprintNotifyList({ members = [], managerId = null, actorId = null }) {
  const ids = new Set([...members.map((m) => String(m?._id ?? m)), ...(managerId ? [String(managerId?._id ?? managerId)] : [])]);
  ids.delete(String(actorId));
  return [...ids];
}

