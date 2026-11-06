// Team Lead AI rules (T-6, D-149..D-152; UX TL v4 §13) — pure. Tests: tests/t6Rules.test.mjs. Same guardrails as the Manager
// (managerAiRules: short references, validators, neutral wording). The AI only reads and suggests; nothing here writes.
import { isNeutral } from "./managerAiRules.js";

export const FEATURE_PREFIX = "tl_"; // every call is logged in AIPromptLog as tl_*
const OID = "[0-9a-f]{24}";

export function tlContextFromPath(pathname = "", search = "") {
  const p = String(pathname), q = new URLSearchParams(String(search).replace(/^\?/, ""));
  let m;
  if ((m = p.match(new RegExp(`^/teamlead/modules/(${OID})`, "i")))) return { kind: "module", id: m[1], moduleId: q.get("module") || null };
  if ((m = p.match(new RegExp(`^/teamlead/review/(${OID})`, "i")))) return { kind: "task", id: m[1] };
  if ((m = p.match(new RegExp(`^/teamlead/sprints/(${OID})`, "i")))) return { kind: "sprint", id: m[1] };
  if (p.startsWith("/teamlead/tasks") && new RegExp(`^${OID}$`, "i").test(q.get("task") ?? "")) return { kind: "task", id: q.get("task") };
  return { kind: "team" };
}
// Lists hold only the TL's own projects, sprints and tasks: anything else falls back to the team.
const TEAM = { kind: "team", label: "My team" };
export function resolveTlContext(ctx, { projects = [], sprints = [], tasks = [] } = {}) {
  const has = (list) => list.find((x) => String(x.id) === String(ctx?.id));
  if (ctx?.kind === "module") { const p = has(projects); return p ? { kind: "module", id: String(p.id), moduleId: ctx.moduleId ?? null, label: `Module: ${ctx.moduleTitle ?? p.title}` } : TEAM; }
  if (ctx?.kind === "sprint") { const s = has(sprints); return s ? { kind: "sprint", id: String(s.id), label: `Sprint: ${s.name}` } : TEAM; }
  if (ctx?.kind === "task") { const t = has(tasks); return t ? { kind: "task", id: String(t.id), label: `Task: ${t.title}` } : TEAM; }
  return TEAM;
}

export const TL_PROMPTS_FOR = {
  team: ["Who on my team is overloaded?", "Which tasks are blocked, and by what?", "What should I look at first today?"],
  module: ["Is this module on track for its deadline?", "What is blocking this module?", "Who has room for more work here?"],
  task: ["What is this task waiting for?", "Is this task at risk of being late?", "What does the review page say about this task?"],
  sprint: ["Will this sprint finish on time?", "Is the plan bigger than the team's capacity?", "Which tasks are at risk in this sprint?"],
};

export function tlSourcesFor(ctx) {
  const s = {
    dashboard: { label: "Dashboard", to: "/teamlead" }, modules: { label: "Modules", to: "/teamlead/modules" }, tasks: { label: "Tasks", to: "/teamlead/tasks" },
    review: { label: "Review", to: "/teamlead/review-submissions" }, team: { label: "Team", to: "/teamlead/team" }, sprints: { label: "Sprints", to: "/teamlead/sprints" }, performance: { label: "Performance", to: "/teamlead/performance" },
  };
  const name = String(ctx.label ?? "").replace(/^[A-Za-z]+: /, "");
  if (ctx.kind === "module") s.module = { label: name, to: `/teamlead/modules/${ctx.id}${ctx.moduleId ? `?module=${ctx.moduleId}` : ""}` };
  if (ctx.kind === "sprint") s.sprint = { label: name, to: `/teamlead/sprints/${ctx.id}` };
  if (ctx.kind === "task") { s.task = { label: name, to: `/teamlead/tasks?task=${ctx.id}` }; s.review = { label: "Review page", to: `/teamlead/review/${ctx.id}` }; }
  return s;
}

