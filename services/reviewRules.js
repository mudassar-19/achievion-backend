// Team Lead review rules (T-4, D-136/D-137; D-021, D-075). Pure. Tests: tests/reviewRules.test.mjs.
import { parseTlScore, DISAGREEMENT_POINTS } from "./aiEvalRules.js";
import { scoreToStars } from "./xpEngine.js";
import { isRubberStamp } from "./anomalyRules.js";
import { LIMITS } from "./textLimits.js";

export const PAGE = 25;
const STALE_MS = 2 * 86_400_000;
const REASON_MAX = 500;
const assigneesOf = (t) => [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].map((x) => String(x?._id ?? x));

export const isSelfReview = (task, reviewerId) => assigneesOf(task).includes(String(reviewerId));

// not_required | waiting | passed | failed | conditional. A sign-off counts only for the current submission:
// after a revision the work has changed, so it must be signed again.
export function qaState(task) {
  if (!task.qaRequired) return { state: "not_required", latest: null };
  if (task.qaConditional?.at) return { state: "conditional", latest: null, conditional: task.qaConditional };
  const since = task.submittedAt ? +new Date(task.submittedAt) : 0;
  const list = (task.qaSignoffs ?? []).filter((s) => +new Date(s.at) >= since).sort((a, b) => +new Date(a.at) - +new Date(b.at));
  const latest = list.at(-1) ?? null;
  return { state: !latest ? "waiting" : latest.result === "pass" ? "passed" : "failed", latest };
}

// Why this person may not finish this task now: null = allowed. One rule for every path to Done.
export function approvalBlock({ task, reviewerId, conditional = false }) {
  if (task.status !== "In-Review") return { status: 409, code: "not_in_review", error: "This task is not waiting for review." };
  if (isSelfReview(task, reviewerId)) return { status: 403, code: "self_review", error: "You worked on this task, so someone else must review it." };
  const { state } = qaState(task);
  // T-5 (D-141): a failed sign-off leaves only Request revision; conditional is for a sign-off that has not happened.
  if (state === "failed") return { status: 409, code: "qa_failed", error: "The Tester's QA sign-off failed. Send the task back with Request revision." };
  if (conditional) return state === "waiting" ? null : { status: 409, code: "qa_not_missing", error: "Conditional approval is only for a task still missing its QA sign-off." };
  if (state === "waiting") return { status: 409, code: "qa_required", error: "This task needs a Tester's QA sign-off first. Use Conditional approve if it cannot wait." };
  return null;
}

export function validateApproval({ score, feedback = "", conditional = false, reason = "" } = {}) {
  const s = parseTlScore(score);
  if (s === null) return { error: "Give a score: a whole number from 0 to 100." };
  const fb = String(feedback ?? "").trim();
  if (fb.length > LIMITS.comment) return { error: `Feedback can be at most ${LIMITS.comment} characters.` };
  const why = String(reason ?? "").trim();
  if (conditional && !why) return { error: "Write why this cannot wait for the QA sign-off." };
  if (why.length > REASON_MAX) return { error: `The reason can be at most ${REASON_MAX} characters.` };
  return { value: { score: s, stars: scoreToStars(s), feedback: fb, reason: why } };
}

export function validateRevision({ reason = "", unmet = [] } = {}, criteria = []) {
  const why = String(reason ?? "").trim();
  if (!why) return { error: "Write what needs to change." };
  if (why.length > LIMITS.comment) return { error: `The reason can be at most ${LIMITS.comment} characters.` };
  return { value: { reason: why, unmet: (Array.isArray(unmet) ? unmet : []).filter((c) => criteria.includes(c)) } };
}

// D-059: a revision always goes back to the assignee. Reaching the limit tells the Manager; it does not park the task.
export function revisionUpdate({ resubmissionCount = 0, maxResubmissions = 3 }) {
  const next = resubmissionCount + 1;
  return { status: "In-Progress", resubmissionCount: next, reachedMax: next >= maxResubmissions };
}

export const rubberStampWarning = ({ score, submittedAt, now = new Date() }) =>
  isRubberStamp({ stars: scoreToStars(score), submittedAt, approvedAt: now });

export function gapInfo(aiScore, tlScore) {
  if (!Number.isFinite(aiScore) || !Number.isFinite(tlScore)) return { gap: null, flagged: false };
  const gap = Math.abs(aiScore - tlScore);
  return { gap, flagged: gap > DISAGREEMENT_POINTS };
}

export function aiStatus(ev) {
  if (ev?.status === "done") return ev.partial ? "partial" : "ready";
  return ev?.status === "pending" ? "pending" : "not_available";
}

