// Breakdown workspace rules (V2 Phase 4 · T-3, D-012, D-019, D-126..D-128) — pure, no DB.
// Tests: server/tests/breakdownRules.test.mjs. The AI only suggests rows; the server checks every reply and every Apply.
import { validateTaskInput, TYPES, DIFFICULTIES } from "./taskFormRules.js";
import { isNeutral } from "./managerAiRules.js";

export const MAX_APPLY_ROWS = 60;
// Free tier: Groq allows 1000 output tokens per minute for the first model in the chain, so one reply is at most ~8 tasks.
export const MAX_SUGGESTED_ROWS = 8;
const IS_ID = /^[0-9a-f]{24}$/i;
const str = (s, max) => typeof s === "string" && s.trim().length > 0 && s.trim().length <= max;

// AI reply { tasks: [{ title, type, hours, difficulty, dependsOn: ["r2", "e1"], acceptanceCriteria, benchmark }] }.
// rN = another row of this reply (1-based), eN = an existing task the server listed (existing: Map ref → id).
// Anything else is an invented id → the whole reply is rejected (one retry, then "not usable").
export function validateBreakdownReply(obj, { existing = new Map(), maxRows = MAX_SUGGESTED_ROWS } = {}) {
  const list = obj?.tasks;
  if (!Array.isArray(list) || !list.length) return { error: "no tasks" };
  if (list.length > maxRows) return { error: "too many" };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i] ?? {};
    if (!str(t.title, 120)) return { error: "title" };
    if (!TYPES.includes(t.type)) return { error: "type" };
    const h = Number(t.hours);
    if (!Number.isFinite(h) || h <= 0) return { error: "hours" };
    const deps = [];
    for (const ref of Array.isArray(t.dependsOn) ? t.dependsOn : []) {
      const m = /^r(\d+)$/.exec(String(ref));
      if (m) { const idx = Number(m[1]) - 1; if (idx === i) return { error: "self" }; if (idx < 0 || idx >= list.length) return { error: "invented id" }; deps.push({ row: idx }); continue; }
      if (existing.has(String(ref))) { deps.push({ taskId: existing.get(String(ref)) }); continue; }
      return { error: "invented id" };
    }
    const criteria = (Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 10).map((c) => c.slice(0, 200));
    const text = [t.title, t.benchmark ?? "", ...criteria];
    if (!text.every(isNeutral)) return { error: "wording" };
    const hours = Math.min(14, Math.max(1, Math.round(h * 4) / 4)); // D-012 clamp
    out.push({ title: t.title.trim(), type: t.type, hours, clamped: hours !== Math.round(h * 4) / 4,
      difficulty: DIFFICULTIES.includes(t.difficulty) ? t.difficulty : "Medium", dependsOn: deps, acceptanceCriteria: criteria,
      benchmark: typeof t.benchmark === "string" ? t.benchmark.trim().slice(0, 600) : "" });
  }
  return { ok: true, value: out };
}

export function validateBenchmarkReply(obj) {
  const b = typeof obj?.benchmark === "string" ? obj.benchmark.trim() : "";
  if (b.length < 10 || b.length > 600 || !isNeutral(b)) return { ok: false };
  return { ok: true, value: { benchmark: b } };
}

// Apply: rows [{ key, title, type, priority, difficulty, hours, deadline, assigneeId, dependsOn: ["row:<key>" | "task:<id>"],
//   acceptanceCriteria, benchmark, qaRequired, section }]. All valid or nothing.
export function validateApplyRows(rows, { teamIds = new Set(), existingIds = new Set() } = {}) {
  if (!Array.isArray(rows) || !rows.length) return { error: "Add at least one task." };
  if (rows.length > MAX_APPLY_ROWS) return { error: `Apply at most ${MAX_APPLY_ROWS} tasks at a time.` };
  const keys = rows.map((r) => String(r?.key ?? ""));
  if (keys.some((k) => !k) || new Set(keys).size !== keys.length) return { error: "Every row needs its own key." };
  const rowErrors = {}, value = [];
  for (const r of rows) {
    const { errors, value: v } = validateTaskInput({ title: r.title, description: r.description ?? "", type: r.type, priority: r.priority ?? "Medium", difficulty: r.difficulty ?? "Medium",
      estimatedHours: r.hours, deadline: r.deadline || undefined, acceptanceCriteria: r.acceptanceCriteria ?? [], benchmark: r.benchmark ?? "", qaRequired: !!r.qaRequired, tags: r.section ? [String(r.section)] : [] });
    if (r.assigneeId && !(IS_ID.test(String(r.assigneeId)) && teamIds.has(String(r.assigneeId)))) errors.assignee = "This person is not in your team on this project.";
    const rowDeps = [], taskDeps = [];
    for (const d of Array.isArray(r.dependsOn) ? r.dependsOn : []) {
      const [kind, ref] = String(d).split(":");
      if (kind === "row" && keys.includes(ref) && ref !== String(r.key)) rowDeps.push(ref);
      else if (kind === "task" && existingIds.has(ref)) taskDeps.push(ref);
      else { errors.dependsOn = kind === "row" ? "Depends on a row that is not in the draft." : "Depends on a task that is not in this project."; }
    }
    if (rowDeps.length + taskDeps.length > 10) errors.dependsOn = "At most 10 dependencies per task.";
    if (Object.keys(errors).length) rowErrors[r.key] = errors;
    value.push({ ...v, key: String(r.key), assigneeId: r.assigneeId || null, dependsOnRows: [...new Set(rowDeps)], dependsOnTasks: [...new Set(taskDeps)] });
  }
  if (Object.keys(rowErrors).length) return { ok: false, error: "Some rows need fixing before they can be applied.", rowErrors };
  // No loops between rows (A waits for B waits for A).
  const deps = new Map(value.map((v) => [v.key, v.dependsOnRows]));
  const state = new Map();
  const visit = (k) => { if (state.get(k) === 1) return true; if (state.get(k) === 2) return false; state.set(k, 1); for (const n of deps.get(k) ?? []) if (visit(n)) return true; state.set(k, 2); return false; };
  for (const k of deps.keys()) if (visit(k)) return { ok: false, error: "The dependencies make a loop. Remove one of them." };
  return { ok: true, value };
}
