// Departments, skills and phone (Batch 5: D4, N4, N5; FR01-05/06/08, FR12-02) — pure, no DB. Tests: tests/b5Rules.test.mjs.
// A department is a name in Organization.departments (active) or Organization.archivedDepartments; a member holds the name.
export const DEPT_MIN = 2, DEPT_MAX = 40, SKILL_MAX = 30, SKILLS_MAX = 20;
const no = (status, error, field) => ({ ok: false, status, error, field });
const PLAIN = /^[\p{L}\p{N} .,&/+#()'-]+$/u; // letters, digits and a few signs: no < > or line breaks
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const find = (list, name) => (list ?? []).find((d) => same(d, name));

export function readDepartmentName(raw) {
  if (typeof raw !== "string") return no(400, "Give the department a name.", "name");
  const name = raw.trim().replace(/ {2,}/g, " ");
  if (name.length < DEPT_MIN || name.length > DEPT_MAX) return no(400, `A department name has ${DEPT_MIN} to ${DEPT_MAX} characters.`, "name");
  if (!PLAIN.test(name)) return no(400, "Use letters, numbers and simple signs in the name.", "name");
  return { ok: true, name };
}
const taken = (org, name) => find(org.departments, name) ?? find(org.archivedDepartments, name);

export function addDepartment(org, raw) {
  const n = readDepartmentName(raw);
  if (!n.ok) return n;
  if (taken(org, n.name)) return no(409, find(org.archivedDepartments, n.name) ? "A department with this name is archived. Restore it instead." : "This department already exists.", "name");
  return { ok: true, departments: [...(org.departments ?? []), n.name] };
}
export function renameDepartment(org, from, raw) {
  const n = readDepartmentName(raw);
  if (!n.ok) return n;
  const current = typeof from === "string" ? taken(org, from.trim()) : null;
  if (!current) return no(404, "Department not found.", "from");
  const other = taken(org, n.name);
  if (other && !same(other, current)) return no(409, "Another department already has this name.", "name");
  const swap = (list) => (list ?? []).map((d) => (d === current ? n.name : d));
  return { ok: true, from: current, to: n.name, departments: swap(org.departments), archivedDepartments: swap(org.archivedDepartments) };
}
// A member's department: null / "" clears it; otherwise an active department of this organisation.
export function mayAssign(org, raw) {
  if (raw === null || raw === undefined || raw === "") return { ok: true, department: null };
  if (typeof raw !== "string") return no(400, "Choose a department from the list.", "department");
  const active = find(org.departments, raw.trim());
  if (active) return { ok: true, department: active };
  return find(org.archivedDepartments, raw.trim()) ? no(409, "This department is archived. Restore it or choose another.", "department") : no(404, "Department not found.", "department");
}

// Skills: up to 20 short labels, no duplicates (any letter case). Phone: optional, digits with + - ( ) and spaces.
export function readSkills(raw) {
  if (!Array.isArray(raw)) return no(400, "Skills are a list.", "skills");
  if (!raw.every((s) => typeof s === "string")) return no(400, "Each skill is a short text.", "skills");
  const skills = [];
  for (const s of raw.map((x) => x.trim().replace(/ {2,}/g, " ")).filter(Boolean)) {
    if (s.length > SKILL_MAX || !PLAIN.test(s)) return no(400, `A skill has up to ${SKILL_MAX} letters, numbers or simple signs.`, "skills");
    if (!skills.some((k) => same(k, s))) skills.push(s);
  }
  if (skills.length > SKILLS_MAX) return no(400, `List up to ${SKILLS_MAX} skills.`, "skills");
  return { ok: true, skills };
}
export function readPhone(raw) {
  if (raw === null || raw === undefined || raw === "") return { ok: true, phone: null };
  if (typeof raw !== "string") return no(400, "Write the phone number as text.", "phone");
  const phone = raw.trim().replace(/ {2,}/g, " ");
  const digits = phone.replace(/\D/g, "").length;
  if (!/^\+?[\d ()-]+$/.test(phone) || digits < 7 || digits > 15) return no(400, "A phone number has 7 to 15 digits; +, spaces, brackets and dashes are fine.", "phone");
  return { ok: true, phone };
}