const isHigh = (x) => x.priority === "High" || x.priority === "Critical";
const isOverdue = (x, now) => !!x.deadline && +new Date(x.deadline) < +now;
const isStale = (x, now) => +now - +new Date(x.submittedAt) > STALE_MS;
const isToday = (x, now) => new Date(x.submittedAt).toDateString() === new Date(now).toDateString();

// items: [{ id, submittedAt, priority, deadline, assigneeIds, assigneeRoles, moduleId }]. Oldest first.
export function queueView(items, { view, role, module: mod, assignee, page = 1 } = {}, now = new Date()) {
  const base = items.filter((x) => (!role || x.assigneeRoles.some((r) => r.replace(/^(Senior|Junior) /, "") === role))
    && (!mod || String(x.moduleId) === String(mod)) && (!assignee || x.assigneeIds.includes(String(assignee))));
  const counts = { all: base.length, today: base.filter((x) => isToday(x, now)).length, high: base.filter(isHigh).length,
    overdue: base.filter((x) => isOverdue(x, now)).length, stale: base.filter((x) => isStale(x, now)).length };
  const pick = { today: (x) => isToday(x, now), high: isHigh, overdue: (x) => isOverdue(x, now), stale: (x) => isStale(x, now) }[view] ?? (() => true);
  const list = base.filter(pick).sort((a, b) => +new Date(a.submittedAt) - +new Date(b.submittedAt));
  const p = Math.max(1, Number(page) || 1);
  return { counts, total: list.length, page: p, pageSize: PAGE, items: list.slice((p - 1) * PAGE, p * PAGE) };
}

export function canTakeSignoff(task, testerId) {
  if (!task.qaRequired) return { status: 409, code: "qa_not_required", error: "This task does not need a QA sign-off." };
  if (task.status !== "In-Review") return { status: 409, code: "not_in_review", error: "A QA sign-off is given while the task is in review." };
  if (isSelfReview(task, testerId)) return { status: 403, code: "self_signoff", error: "You worked on this task, so another Tester must sign it off." };
  return null;
}
export function validateSignoff({ result, note = "" } = {}) {
  if (!["pass", "fail"].includes(result)) return { error: "The result must be pass or fail." };
  const n = String(note ?? "").trim();
  if (result === "fail" && !n) return { error: "Write what failed." };
  if (n.length > LIMITS.comment) return { error: `The note can be at most ${LIMITS.comment} characters.` };
  return { value: { result, note: n } };
}

// ── Resubmission limit (T-5, D-142) ─────────────────────────────────────────
export const LIMIT_TYPE = "Resubmission limit reached";
export function limitRequestFields({ taskTitle, assigneeName, tlName, attempts, max }) {
  return { type: LIMIT_TYPE, priority: "High", title: `Resubmission limit: ${String(taskTitle).slice(0, 160)}`,
    message: `"${taskTitle}" was sent back ${attempts} of ${max} times. Assignee: ${assigneeName ?? "nobody"}. Team Lead: ${tlName ?? "unknown"}. They cannot submit again unless you allow one more try.` };
}
// The Manager's narrow write (D-027): one more try, or no. The request can be decided once.
export function limitDecision(request, { decision, note = "" } = {}) {
  if (request?.type !== LIMIT_TYPE) return { httpStatus: 400, error: "This request is not a resubmission limit." };
  if (!["allow", "decline"].includes(decision)) return { httpStatus: 400, error: "Choose Allow another try or Decline." };
  if (request.status !== "Pending" && request.status !== "In Progress") return { httpStatus: 409, error: "This request was already decided." };
  return decision === "allow" ? { status: "Resolved", incLimit: 1, note: String(note ?? "").trim() } : { status: "Rejected", incLimit: 0, note: String(note ?? "").trim() };
}
export const limitState = (request) => (!request ? null : request.status === "Resolved" ? "allowed" : request.status === "Rejected" ? "declined" : "waiting");


// E-4b (D-194): who sent the task back decides what it costs. The Team Lead's revision (D-027) uses a try, applies the
// rejection rule (XP and HP) and opens the limit request at the limit; a QA fail only sends the task back.
export const revisionPlan = (source = "review") => (source === "qa"
  ? { countsAttempt: false, penalty: false, limitRequest: false }
  : { countsAttempt: true, penalty: true, limitRequest: true });
export const revisionEntry = ({ by, reason, unmet = [], at, source = "review" }) =>
  ({ type: "revision_requested", comment: reason, unmetCriteria: unmet, requestedBy: by, requestedAt: at, source });

// E-4c (D-198): a try is used only when the work is sent back (revisionUpdate, D-142); submitting or resubmitting uses none.
// Before, submitTask also added 1 on every resubmit, so one send-back + resubmit cycle used two of the three tries.
export const attemptDelta = () => 0;
