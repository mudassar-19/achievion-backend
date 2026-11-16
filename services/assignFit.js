// Items 53/54 (AI part, D-011): role category and domain facts for the assignment hint. Pure. Tests: tests/assignFit.test.mjs.
// The AI is told, per candidate, the role category and whether it fits the task and the parent's domain; fitting people come first.
// The result is advice: a note goes to the Team Lead, nothing is blocked. Names never go in (hidePeople strips them before the prompt).
import { ROLE_TASK_ELIGIBILITY, ROLE_TO_CATEGORY } from "./workloadService.js";

const DOMAIN = { Feature: "development", Bug: "development", DevOps: "development", Design: "design", Testing: "testing" }; // Documentation: any
const OF_CATEGORY = { developer: "development", designer: "design", tester: "testing" };
export const domainOf = (type) => DOMAIN[type] ?? null;

// null for leaders and unknown roles: they are not judged by category.
const categoryOf = (role) => { const c = ROLE_TO_CATEGORY[role]; return ["developer", "designer", "tester"].includes(c) ? c : null; };
const fitsType = (role, type) => { const c = categoryOf(role); return !c || !type || ROLE_TASK_ELIGIBILITY[c].includes(type); };

// candidates: [{ id, name, role, ... }] → { task: { type, parentDomain }, candidates: sorted, each with roleCategory, fits (task type),
// fitsParentDomain (only when the task has a parent with a domain) }
export function withFit({ taskType, parentType, candidates }) {
  const parentDomain = domainOf(parentType);
  const rows = candidates.map((c) => {
    const cat = categoryOf(c.role);
    return { ...c, roleCategory: cat ?? "leader", fits: fitsType(c.role, taskType),
      ...(parentDomain ? { fitsParentDomain: !cat || OF_CATEGORY[cat] === parentDomain } : {}) };
  });
  const rank = (c) => (parentDomain && !c.fitsParentDomain ? 2 : 0) + (c.fits ? 0 : 1);
  return { task: { type: taskType, parentDomain }, candidates: rows.sort((a, b) => rank(a) - rank(b)) };
}

// The note for the Team Lead about the person the AI picked, or null. Soft: never blocks.
export function fitNote({ taskType, parentType, pick }) {
  const own = domainOf(taskType), par = domainOf(parentType);
  if (own && par && own !== par) return `A ${own} subtask under a ${par} task. Check the parent, or who it is given to.`;
  if (pick && !fitsType(pick.role, taskType)) return `${pick.role} is not a usual fit for a ${taskType} task. You can still assign them.`;
  return null;
}
