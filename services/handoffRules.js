// Handoff view (T-4, D-138; TL-09, FR03-11): Design → Dev → Test built from task types and dependencies. Pure; never
// walks the graph, so a loop cannot hang it. Tests: tests/reviewRules.test.mjs.
const STAGE = { Design: "design", Testing: "test" };
const LABEL = { design: "Design", dev: "Development", test: "Testing" };

// tasks: [{ id, title, type, status, dependsOn: [id], qaRequired, qa? }]; qa = state from qaState.
export function handoffChain(tasks) {
  const byId = new Map(tasks.map((t) => [String(t.id), t]));
  const stages = ["design", "dev", "test"].map((key) => ({ key, label: LABEL[key], tasks: [] }));
  for (const t of tasks) {
    const pre = (t.dependsOn ?? []).map((d) => byId.get(String(d))).filter(Boolean);
    const waitingFor = pre.filter((p) => p.status !== "Done").map((p) => ({ id: p.id, title: p.title, status: p.status }));
    const row = { ...t, waitingFor, blocked: t.status !== "Done" && waitingFor.length > 0, unblocked: t.status !== "Done" && pre.length > 0 && waitingFor.length === 0 };
    stages.find((s) => s.key === (STAGE[t.type] ?? "dev")).tasks.push(row);
  }
  const need = tasks.filter((t) => t.qaRequired);
  return { stages, qaStep: { required: need.length, signed: need.filter((t) => t.qa === "passed" || t.qa === "conditional").length,
    tasks: need.map((t) => ({ id: t.id, title: t.title, status: t.status, qa: t.qa ?? "waiting" })) } };
}
