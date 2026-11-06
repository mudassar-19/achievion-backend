// U-1 (D-132): project setup gate (D-010/D-016: Project > Module > Task, one Team Lead per module).
// A project leaves Planning only when it has ≥1 module with a Team Lead and ≥1 team member. Tests: u1Rules.test.mjs.
// modules: [{ teamLeadId }], memberCount: people who do the work (Team Leads run a module, they are not the team).
export const NOT_MEMBER_ROLES = ["Team Lead", "Manager", "Director"];
export function setupState({ modules = [], memberCount = 0 }) {
  const steps = [
    { key: "modules", label: "Add modules", done: modules.length > 0 },
    { key: "lead", label: "Assign a Team Lead to a module", done: modules.some((m) => !!m.teamLeadId) },
    { key: "team", label: "Add team members", done: memberCount > 0 },
  ];
  return { steps, complete: steps.every((s) => s.done) };
}
export function activationBlockers({ modules = [], memberCount = 0 }) {
  const out = [];
  if (!modules.length) out.push("Add at least one module.");
  if (!modules.some((m) => !!m.teamLeadId)) out.push("Assign a Team Lead to at least one module.");
  if (memberCount < 1) out.push("Add at least one team member.");
  return out;
}
