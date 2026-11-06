// E-4 Tester Quality (Employee UX §5, D-187..D-192): pure rules for bugs, the bug board, Team Lead validity, bug XP, who sees
// what, QA sign-off input, test cases and the QA queue. No DB here; qualityController loads and writes.
import { LIMITS } from "./textLimits.js";

export const SEVERITIES = ["Low", "Medium", "High", "Critical"];
export const PRIORITIES = ["Low", "Medium", "High", "Critical"];
export const BUG_STATUSES = ["Open", "Fixed", "Verified", "Closed"];
export const RUN_RESULTS = ["Pass", "Fail", "Blocked"];
export const BUG_XP = 15;         // Q2 default: a bug the Team Lead marks valid
export const BUG_DAILY_CAP = 5;   // Q2 default: at most 5 rewarded bugs per reporter per day

const str = (v) => (typeof v === "string" ? v.trim() : "");
const len = (errors, k, v, min, max, label) => {
  if (v.length < min) errors[k] = min > 1 ? `${label}: at least ${min} characters.` : `${label} is needed.`;
  else if (v.length > max) errors[k] = `${label}: at most ${max} characters.`;
};

/** New bug → { value } or { errors: { field: message } }. Project / task links are checked by the controller. */
export function validateBug(b = {}) {
  const v = { title: str(b.title), steps: str(b.steps), expected: str(b.expected), actual: str(b.actual), severity: b.severity, environment: str(b.environment) };
  const errors = {};
  len(errors, "title", v.title, 3, LIMITS.taskTitle, "Title");
  len(errors, "steps", v.steps, 5, 2000, "Steps to reproduce");
  len(errors, "expected", v.expected, 1, 1000, "Expected result");
  len(errors, "actual", v.actual, 1, 1000, "Actual result");
  if (v.environment.length > 300) errors.environment = "Environment: at most 300 characters.";
  if (!SEVERITIES.includes(v.severity)) errors.severity = "Pick a severity: Low, Medium, High or Critical.";
  return Object.keys(errors).length ? { errors } : { value: v };
}

const deny = (status, error, field) => ({ status, error, ...(field ? { field } : {}) });
const needNote = (note) => str(note).length < 3 ? deny(400, "Add a short note (3 characters or more).", "note") : null;

/**
 * One move on the bug board. actor = { id, kind: developer|designer|tester|lead|manager|director, onTask, isLead }.
 * Open → Fixed: the linked task's assignee (or, with no task, a developer on the project), only after "valid", with a note.
 * Fixed → Verified: a Tester who did not fix it. Fixed → Open (reopen): a Tester, with a note.
 * Verified → Closed, or Open → Closed for an invalid / duplicate bug: the project's Team Lead.
 */
export function bugMove({ bug, to, actor, note }) {
  if (!BUG_STATUSES.includes(to)) return deny(400, "Unknown column.");
  if (actor.kind === "director") return deny(403, "Directors can see bugs but not change them.");
  if (actor.kind === "manager") return deny(403, "Managers can see bugs but not change them. The Team Lead does that.");
  const from = bug.status;
  if (from === to) return deny(409, `The bug is already ${to}.`);
  if (from === "Open" && to === "Fixed") {
    const mayFix = actor.onTask || (!bug.taskId && actor.kind === "developer");
    if (!mayFix) return deny(403, "Only the person working on the linked task marks it fixed.");
    if (bug.validity !== "valid") return deny(409, bug.validity === "pending" ? "Waiting for the Team Lead to check this bug first." : "This bug was not accepted, so there is nothing to fix.");
    return needNote(note) ?? { ok: true, status: "Fixed" };
  }
  if (from === "Fixed" && (to === "Verified" || to === "Open")) {
    if (actor.kind !== "tester") return deny(403, "A Tester checks the fix.");
    if (to === "Verified") return String(bug.fixedBy) === String(actor.id) ? deny(403, "Someone else must verify your own fix.") : { ok: true, status: "Verified" };
    return needNote(note) ?? { ok: true, status: "Open" };
  }
  if (to === "Closed" && (from === "Verified" || (from === "Open" && ["invalid", "duplicate"].includes(bug.validity)))) {
    return actor.isLead ? { ok: true, status: "Closed" } : deny(403, "The Team Lead closes bugs.");
  }
  return deny(409, `A bug cannot move from ${from} to ${to}.`);
}

