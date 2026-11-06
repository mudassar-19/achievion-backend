// Manager Projects rules (V2 Phase 3 · M-2). Pure: no DB, no network. Tests: tests/projectRules.test.mjs.
import { LIMITS } from "./textLimits.js";
export const PAGE_SIZE = 25;
export const PRIORITIES = ["Critical", "High", "Medium", "Low"];
export const LIST_STATUSES = ["Planning", "Scheduled", "Active", "On Hold", "Delayed", "In Review", "Completed", "Frozen"];
const SORTS = ["deadline", "title", "status", "createdAt"];
const DAY = 86_400_000;
const OID = /^[0-9a-f]{24}$/i;

const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((s) => String(s).trim()).filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toDate = (v) => { if (v == null || v === "") return null; const t = new Date(v); return Number.isNaN(+t) ? undefined : t; };
const dayStart = (t) => Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());

/** GET /api/manager/projects/list query → safe filter values. */
export function parseListQuery(q = {}) {
  const page = Number.parseInt(q.page, 10);
  return {
    search:   escapeRe(String(q.search ?? "").trim().slice(0, 60)).slice(0, 80),
    status:   list(q.status).filter((s) => LIST_STATUSES.includes(s)),
    priority: list(q.priority).filter((p) => PRIORITIES.includes(p)),
    archived: q.archived === "1" || q.archived === "true" || q.archived === true,
    page:     Number.isFinite(page) && page > 0 ? page : 1,
    limit:    PAGE_SIZE,
    sort:     SORTS.includes(q.sort) ? q.sort : "deadline",
    dir:      q.dir === "desc" ? -1 : 1,
  };
}

/**
 * Create / edit input → { errors: {field: message}, value }.
 * Edit never takes the deadline (that goes through extensionDecision) or the Team Lead (Team tab).
 */
export function validateProjectInput(body = {}, { mode = "create", now = new Date() } = {}) {
  const errors = {}, value = {};
  const has = (k) => body[k] !== undefined;

  if (mode === "create" || has("title")) {
    const title = String(body.title ?? "").trim();
    if (title.length < 3) errors.title = "Give the project a name (at least 3 characters).";
    else if (title.length > LIMITS.name) errors.title = `Project name can be at most ${LIMITS.name} characters.`; // U-1 (D-130)
    else value.title = title;
  }
  for (const k of ["description", "clientName", "businessContext", "operationalNotes", "internalRef"]) {
    if (has(k)) {
      const s = String(body[k] ?? "");
      if (k === "description" && s.trim().length > LIMITS.description) errors[k] = `Description can be at most ${LIMITS.description} characters.`;
      else if (s.length > 20_000) errors[k] = "This text is too long.";
      else value[k] = k === "clientName" || k === "internalRef" ? s.trim().slice(0, 120) : s;
    }
  }
  if (has("priority") || mode === "create") {
    const p = body.priority ?? "Medium";
    if (!PRIORITIES.includes(p)) errors.priority = "Pick Critical, High, Medium or Low.";
    else value.priority = p;
  }
  if (has("techStack")) {
    const t = body.techStack;
    if (!Array.isArray(t) || t.some((x) => typeof x !== "string" || !x.trim() || x.length > 40)) errors.techStack = "Tech stack must be a list of short names.";
    else if (t.length > 30) errors.techStack = "Use at most 30 tech stack items.";
    else value.techStack = [...new Set(t.map((x) => x.trim()))];
  }
  if (has("workingHoursPerDay")) {
    const h = Number(body.workingHoursPerDay);
    if (!Number.isFinite(h) || h < 1 || h > 24) errors.workingHoursPerDay = "Working hours per day must be 1 to 24.";
    else value.workingHoursPerDay = h;
  }

  const start = toDate(body.startDate);
  if (start === undefined) errors.startDate = "Start date is not a valid date.";
  else if (mode === "create" && !start) errors.startDate = "Pick a start date.";
  else if (start) {
    if (mode === "create" && dayStart(start) < dayStart(now)) errors.startDate = "The start date cannot be in the past.";
    else value.startDate = start;
  }

  if (mode === "create") {
    const deadline = toDate(body.deadline);
    if (!deadline) errors.deadline = deadline === undefined ? "Deadline is not a valid date." : "Pick a deadline.";
    else if (start && deadline <= start) errors.deadline = "The deadline must be after the start date.";
    else value.deadline = deadline;

    if (!OID.test(String(body.teamLeadId ?? ""))) errors.teamLeadId = "Choose a Team Lead for the project.";
    else value.teamLeadId = String(body.teamLeadId);
  }
  return { errors, value };
}

/**
 * Deadline extension (PD-026 / Director "Extension Rules"): the Manager may extend alone when the new days are
 * within extensionMaxDays, within extensionMaxPct of the original plan, and all extensions together stay within
 * extensionCumCapPct; otherwise the Director decides.
 */
export function extensionDecision({ startDate, deadline, newDeadline, extendedDaysSoFar = 0, rules = {} }) {
  const cur = toDate(deadline), next = toDate(newDeadline), start = toDate(startDate);
  if (!cur) return { error: "This project has no deadline to extend." };
  if (!next) return { error: "Pick a valid new deadline." };
  if (next <= cur) return { error: "The new deadline must be after the current one." };

  const maxDays = rules.extensionMaxDays ?? 3, maxPct = rules.extensionMaxPct ?? 20, capPct = rules.extensionCumCapPct ?? 20;
  const days = Math.ceil((next - cur) / DAY);
  const planDays = start ? Math.max(1, Math.round((cur - start) / DAY) - extendedDaysSoFar) : null;
  const reasons = [];
  if (days > maxDays) reasons.push(`More than ${maxDays} days.`);
  if (planDays && days > (maxPct / 100) * planDays) reasons.push(`More than ${maxPct}% of the original plan.`);
  if (planDays && extendedDaysSoFar + days > (capPct / 100) * planDays) reasons.push(`More than ${capPct}% of the original plan in total.`);
  return { days, withinLimit: reasons.length === 0, reasons };
}

/** Archive keeps the old status so Restore can put it back (reversible, Undo toast). */
export function archiveTransition(project, action) {
  if (action === "archive") {
    if (["Archived", "Deleted"].includes(project.status)) return { error: "This project is already archived or deleted." };
    return { status: "Archived", statusBeforeArchive: project.status };
  }
  if (action === "restore") {
    if (project.status !== "Archived") return { error: "Only archived projects can be restored." };
    return { status: project.statusBeforeArchive || "Planning", statusBeforeArchive: null };
  }
  return { error: "Unknown action." };
}
