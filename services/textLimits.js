// U-1 (D-130): one set of text limits for every portal. Tests: server/tests/u1Rules.test.mjs.
// Names (project, module, sprint, challenge, community, group/channel) 80; task titles 120; descriptions and comments 2000.
export const LIMITS = { name: 80, taskTitle: 120, description: 2000, comment: 2000 };
// → null when fine, else a plain message for a 400.
export function lengthError(label, value, kind) {
  if (value === undefined || value === null) return null;
  const max = LIMITS[kind];
  return String(value).trim().length > max ? `${label} can be at most ${max} characters.` : null;
}
// [[label, value, kind], ...] → first error message or null.
export const firstLengthError = (checks) => checks.map(([l, v, k]) => lengthError(l, v, k)).find(Boolean) ?? null;
