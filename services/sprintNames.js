// LB-3: which sprints get the project title added to their name. rows = [{ _id, name, projectId }],
// titleOf = Map(String(projectId) -> title). Only names shared by 2+ projects change: "Sprint 2" -> "Sprint 2 · <project>".
export function planRenames(rows, titleOf) {
  const byName = new Map();
  for (const r of rows) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)).push(r);
  const out = [];
  for (const [name, list] of byName) {
    if (new Set(list.map((r) => String(r.projectId))).size < 2) continue;
    for (const r of list) { const t = titleOf.get(String(r.projectId)); if (t) out.push({ _id: r._id, before: name, after: `${name} · ${t}` }); }
  }
  return out;
}
