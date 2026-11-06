// Manager AI rules (V2 Phase 3 · M-7, D-105..D-108) — pure, no DB, no network.
// Tests: server/tests/managerAiRules.test.mjs. The AI only suggests; nothing here writes data.
//
// IDs: the model never sees a database id. The server gives each entity a short reference ("m1", "p2",
// "s1", "t4", "c3") and keeps the map; a reply may only use references from that map (anything else is
// rejected as invented), and the server turns them back into real ids.

export const DEFAULT_DAILY_LIMIT = 30; // Manager AI calls per user per day (org setting aiSettings.managerDailyLimit)
export const FEATURE_PREFIX = "mgr_";  // every Manager AI call is logged as feature "mgr_*" in AIPromptLog

// ── References ────────────────────────────────────────────────────────────────
export function makeRefs() {
  const toId = new Map(), toRef = new Map(), count = {};
  return {
    add(kind, id) {
      const key = `${kind}:${id}`;
      if (toRef.has(key)) return toRef.get(key);
      count[kind] = (count[kind] ?? 0) + 1;
      const ref = `${kind}${count[kind]}`;
      toRef.set(key, ref); toId.set(ref, String(id));
      return ref;
    },
    id: (ref) => (typeof ref === "string" ? toId.get(ref) ?? null : null),
    has: (ref, kind) => typeof ref === "string" && toId.has(ref) && (!kind || new RegExp(`^${kind}\\d+$`).test(ref)),
  };
}

// ── Limits and cache ──────────────────────────────────────────────────────────
const startOfDay = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; };
export function dailyLimit(org) {
  const n = Number(org?.aiSettings?.managerDailyLimit);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : DEFAULT_DAILY_LIMIT;
}
export function usageState(used, limit, now = new Date()) {
  const resetsAt = new Date(+startOfDay(now) + 86_400_000);
  return { limit, used, remaining: Math.max(0, limit - used), resetsAt };
}
export const dayKey = (now = new Date()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// Same parts → same key. Query strings are sorted so "?a&b" and "?b&a" share a cache entry.
export function cacheKey(feature, parts = {}) {
  const norm = Object.keys(parts).sort().map((k) => {
    let v = parts[k] ?? "";
    if (k === "query") v = [...new URLSearchParams(String(v))].sort(([a], [b]) => a.localeCompare(b)).map(([a, b]) => `${a}=${b}`).join("&");
    return `${k}=${v}`;
  });
  return [feature, ...norm].join("|");
}

// ── Context chip ──────────────────────────────────────────────────────────────
// Which context a page means. Resolved against the caller's own org lists, so an id from another org
// (or a typo) never reaches a prompt: it falls back to the team context.
export function contextFromPath(pathname = "", search = "") {
  const p = String(pathname);
  let m;
  if ((m = p.match(/^\/manager\/projects\/([0-9a-f]{24})/i))) return { kind: "project", id: m[1] };
  if ((m = p.match(/^\/manager\/sprints\/([0-9a-f]{24})/i))) return { kind: "sprint", id: m[1] };
  if (p.startsWith("/manager/reports")) return { kind: "reports", query: String(search).replace(/^\?/, "") };
  return { kind: "team" };
}
export function resolveContext(ctx, { projects = [], sprints = [] } = {}) {
  const kind = ctx?.kind;
  if (kind === "project") {
    const p = projects.find((x) => String(x.id) === String(ctx.id));
    return p ? { kind, id: String(p.id), label: `Project: ${p.title}` } : { kind: "team", label: "Team" };
  }
  if (kind === "sprint") {
    const s = sprints.find((x) => String(x.id) === String(ctx.id));
    return s ? { kind, id: String(s.id), label: `Sprint: ${s.name}` } : { kind: "team", label: "Team" };
  }
  if (kind === "reports") {
    const q = new URLSearchParams(String(ctx.query ?? ""));
    for (const k of ["project", "sprint"]) {
      const v = q.get(k);
      if (v && !(k === "project" ? projects : sprints).some((x) => String(x.id) === v)) q.delete(k);
    }
    const keep = new URLSearchParams();
    for (const k of ["project", "sprint", "range", "from", "to"]) if (q.get(k)) keep.set(k, q.get(k));
    return { kind, query: keep.toString(), label: "Reports filters" };
  }
  return { kind: "team", label: "Team" };
}

export const PROMPTS_FOR = {
  team: ["Who is overloaded right now?", "Which project needs my attention this week?", "How did the team do compared to last week?"],
  project: ["Is this project on track for its deadline?", "What is slowing this project down?", "Who on this project has room for more work?"],
  sprint: ["Will this sprint finish on time?", "Is the sprint plan bigger than the team's capacity?", "Which tasks are at risk in this sprint?"],
  reports: ["Summarise these numbers in plain words.", "What changed compared to the period before?", "Where is quality dropping?"],
};

// Deep links the answer may cite. The model picks keys; unknown keys are rejected.
export function sourcesFor(ctx) {
  const s = {
    dashboard: { label: "Dashboard", to: "/manager" },
    resources: { label: "Resources · Workload", to: "/manager/resources" },
    anomalies: { label: "Anomalies", to: "/manager/anomalies" },
    sprints: { label: "Sprints", to: "/manager/sprints" },
    reports: { label: "Reports", to: `/manager/reports${ctx.kind === "reports" && ctx.query ? `?${ctx.query}` : ""}` },
  };
  if (ctx.kind === "project") s.project = { label: ctx.label.replace(/^Project: /, ""), to: `/manager/projects/${ctx.id}` };
  if (ctx.kind === "sprint") s.sprint = { label: ctx.label.replace(/^Sprint: /, ""), to: `/manager/sprints/${ctx.id}` };
  return s;
}

// Rule-based cards for the top of the panel (numbers only, no AI call).
export function proactiveCards({ overloaded = 0, overdue = 0, openAnomalies = 0, sprintsEndingSoon = [] } = {}) {
  const cards = [];
  if (overloaded) cards.push({ key: "overload", text: `${overloaded} ${overloaded === 1 ? "person is" : "people are"} over capacity.`, to: "/manager/resources", action: "Open Resources" });
  if (overdue) cards.push({ key: "overdue", text: `${overdue} ${overdue === 1 ? "task is" : "tasks are"} past the deadline.`, to: "/manager/projects", action: "Open Projects" });
  for (const s of sprintsEndingSoon.slice(0, 2)) cards.push({ key: `sprint-${s.id}`, text: `"${s.name}" ends in ${s.days} ${s.days === 1 ? "day" : "days"} with ${s.left} ${s.left === 1 ? "task" : "tasks"} open.`, to: `/manager/sprints/${s.id}`, action: "Open sprint" });
  if (openAnomalies) cards.push({ key: "anomalies", text: `${openAnomalies} ${openAnomalies === 1 ? "flag needs" : "flags need"} a second look.`, to: "/manager/anomalies", action: "Open Anomalies" });
  return cards.slice(0, 4);
}

// ── Prompt data ───────────────────────────────────────────────────────────────
// Drops database ids and trims long arrays / strings, so the prompt holds numbers and names only.
const ID_KEY = /^(_id|id|.*Id|.*Ids|userId)$/;
export function prune(v, { maxArray = 12, maxString = 160, depth = 0 } = {}) {
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.slice(0, maxArray).map((x) => prune(x, { maxArray, maxString, depth: depth + 1 })).filter((x) => x !== undefined);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === "object") {
    if (v._bsontype) return undefined; // ObjectId
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (ID_KEY.test(k)) continue;
      const p = prune(x, { maxArray, maxString, depth: depth + 1 });
      if (p !== undefined && p !== null && !(typeof p === "object" && !Array.isArray(p) && !Object.keys(p).length)) out[k] = p;
    }
    return out;
  }
  if (typeof v === "string") return /^[0-9a-f]{24}$/i.test(v) ? undefined : v.slice(0, maxString);
  return v;
}

