// E-3 (Employee UX §4.4-4.6, D-178..D-182): submit composer, My submissions, extension request, one more try.
// Pure rules; workspaceController loads and writes. No AI score ever leaves here (D-075); AI feedback text only after
// the Team Lead scored (Q6).
import { isAllowedSubmissionFile } from "./accessRules.js";
import { DESIGN_CHECKLIST } from "./aiEvalRules.js";
import { scoreToStars } from "./xpEngine.js";

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const LINK_LABEL = { developer: "Pull request or repository", designer: "Design file or prototype", tester: "Test report" };
const LIMIT = { link: 500, branch: 100, summary: 2000, tests: 1000, rationale: 2000, handoff: 1000, version: 40 };
const fail = (field, error) => ({ field, error });
const str = (v) => (typeof v === "string" ? v.trim() : "");

function httpUrl(v) {
  try { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) ? u.href : null; } catch { return null; }
}

/** Role form → { note, links, content, checklist } or { field, error }. files: [{ name, size }] (already uploaded or picked). */
export function validateSubmission({ kind, task, fields = {}, files = [] }) {
  if (files.length > MAX_FILES) return fail("files", `Attach at most ${MAX_FILES} files.`);
  for (const f of files) {
    if (!isAllowedSubmissionFile(f.name)) return fail("files", `"${f.name}" is not allowed. Use JPG, PNG, PDF, ZIP, DOCX, XLSX, TXT or MD.`);
    if (f.size > MAX_FILE_BYTES) return fail("files", `"${f.name}" is over 10 MB.`);
  }
  const v = Object.fromEntries(Object.keys(LIMIT).map((k) => [k, str(fields[k])]));
  for (const [k, max] of Object.entries(LIMIT)) if (v[k].length > max) return fail(k, `Keep this under ${max} characters.`);
  let url = null;
  if (v.link) { url = httpUrl(v.link); if (!url) return fail("link", "Use a full web address that starts with https://."); }
  if (v.branch && !/^[\w./-]+$/.test(v.branch)) return fail("branch", "A branch name has no spaces (letters, numbers, / . - _).");
  const text = kind === "designer" ? v.rationale : v.summary;
  if (!url && !files.length && !text) return fail(kind === "designer" ? "rationale" : "summary", "Add a link, a file or a short summary.");
  if (kind === "tester" && (task.qaRequired || task.type === "Testing") && !url && !files.length)
    return fail("files", "Attach the test report or evidence (a file or a link).");

  const n = (task.acceptanceCriteria ?? []).length;
  const ac = [...new Set((fields.criteria ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < n))].sort((a, b) => a - b).map((i) => `ac:${i}`);
  const design = kind === "designer" ? [...new Set((fields.design ?? []).filter((k) => DESIGN_CHECKLIST.some((c) => c.key === k)))] : [];
  const lines = kind === "developer" ? [["Summary", v.summary], ["Branch", v.branch], ["Tests", v.tests]]
    : kind === "designer" ? [["Rationale", v.rationale], ["Version", v.version], ["Handoff note", v.handoff]]
    : [["Summary", v.summary]];
  return {
    note: text,
    links: url ? [{ label: LINK_LABEL[kind], url }] : [],
    content: lines.filter(([, x]) => x).map(([l, x]) => `${l}: ${x}`).join("\n"),
    checklist: [...ac, ...design],
  };
}

const day = 86_400_000;
const OPEN_TASK = ["Backlog", "To-Do", "In-Progress"];
/** Ask for more time (task.extensionRequests is the store). New date after today and the current deadline, at most 60 days later. */
export function extensionAsk({ task, newDeadline, reason, now = new Date() }) {
  if (!OPEN_TASK.includes(task.status)) return { status: 409, error: "Only open tasks can get more time." };
  if (!task.deadline) return { status: 409, error: "This task has no deadline to move." };
  const list = task.extensionRequests ?? [];
  if (list.some((e) => e.status === "PENDING")) return { status: 409, error: "You already asked for more time on this task. Wait for the answer." };
  if (list.filter((e) => e.status === "APPROVED").length >= 2) return { status: 409, error: "This task was extended twice already. Talk to your Team Lead." };
  const r = str(reason);
  if (r.length < 10 || r.length > 500) return fail("reason", "Write a reason of 10 to 500 characters.");
  const d = new Date(newDeadline);
  if (Number.isNaN(d.getTime())) return fail("newDeadline", "Pick the new date.");
  const from = Math.max(new Date(task.deadline).getTime(), now.getTime());
  if (d.getTime() <= from) return fail("newDeadline", "Pick a date after the current deadline and after today.");
  if (d.getTime() - from > 60 * day) return fail("newDeadline", "Ask for at most 60 days more.");
  return { ok: true, reason: r, newDeadline: d };
}

/** Ask the Team Lead for one more submission (OperationalRequest "Resubmission limit reached" is the store). */
export function limitAsk({ task, requests = [], reason }) {
  if (task.status !== "In-Progress" || (task.resubmissionCount ?? 0) < (task.maxResubmissions ?? 3)) return { status: 409, error: "You still have tries left on this task." };
  if (requests.some((q) => ["Pending", "In Progress"].includes(q.status))) return { status: 409, error: "A request for one more try is already waiting." };
  if (requests.some((q) => q.status === "Rejected" && q.attempts === task.resubmissionCount)) return { status: 409, error: "One more try was declined for this attempt. Talk to your Team Lead." };
  const r = str(reason);
  if (r.length < 10 || r.length > 500) return fail("reason", "Write a reason of 10 to 500 characters.");
  return { ok: true, reason: r };
}

