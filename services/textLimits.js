// U-1 (D-130) + QA2 item 21: one set of text limits for every portal. Tests: server/tests/u1Rules.test.mjs.
// project / module / sprint / challenge names 80; task titles 120; person 60; team and department 40; community and group 50;
// organisation 80; role label 40; descriptions 500; comments 2000. Old longer data is never rejected on read, only on write.
export const LIMITS = { name: 80, taskTitle: 120, description: 500, comment: 2000, person: 60, team: 40, group: 50, org: 80, role: 40 };
// → null when fine, else a plain message for a 400.
export function lengthError(label, value, kind) {
  if (value === undefined || value === null) return null;
  const max = LIMITS[kind];
  return String(value).trim().length > max ? `${label} can be at most ${max} characters.` : null;
}
// [[label, value, kind], ...] → first error message or null.
export const firstLengthError = (checks) => checks.map(([l, v, k]) => lengthError(l, v, k)).find(Boolean) ?? null;