// Text the Manager reads shows names, never references: "m1 (Ana)" / "Ana (m1)" / "m1" → "Ana".
export function withNames(text, names = {}) {
  return String(text ?? "")
    .replace(/\s*\(([a-z]\d+)\)/g, (all, r) => (names[r] ? "" : all)) // "Ana (m1)" → "Ana"
    .replace(/\b([a-z])(\d+)\s*\(([^)]{1,80})\)/g, (all, k, n, inner) => (names[`${k}${n}`] ? inner : all))
    .replace(/\b([a-z]\d+)\b/g, (r) => names[r] ?? r);
}

// ── Output validators ─────────────────────────────────────────────────────────
const str = (s, min, max) => typeof s === "string" && s.trim().length >= min && s.trim().length <= max;
const clean = (s) => s.trim().replace(/\s+\n/g, "\n");
// A suggestion never blames anyone (UX §9, D-099 neutral wording).
const BLAME = /\b(cheat\w*|fraud\w*|dishonest\w*|lazy|lied|lying|guilty|blame\w*|at fault|suspicious|manipulat\w*|scam\w*)\b/i;
export const isNeutral = (text) => !BLAME.test(String(text ?? ""));

export function validateChat(obj, allowedSources) {
  if (!obj || !str(obj.answer, 1, 1500)) return { ok: false, error: "answer" };
  const sources = Array.isArray(obj.sources) ? obj.sources : [];
  if (sources.length > 3 || !sources.every((k) => typeof k === "string" && Object.hasOwn(allowedSources, k))) return { ok: false, error: "sources" };
  if (!isNeutral(obj.answer)) return { ok: false, error: "wording" };
  return { ok: true, value: { answer: clean(obj.answer), sources: [...new Set(sources)] } };
}

