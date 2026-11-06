// Team Lead T-2 task rules (V2 Phase 4, D-012, D-118, D-122..D-125) — pure, no DB.
// Tests: server/tests/taskFormRules.test.mjs.

export const TYPES = ["Feature", "Bug", "Design", "Testing", "DevOps", "Documentation"];
export const PRIORITIES = ["Critical", "High", "Medium", "Low"];
export const DIFFICULTIES = ["Easy", "Medium", "Hard", "Critical"];
export const MIN_HOURS = 1, MAX_HOURS = 14;           // D-012
export const MAX_SAVED_FILTERS = 10;
const IS_ID = /^[0-9a-f]{24}$/i;
const day = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(+d) ? undefined : d; };

// Create (all fields) or edit (only the fields sent). → { errors: {field: message}, value }
export function validateTaskInput(body = {}, { mode = "create" } = {}) {
  const errors = {}, value = {};
  const has = (k) => mode === "create" || body[k] !== undefined;

  if (has("title")) {
    const t = String(body.title ?? "").trim();
    if (t.length < 3 || t.length > 120) errors.title = "Write a title of 3 to 120 characters.";
    else value.title = t;
  }
  if (has("description")) {
    const d = String(body.description ?? "").trim();
    if (d.length > 4000) errors.description = "Keep the description under 4000 characters.";
    else value.description = d;
  }
  if (has("type")) { if (!TYPES.includes(body.type)) errors.type = "Pick a category."; else value.type = body.type; }
  if (has("priority")) { if (!PRIORITIES.includes(body.priority)) errors.priority = "Pick a priority."; else value.priority = body.priority; }
  if (has("difficulty")) { if (!DIFFICULTIES.includes(body.difficulty)) errors.difficulty = "Pick a difficulty."; else value.difficulty = body.difficulty; }
  if (has("estimatedHours")) {
    const raw = body.estimatedHours, h = Number(raw);
    if (raw === "" || raw === null || raw === undefined || Number.isNaN(h)) errors.estimatedHours = "Give an estimate in hours (1 to 14).";
    else if (h < MIN_HOURS) errors.estimatedHours = "Estimate 1 to 14 hours. Smaller work: merge it into another task.";
    else if (h > MAX_HOURS) errors.estimatedHours = "Estimate 1 to 14 hours. Bigger work: split it into smaller tasks.";
    else value.estimatedHours = Math.round(h * 4) / 4;
  }
  if (body.xpValue !== undefined && body.xpValue !== "" && body.xpValue !== null) {
    const x = Number(body.xpValue);
    if (!Number.isInteger(x) || x < 10 || x > 1000) errors.xpValue = "XP is a whole number from 10 to 1000, or empty for the default.";
    else value.xpValue = x;
  }
  for (const k of ["startDate", "deadline"]) {
    if (body[k] === undefined) continue;
    const d = day(body[k]);
    if (d === undefined) errors[k] = "Pick a valid date.";
    else value[k] = d;
  }
  if (value.startDate && value.deadline && value.deadline < value.startDate) errors.deadline = "The deadline cannot be before the start date.";
  if (body.tags !== undefined) {
    const list = Array.isArray(body.tags) ? body.tags : [];
    const tags = [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter((t) => t && t.length <= 24))];
    if (tags.length > 5) errors.tags = "Use at most 5 tags.";
    else value.tags = tags;
  }
  if (body.acceptanceCriteria !== undefined) {
    const list = (Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : []).map((c) => String(c).trim()).filter(Boolean);
    if (list.length > 10 || list.some((c) => c.length > 200)) errors.acceptanceCriteria = "Up to 10 criteria, each under 200 characters.";
    else value.acceptanceCriteria = list;
  }
  if (body.benchmark !== undefined) {
    const b = String(body.benchmark ?? "").trim();
    if (b.length > 1000) errors.benchmark = "Keep the benchmark under 1000 characters.";
    else value.benchmark = b;
  }
  if (body.qaRequired !== undefined) value.qaRequired = body.qaRequired === true || body.qaRequired === "true";
  return { errors, value };
}

// D-118: one independent task per member, linked by the same group tag.
export function groupTasks(base, memberIds = [], groupTag) {
  return [...new Set(memberIds.map(String))].map((assigneeId) => ({ ...base, assigneeId, groupTag }));
}

export const canDeleteTask = (status) => status === "Backlog" || status === "To-Do";

// statusOf: Map taskId → status.
export const isBlocked = (task, statusOf) => (task.dependsOn ?? []).some((p) => statusOf.get(String(p)) !== "Done");
export function unblockedTasks(doneId, dependents = [], statusOf) {
  return dependents.filter((t) => t.status !== "Done" && (t.dependsOn ?? []).map(String).includes(String(doneId)) && !isBlocked(t, statusOf)).map((t) => t.id);
}

const FILTER_KEYS = ["tab", "status", "assignee", "module", "overdue", "q", "tag", "blocked", "sprint", "view"];
export function validateSavedFilter({ name, query } = {}, existing = 0) {
  if (existing >= MAX_SAVED_FILTERS) return { error: `You can keep ${MAX_SAVED_FILTERS} saved filters. Delete one first.` };
  const n = String(name ?? "").trim();
  if (!n || n.length > 40) return { error: "Name the filter (1 to 40 characters)." };
  const q = new URLSearchParams(String(query ?? ""));
  const keep = new URLSearchParams();
  for (const [k, v] of q) if (FILTER_KEYS.includes(k) && v.length <= 100) keep.append(k, v);
  return { value: { name: n, query: keep.toString() } };
}

const BULK = {
  assign: (v) => (IS_ID.test(String(v ?? "")) ? { value: String(v) } : { error: "Pick a person." }),
  priority: (v) => (PRIORITIES.includes(v) ? { value: v } : { error: "Pick a priority." }),
  tag: (v) => { const t = String(v ?? "").trim().toLowerCase(); return t && t.length <= 24 ? { value: t } : { error: "Write a tag of up to 24 characters." }; },
  deadline: (v) => { const d = day(v); return d ? { value: d } : { error: "Pick a valid date." }; },
  sprint: (v) => (IS_ID.test(String(v ?? "")) ? { value: String(v) } : { error: "Pick a sprint." }), // T-5 (D-143)
};
export function validateBulk({ ids, action, value } = {}) {
  if (!BULK[action]) return { error: "Unknown bulk action." };
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((x) => IS_ID.test(String(x)))) return { error: "Select 1 to 100 tasks." };
  const r = BULK[action](value);
  return r.error ? r : { ok: true, value: r.value, ids: [...new Set(ids.map(String))] };
}

// T-5 (D-143): which tasks can join this sprint. elsewhere: Map(taskId → name of another open sprint).
export function bulkSprintPlan(tasks, sprint, elsewhere = new Map()) {
  const add = [], skipped = [];
  const inSprint = new Set((sprint.tasks ?? []).map(String));
  for (const t of tasks) {
    const id = String(t._id);
    const reason = String(t.projectId) !== String(sprint.projectId) ? "it is in another project"
      : t.status === "Done" ? "it is already done"
      : inSprint.has(id) ? "it is already in this sprint"
      : elsewhere.has(id) ? `it is already in "${elsewhere.get(id)}"` : null;
    if (reason) skipped.push({ id, title: t.title, reason }); else add.push(id);
  }
  return { add, skipped };
}

