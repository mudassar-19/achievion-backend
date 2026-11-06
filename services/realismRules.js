// Breakdown realism check (V2 Phase 4 · T-3, UX TL v4 §4, D-012, D-017, D-072, D-126) — pure, no DB.
// Tests: server/tests/breakdownRules.test.mjs. Numbers always come from here (the workload engine's inputs);
// an AI may only explain them.
import { loadLabel } from "./resourceRules.js";

export const MIN_HOURS = 1, MAX_HOURS = 14;  // D-012
export const TIGHT_PCT = 85;                  // above this share of the free hours the plan is "tight"

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
// Working days from today to the deadline, both included; 0 when the deadline has passed (D-017).
export function workingDaysUntil(today, deadline, workingDays) {
  const s = startOfDay(today), e = startOfDay(deadline);
  if (e < s) return 0;
  let n = 0;
  for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) if (workingDays.includes(d.getDay())) n++;
  return n;
}

// rows: [{ key, title, hours, type, assigneeId, acceptanceCriteria, qaRequired }]
// team: [{ id, name, roleCategory, capacityPerDay, allocatedPerDay }] (engine snapshot: hours per day)
// workTime: { hoursPerDay, workingDays }; deadline: Date | null
export function realismCheck({ rows = [], team = [], workTime, today = new Date(), deadline = null }) {
  const issues = [];
  if (!rows.length) return { verdict: "empty", totals: null, issues, people: [], suggestions: [], blocking: false };
  const round = (n) => Math.round(n * 10) / 10;

  // Per row (D-012 + quality)
  for (const r of rows) {
    const h = Number(r.hours);
    if (r.hours === null || r.hours === undefined || r.hours === "" || Number.isNaN(h)) issues.push({ level: "error", code: "missing_estimate", rowKey: r.key, message: `"${r.title}": add an estimate (1 to 14 hours).` });
    else if (h > MAX_HOURS) issues.push({ level: "error", code: "split", rowKey: r.key, message: `"${r.title}": ${round(h)} h is over 14 h. Split suggested.` });
    else if (h < MIN_HOURS) issues.push({ level: "error", code: "merge", rowKey: r.key, message: `"${r.title}": under 1 h. Merge suggested.` });
    if (!(r.acceptanceCriteria ?? []).some((c) => String(c).trim())) issues.push({ level: "warning", code: "missing_criteria", rowKey: r.key, message: `"${r.title}": no acceptance criteria yet.` });
  }
  if (!rows.some((r) => r.type === "Testing" || r.qaRequired)) issues.push({ level: "warning", code: "qa_missing", message: "No testing task and no task marked QA required. Who checks the work?" });

  const taskHours = round(rows.reduce((s, r) => s + (Number(r.hours) > 0 ? Number(r.hours) : 0), 0));
  const days = deadline ? workingDaysUntil(today, deadline, workTime.workingDays) : 0;
  const capacityHours = round(team.reduce((s, m) => s + (m.capacityPerDay ?? workTime.hoursPerDay) * days, 0));
  const existingHours = round(team.reduce((s, m) => s + Math.min(m.allocatedPerDay ?? 0, m.capacityPerDay ?? workTime.hoursPerDay) * days, 0));
  const freeHours = round(Math.max(0, capacityHours - existingHours));
  const usedPct = freeHours ? Math.round((taskHours / freeHours) * 100) : null;

  // Per assignee (D-072 wording)
  const added = {};
  for (const r of rows) if (r.assigneeId && Number(r.hours) > 0) added[r.assigneeId] = (added[r.assigneeId] ?? 0) + Number(r.hours);
  const people = team.filter((m) => added[m.id]).map((m) => {
    const cap = (m.capacityPerDay ?? workTime.hoursPerDay) * Math.max(1, days);
    const before = Math.round(((m.allocatedPerDay ?? 0) * Math.max(1, days) / cap) * 100);
    const afterPct = Math.round((((m.allocatedPerDay ?? 0) * Math.max(1, days) + added[m.id]) / cap) * 100);
    return { id: m.id, name: m.name, addedHours: round(added[m.id]), beforePct: before, afterPct, label: loadLabel(afterPct) };
  });
  for (const p of people) if (p.afterPct > 100) issues.push({ level: "warning", code: "person_over", personId: p.id, message: `${p.name} would be at ${p.label} until the deadline.` });

  let verdict;
  if (!deadline) { verdict = "no_deadline"; issues.push({ level: "warning", code: "no_deadline", message: "The module has no deadline, so the plan cannot be checked against the time left." }); }
  else if (!days || taskHours > freeHours) { verdict = "over"; issues.push({ level: "warning", code: "over_capacity", message: !days ? "The deadline has passed." : `The tasks need ${taskHours} h but the team has ${freeHours} h free until the deadline.` }); }
  else verdict = usedPct > TIGHT_PCT ? "tight" : "fits";

  return {
    verdict, blocking: issues.some((i) => i.level === "error"),
    totals: { taskHours, days, capacityHours, existingHours, freeHours, usedPct },
    issues, people,
    suggestions: verdict === "over" || verdict === "tight" ? ["reduce_scope", "request_deadline", "add_person"] : [],
  };
}
