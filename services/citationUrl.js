// QA2-27: a Director AI citation carries a url so the source chip is a link. Task and team rows have no page of their own;
// they open the closest page (projects list, team analytics).
const PAGE = { goal: "/director/goals", recap: "/director/reports", risk: "/director/risks", task: "/director/projects", team: "/director/analytics", "org-health": "/director/org-health" };
export function citationUrl(source, ref) {
  if (source === "project") return ref ? `/director/projects/${ref}` : "/director/projects";
  return PAGE[source] ?? null;
}