/** AI feedback text for the assignee: only after the Team Lead scored, never a score (D-075, Q6). */
export function employeeAiFeedback(task) {
  if (task?.tlScore == null || task?.aiEval?.status !== "done") return null;
  return { strengths: task.aiEval.strengths ?? [], improvements: task.aiEval.improvements ?? [] };
}

/** A task document as an employee may see it from /api/tasks: no AI score, AI text only after the TL scored. */
export function employeeTaskView(t) {
  const { aiScore, aiScores, aiEval, reviewFlags, ...rest } = t; // eslint-disable-line no-unused-vars
  const fb = employeeAiFeedback(t);
  return fb ? { ...rest, aiEval: { status: "done", ...fb } } : rest;
}

const lastRevision = (t) => (t.revisionHistory ?? []).filter((h) => (h.type ?? "revision_requested") === "revision_requested").at(-1) ?? null;
/** One row of My submissions, or null when the task was never submitted. */
export function submissionRow(t) {
  if (!t.submittedAt && !t.firstSubmittedAt) return null;
  const tab = t.status === "Done" ? "approved" : t.status === "In-Review" ? "waiting" : lastRevision(t) ? "revision" : null;
  if (!tab) return null;
  const reviewed = tab !== "waiting" && t.tlScore != null;
  const rev = tab === "revision" ? lastRevision(t) : null;
  return {
    id: String(t._id), title: t.title, status: t.status, tab, submittedAt: t.submittedAt ?? t.firstSubmittedAt, revision: t.resubmissionCount ?? 0,
    score: reviewed ? t.tlScore : null, stars: reviewed ? scoreToStars(t.tlScore) : null, feedback: tab === "approved" ? t.reviewNote ?? null : null,
    reason: rev?.comment ?? null, unmet: rev?.unmetCriteria ?? [], reviewedAt: tab === "approved" ? t.reviewedAt ?? null : rev?.requestedAt ?? null,
  };
}

/** Who leads a task's work: the module's Team Lead, else the Team Leads among the project members. */
export function projectLeadIds({ milestone, members = [] }) {
  if (milestone?.teamLeadId) return [String(milestone.teamLeadId)];
  return [...new Set(members.filter((m) => m.role === "Team Lead").map((m) => String(m._id)))];
}

/** multer / file filter error → { status, field, error }. Multer limit errors carry no status (they became 500 before E-3). */
export function uploadError(err) {
  if (err?.code === "LIMIT_FILE_SIZE") return { status: 400, field: "files", error: "Each file can be at most 10 MB." };
  if (err?.code === "LIMIT_FILE_COUNT" || err?.code === "LIMIT_UNEXPECTED_FILE") return { status: 400, field: "files", error: `Attach at most ${MAX_FILES} files.` };
  if (err?.status === 400) return { status: 400, field: "files", error: err.message };
  // Cloudinary refuses a file whose content does not match its extension (http_code 400).
  if (err?.http_code === 400) return { status: 400, field: "files", error: "A file does not match its type (for example a .png that is not a picture). Check the files and try again." };
  return { status: 500, field: null, error: "The files could not be stored. Try again." };
}

// ── E-3b (D-184, D-185) ───────────────────────────────────────────────────────────────────────────────────────────
/** Who hears "submission waiting for review": the task's Team Leads, else the project's Manager; plus a Senior on the same
 *  project (junior → senior review, S-1). Never just "the first Team Lead of the organisation" (D-182). */
export function reviewNoticeTargets({ leads = [], managerId = null, seniors = [] }) {
  const first = leads.length ? leads : managerId ? [managerId] : [];
  return [...new Set([...first, ...seniors].map(String))];
}

/** A design task: category Design, or done by a designer. */
export const isDesignTask = (task, assigneeCategories = []) => task?.type === "Design" || assigneeCategories.includes("designer");

/** Linked developer tasks (Q10): open tasks that wait for the design task (dependsOn) and have a developer on them. */
export function handoffTargets(dependents, categoryOf) {
  return dependents.filter((t) => t.status !== "Done" && [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].some((id) => categoryOf.get(String(id)) === "developer"));
}

/** What the developer gets from an approved design: links, files, handoff note. Read-only; never a score. null = nothing to hand. */
export function handoffEntry(t, designerName, at = new Date()) {
  const links = (t.submissionLinks ?? []).filter((l) => /^https?:\/\//i.test(l?.url ?? "")).map((l) => ({ label: String(l.label ?? "Link").slice(0, 80), url: l.url }));
  const files = (t.submissionFiles ?? []).filter((f) => f?.url).map((f) => ({ name: f.filename ?? "file", url: f.url }));
  const note = String(t.submissionHandoff ?? "").trim().slice(0, 1000);
  if (!links.length && !files.length && !note) return null;
  return { fromTask: String(t._id), fromTitle: t.title, by: designerName ?? "The designer", note, links, files, at };
}
