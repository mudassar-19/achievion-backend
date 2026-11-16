// Item 7 (D-541): the department a new employee gets from their role category. Pure. Tests: tests/departmentDefault.test.mjs.
// Rename and archive stay with the Director (directorOrgController, audit-logged); this only picks a starting point.
import { ROLE_CATEGORY_MAP } from "../models/User.js";

export const DEFAULT_DEPARTMENTS = ["Development", "Design", "QA"];
const BY_CATEGORY = { developer: "Development", designer: "Design", tester: "QA", team_lead: "Development" }; // Manager, Director: none

// The ACTIVE department of the organisation that matches the role's category (in the organisation's own spelling), else null.
export function defaultDepartmentFor(role, org) {
  const want = BY_CATEGORY[ROLE_CATEGORY_MAP[role]];
  return want ? (org?.departments ?? []).find((d) => d.toLowerCase() === want.toLowerCase()) ?? null : null;
}

// A brand-new organisation has no department at all. Once the Director has archived one, defaults are not brought back.
export const needsDefaults = (org) => !(org?.departments ?? []).length && !(org?.archivedDepartments ?? []).length;