const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;
export function tlProactiveCards({ overloaded = 0, blocked = 0, reviewQueue = 0 } = {}) {
  const cards = [];
  if (overloaded) cards.push({ key: "overload", text: `${n(overloaded, "person is", "people are")} over capacity.`, to: "/teamlead/team", action: "Open Team" });
  if (blocked) cards.push({ key: "blocked", text: `${n(blocked, "task is", "tasks are")} blocked by an unfinished task.`, to: "/teamlead/tasks?blocked=1", action: "Open blocked tasks" });
  if (reviewQueue) cards.push({ key: "review", text: `${n(reviewQueue, "submission is", "submissions are")} waiting for your review.`, to: "/teamlead/review-submissions", action: "Open Review" });
  return cards;
}

const AI_STATE = (ev) => (ev?.status === "done" ? (ev.partial ? "partial" : "ready") : ev?.status === "pending" ? "pending" : "not_available");
// D-075: built field by field, so no AI score or AI text can reach the prompt, before or after the TL scores.
// The AI score is only ever shown by the review page. teamLeadScore is the TL's own number.
export function tlTaskForAi(t) {
  const who = [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].map((x) => x?.name).filter(Boolean);
  const out = { title: t.title, status: t.status, priority: t.priority, type: t.type, estimatedHours: t.estimatedHours ?? null, deadline: t.deadline ?? null,
    assignee: [...new Set(who)].join(", ") || null, blocked: t.blocked || undefined, qaRequired: t.qaRequired || undefined, aiReview: AI_STATE(t.aiEval) };
  if (t.tlScore != null) out.teamLeadScore = t.tlScore;
  return out;
}

const str = (s, min, max) => typeof s === "string" && s.trim().length >= min && s.trim().length <= max;
const INSIGHT_KINDS = ["overload", "bottleneck", "blocked", "deadline", "none"];
export function validateTlInsight(obj, refs) {
  if (!obj || !INSIGHT_KINDS.includes(obj.kind)) return { ok: false, error: "kind" };
  if (obj.kind === "none") return { ok: true, value: { kind: "none" } };
  if (!str(obj.title, 3, 90) || !str(obj.body, 10, 320)) return { ok: false, error: "text" };
  if (!Array.isArray(obj.why) || obj.why.length < 1 || obj.why.length > 4 || !obj.why.every((w) => str(w, 2, 160))) return { ok: false, error: "why" };
  const target = obj.target ?? null;
  if (target !== null && !["m", "t", "k", "s"].some((k) => refs.has(target, k))) return { ok: false, error: "invented id" };
  if (![obj.title, obj.body, ...obj.why].every(isNeutral)) return { ok: false, error: "wording" };
  return { ok: true, value: { kind: obj.kind, title: obj.title.trim(), body: obj.body.trim(), why: obj.why.map((w) => w.trim()), target } };
}
// Picks one of the engine's candidates (c#); anything else is invented.
export function validateAssignHint(obj, refs) {
  if (!obj || !refs.has(obj.candidate, "c")) return { ok: false, error: "invented id" };
  if (!str(obj.reason, 5, 240) || !isNeutral(obj.reason)) return { ok: false, error: "reason" };
  return { ok: true, value: { candidate: obj.candidate, reason: obj.reason.trim() } };
}
// Explains the engine's numbers in words. A number the engine did not give means the AI made it up.
const numbersIn = (v, out = new Set()) => {
  if (typeof v === "number") out.add(String(Math.round(v * 100) / 100));
  else if (typeof v === "string") for (const m of v.match(/\d+(?:\.\d+)?/g) ?? []) out.add(String(Number(m)));
  else if (Array.isArray(v)) { out.add(String(v.length)); v.forEach((x) => numbersIn(x, out)); }
  else if (v && typeof v === "object") Object.values(v).forEach((x) => numbersIn(x, out));
  return out;
};
export function validateRealismExplain(obj, realism) {
  if (!obj || !str(obj.explanation, 15, 700) || !isNeutral(obj.explanation)) return { ok: false, error: "text" };
  const allowed = numbersIn(realism);
  for (const m of obj.explanation.match(/\d+(?:\.\d+)?/g) ?? []) if (!allowed.has(String(Number(m)))) return { ok: false, error: "new number" };
  return { ok: true, value: { explanation: obj.explanation.trim() } };
}