const INSIGHT_KINDS = ["overload", "bottleneck", "deadline", "quality", "none"];
export function validateInsight(obj, refs) {
  if (!obj || !INSIGHT_KINDS.includes(obj.kind)) return { ok: false, error: "kind" };
  if (obj.kind === "none") return { ok: true, value: { kind: "none" } };
  if (!str(obj.title, 3, 90) || !str(obj.body, 10, 320)) return { ok: false, error: "text" };
  if (!Array.isArray(obj.why) || obj.why.length < 1 || obj.why.length > 4 || !obj.why.every((w) => str(w, 3, 160))) return { ok: false, error: "why" };
  const target = obj.target ?? null;
  if (target !== null && !(refs.has(target, "m") || refs.has(target, "p") || refs.has(target, "s"))) return { ok: false, error: "invented id" };
  if (![obj.title, obj.body, ...obj.why].every(isNeutral)) return { ok: false, error: "wording" };
  return { ok: true, value: { kind: obj.kind, title: obj.title.trim(), body: obj.body.trim(), why: obj.why.map((w) => w.trim()), target } };
}

export function validateNarrative(obj) {
  if (!obj || !str(obj.narrative, 40, 900) || !isNeutral(obj.narrative)) return { ok: false };
  return { ok: true, value: { narrative: clean(obj.narrative) } };
}

// Capacity-fit scope: add only backlog tasks, remove only sprint tasks, and the result must fit.
export function validateScope(obj, refs, { sprintHours = {}, backlogHours = {}, capacity = 0 } = {}) {
  if (!obj || !Array.isArray(obj.add) || !Array.isArray(obj.remove) || !str(obj.why, 5, 240)) return { ok: false, error: "shape" };
  const add = [...new Set(obj.add)], remove = [...new Set(obj.remove)];
  if (add.length > 10 || remove.length > 10) return { ok: false, error: "too many" };
  if (!add.every((r) => refs.has(r, "t") && Object.hasOwn(backlogHours, r))) return { ok: false, error: "invented id" };
  if (!remove.every((r) => refs.has(r, "t") && Object.hasOwn(sprintHours, r))) return { ok: false, error: "invented id" };
  const total = (m, keep) => Object.entries(m).filter(([r]) => keep(r)).reduce((s, [, h]) => s + (Number(h) || 0), 0);
  const after = total(sprintHours, (r) => !remove.includes(r)) + total(backlogHours, (r) => add.includes(r));
  if (add.length && capacity > 0 && after > capacity) return { ok: false, error: "over capacity" };
  return { ok: true, value: { add, remove, why: obj.why.trim(), hoursAfter: Math.round(after * 10) / 10 } };
}

export function validateLessonsDraft(obj) {
  if (!obj || !Array.isArray(obj.lessons) || obj.lessons.length < 1 || obj.lessons.length > 3 || !obj.lessons.every((l) => str(l, 5, 300) && isNeutral(l))) return { ok: false };
  return { ok: true, value: { lessons: obj.lessons.map((l) => l.trim()) } };
}

// Challenge draft: the Manager edits it in the normal form; the form and the server re-check everything.
const DRAFT_TYPES = ["weekly", "custom"];
export function validateChallengeDraft(obj, { metrics = [], cap = { xp: 500, gold: 250 } } = {}) {
  if (!obj || !str(obj.title, 3, 100) || !str(obj.description, 0, 500) || !str(obj.why, 5, 240)) return { ok: false, error: "text" };
  if (!DRAFT_TYPES.includes(obj.type) || !metrics.includes(obj.metric)) return { ok: false, error: "type/metric" };
  const t = Number(obj.target);
  if (obj.metric === "avg_quality" ? !(t >= 1 && t <= 5) : !(Number.isInteger(t) && t >= 1 && t <= 365)) return { ok: false, error: "target" };
  const xp = Number(obj.rewardXp);
  if (!Number.isInteger(xp) || xp < 10 || xp > cap.xp) return { ok: false, error: "reward" };
  if (![obj.title, obj.description, obj.why].every(isNeutral)) return { ok: false, error: "wording" };
  return { ok: true, value: { title: obj.title.trim(), description: (obj.description ?? "").trim(), type: obj.type, metric: obj.metric, target: t, rewardXp: xp, why: obj.why.trim() } };
}

// Rebalance: pick exactly one of the engine's eligible candidates (D-095).
export function validateRebalance(obj, refs) {
  if (!obj || !refs.has(obj.candidate, "c") || !str(obj.reason, 5, 240) || !isNeutral(obj.reason)) return { ok: false, error: obj && !refs.has(obj.candidate, "c") ? "invented id" : "shape" };
  return { ok: true, value: { candidate: obj.candidate, reason: obj.reason.trim() } };
}

export function validateExplain(obj) {
  if (!obj || !str(obj.explanation, 20, 700) || !isNeutral(obj.explanation)) return { ok: false };
  return { ok: true, value: { explanation: clean(obj.explanation) } };
}