/** The project's Team Lead checks a new bug once: valid, invalid or duplicate (of another bug). */
export function bugValidity({ bug, validity, actor, note, duplicateOf }) {
  if (!actor.isLead) return deny(403, "The Team Lead of the project checks bugs.");
  if (!["valid", "invalid", "duplicate"].includes(validity)) return deny(400, "Choose valid, invalid or duplicate.");
  if (bug.status !== "Open" || bug.validity !== "pending") return deny(409, "This bug was already checked.");
  const n = str(note);
  if (n.length > 500) return deny(400, "Keep the note under 500 characters.", "note");
  if (validity !== "valid" && n.length < 3) return deny(400, "Say why in a few words.", "note");
  if (validity === "duplicate" && !duplicateOf) return deny(400, "Pick the bug it duplicates.", "duplicateOf");
  return { ok: true, validity, note: n, ...(validity === "duplicate" ? { duplicateOf } : {}) };
}

/** Q2 default: +15 XP to the reporter when the Team Lead marks the bug valid; once per bug; 5 rewarded bugs per day. */
export function bugXp({ validity, awarded, countToday }) {
  if (validity !== "valid") return { xp: 0, reason: "not_valid" };
  if (awarded) return { xp: 0, reason: "already_awarded" };
  if (countToday >= BUG_DAILY_CAP) return { xp: 0, reason: "daily_cap" };
  return { xp: BUG_XP, reason: null };
}

const has = (list, id) => (list ?? []).some((x) => String(x?._id ?? x) === String(id));
/** Q3 default: members and the project's Team Lead "write", the project's Manager and Directors "read", everyone else null (404). */
export function bugAccess(user, project) {
  if (!project) return null;
  if (user.role === "Director") return "read";
  if (user.role === "Manager") return String(project.managerId) === String(user.id) ? "read" : null;
  return has(project.members, user.id) ? "write" : null;
}

/** Tester sign-off input: pass | pass_notes | fail. Stored as result pass/fail (+ withNotes), so the approval gate stays as it is. */
export function validateSignoffInput({ result, note } = {}) {
  if (!["pass", "pass_notes", "fail"].includes(result)) return deny(400, "Choose Pass, Pass with notes or Fail.", "result");
  const n = str(note);
  if (n.length > LIMITS.comment) return deny(400, `The note can be at most ${LIMITS.comment} characters.`, "note");
  if (result !== "pass" && n.length < 3) return deny(400, result === "fail" ? "Write what failed." : "Write the notes.", "note");
  return { value: { result: result === "fail" ? "fail" : "pass", withNotes: result === "pass_notes", note: n } };
}

/** One sign-off per submission: true when a sign-off exists at or after the current submission. */
export const alreadySigned = (task) => {
  const since = task.submittedAt ? +new Date(task.submittedAt) : 0;
  return (task.qaSignoffs ?? []).some((s) => +new Date(s.at) >= since);
};

export function validateTestCase(b = {}) {
  const v = { title: str(b.title), steps: str(b.steps), expected: str(b.expected), priority: b.priority };
  const errors = {};
  len(errors, "title", v.title, 3, LIMITS.taskTitle, "Title");
  len(errors, "steps", v.steps, 5, 2000, "Steps");
  len(errors, "expected", v.expected, 1, 1000, "Expected result");
  if (!PRIORITIES.includes(v.priority)) errors.priority = "Pick a priority.";
  return Object.keys(errors).length ? { errors } : { value: v };
}

export function validateRun({ result, note } = {}) {
  if (!RUN_RESULTS.includes(result)) return deny(400, "Choose Pass, Fail or Blocked.", "result");
  const n = str(note);
  if (n.length > 500) return deny(400, "Keep the note under 500 characters.", "note");
  if (result === "Fail" && n.length < 3) return deny(400, "Say what failed.", "note");
  return { value: { result, note: n } };
}

/** QA queue tab: waiting (in review, no sign-off yet), signed (latest pass), failed (latest fail); null = not in the queue. */
export function qaTab(task) {
  if (!task.qaRequired) return null;
  const since = task.submittedAt ? +new Date(task.submittedAt) : 0;
  const latest = (task.qaSignoffs ?? []).filter((s) => +new Date(s.at) >= since).sort((a, b) => +new Date(a.at) - +new Date(b.at)).at(-1);
  if (latest) return latest.result === "pass" ? "signed" : "failed";
  return task.status === "In-Review" ? "waiting" : null;
}

/** Runs of the last 7 days by result. */
export function weekRuns(runs, now = new Date()) {
  const since = now.getTime() - 7 * 86_400_000, out = { Pass: 0, Fail: 0, Blocked: 0 };
  for (const r of runs) if (+new Date(r.at) >= since && out[r.result] !== undefined) out[r.result]++;
  return out;
}

// E-4b (D-196): the daily bug cap as unique slots. A rewarded bug takes one key "user:day:n" (unique index on Bug.xpSlot),
// so two checks at the same moment cannot both take the 5th place. `used` = rewards of today without a slot (before E-4b).
export const xpDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const capSlotKeys = (userId, d, used = 0) => Array.from({ length: Math.max(0, BUG_DAILY_CAP - used) }, (_, i) => `${userId}:${xpDay(d)}:${used + i + 1}`);
