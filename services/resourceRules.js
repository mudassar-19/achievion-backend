// Manager Resources rules (V2 Phase 3 · M-4). Pure: no DB. Tier formula stays in workloadRules.js (D-072).
import { HP_BURNOUT } from "./xpEngine.js";
import { WORKLOAD_TIERS } from "./workloadRules.js";

export const DEFAULT_THRESHOLD = 100;           // % of daily capacity; above it a person is "Overloaded"
export const THRESHOLD_MIN = 50, THRESHOLD_MAX = 150;
export const REASSIGNABLE = ["Backlog", "To-Do", "In-Progress"];
export const ASSET_TYPES = ["Tool", "License", "File link"];
const OID = /^[0-9a-f]{24}$/i;
const DAY = 86_400_000;

// Director default (org) unless the Manager set their own.
export function effectiveThreshold(orgDefault, override) {
  if (override != null && Number.isFinite(Number(override))) return Number(override);
  return Number.isFinite(Number(orgDefault)) && orgDefault != null ? Number(orgDefault) : DEFAULT_THRESHOLD;
}

// null = back to the Director's default.
export function validateThreshold(v) {
  if (v === null) return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < THRESHOLD_MIN || n > THRESHOLD_MAX) return { error: `Pick a whole number from ${THRESHOLD_MIN} to ${THRESHOLD_MAX}.` };
  return { value: n };
}

// Status badge: Free tier = Available; above the limit or below the HP burnout line = Overloaded; else Active.
export function statusBadge({ utilisation, hp = 100, threshold = DEFAULT_THRESHOLD }) {
  if (utilisation > threshold || hp < HP_BURNOUT) return "Overloaded";
  if (utilisation <= WORKLOAD_TIERS.FREE.max) return "Available";
  return "Active";
}

// Plain wording: "76%" up to 100, then "Over capacity ×7.6" (never "756%"). Bar is capped at 100.
export function loadLabel(utilisation) {
  if (utilisation <= 100) return `${utilisation}%`;
  return `Over capacity ×${(utilisation / 100).toFixed(1)}`;
}
export const loadTone = (utilisation) => (utilisation > 100 ? "red" : utilisation > 85 ? "amber" : "ok");
export const barPct = (utilisation) => Math.max(0, Math.min(100, utilisation));

export function hpTier(hp = 100) {
  if (hp < HP_BURNOUT) return "Low";
  if (hp < 60) return "Tired";
  return "Healthy";
}
export const needsLighterLoad = (burnoutRisk) => burnoutRisk === "High" || burnoutRisk === "Critical";

export function dueThisWeek(tasks, now = new Date()) {
  const end = now.getTime() + 7 * DAY;
  return tasks.filter((t) => t.deadline && new Date(t.deadline).getTime() >= now.getTime() - DAY && new Date(t.deadline).getTime() <= end).length;
}

// Why this person can (not) take the task. Empty = eligible.
export function reassignBlockers({ task, to, fromId, eligibleTypes, projectMemberIds = null }) {
  const reasons = [];
  if (!REASSIGNABLE.includes(task.status)) reasons.push(`A task that is ${task.status === "Done" ? "done" : "in review"} cannot be reassigned.`);
  if (!to) { reasons.push("Pick someone from your organisation."); return reasons; }
  if (String(to._id) === String(fromId)) reasons.push("That person already has this task.");
  else if ([task.assignee, ...(task.assignees ?? [])].some((a) => a && String(a) === String(to._id))) reasons.push(`${to.name} already works on this task.`);
  if (to.status !== "active") reasons.push(`${to.name}'s account is not active.`);
  if (["Director", "Manager", "Team Lead"].includes(to.role)) reasons.push("Tasks go to team members, not to leads.");
  else if (!eligibleTypes.includes(task.type)) reasons.push(`${to.role}s do not take "${task.type}" tasks.`);
  if (projectMemberIds && !projectMemberIds.some((id) => String(id) === String(to._id))) reasons.push(`${to.name} is not on this task's project.`);
  return reasons;
}

// The only task write a Manager makes (D-027): who works on it. `from` is swapped for `to`.
export function reassignUpdate(task, fromId, toId) {
  if (!OID.test(String(fromId ?? "")) || !OID.test(String(toId ?? ""))) return null;
  const list = (task.assignees ?? []).map(String);
  const assignees = list.includes(String(fromId)) ? list.map((id) => (id === String(fromId) ? String(toId) : id)) : [...list, String(toId)];
  const unique = [...new Set(assignees)];
  const assignee = !task.assignee || String(task.assignee) === String(fromId) ? String(toId) : String(task.assignee);
  return { $set: { assignee, assignees: unique } };
}

// Load after the change, from the engine's numbers (hours/day).
export function previewLoad({ allocatedHours, dailyCapacityHours }, deltaHours) {
  const hours = Math.max(0, allocatedHours + deltaHours);
  return dailyCapacityHours > 0 ? Math.round((hours / dailyCapacityHours) * 100) : 0;
}

// "Free, same role, 12 h free this week" — engine numbers in words.
export function candidateReason({ workloadTier, sameRole, availableHours, workingDaysPerWeek = 5 }) {
  const parts = [workloadTier === WORKLOAD_TIERS.FREE.label ? "Free" : workloadTier === WORKLOAD_TIERS.CRITICAL.label ? "Over capacity" : workloadTier === WORKLOAD_TIERS.HIGH.label ? "Busy" : "Some room"];
  if (sameRole) parts.push("same role");
  parts.push(`${Math.round(availableHours * workingDaysPerWeek)} h free this week`);
  return parts.join(", ");
}

// Engine order: most free hours first, then lowest utilisation; same role breaks ties.
export function rankCandidates(list, fromRole) {
  return [...list].sort((a, b) => b.availableHours - a.availableHours || a.utilisation - b.utilisation
    || Number(b.role === fromRole) - Number(a.role === fromRole) || a.name.localeCompare(b.name));
}

export function validateAssetInput(body = {}, { partial = false } = {}) {
  const errors = {}, value = {};
  const has = (k) => !partial || k in body;
  if (has("name")) {
    const name = String(body.name ?? "").trim();
    if (name.length < 2 || name.length > 120) errors.name = "Give the asset a name (2–120 characters).";
    value.name = name;
  }
  if (has("type")) {
    if (!ASSET_TYPES.includes(body.type)) errors.type = "Choose Tool, License or File link.";
    value.type = body.type;
  }
  if (has("url")) {
    const url = String(body.url ?? "").trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) errors.url = "Use a full link that starts with https://";
    if (!url && (body.type ?? value.type) === "File link") errors.url = "A file link needs the link.";
    value.url = url;
  }
  if (has("notes")) {
    const notes = String(body.notes ?? "").trim();
    if (notes.length > 1000) errors.notes = "Keep notes under 1000 characters.";
    value.notes = notes;
  }
  if (has("expiresAt")) {
    if (body.expiresAt == null || body.expiresAt === "") value.expiresAt = null;
    else { const d = new Date(body.expiresAt); if (Number.isNaN(d.getTime())) errors.expiresAt = "Pick a valid date."; else value.expiresAt = d; }
  }
  if (has("projectIds")) {
    const ids = Array.isArray(body.projectIds) ? body.projectIds.map(String) : [];
    if (ids.some((id) => !OID.test(id))) errors.projectIds = "Pick projects from the list.";
    value.projectIds = [...new Set(ids)];
  }
  return { errors, value };
}

export function expiryState(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const days = Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY);
  return days < 0 ? { state: "expired", days } : days <= 30 ? { state: "soon", days } : { state: "ok", days };
}
