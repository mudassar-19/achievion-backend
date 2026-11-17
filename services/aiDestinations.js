// QA4 Y-1: where a card opens, per portal. Only EXISTING screens (the QA3 notification destination map is the model).
const MAP = {
  Manager: { person: "/manager/resources?member=:id", task: "/manager/tasks/:id", project: "/manager/projects/:id", sprint: "/manager/sprints/:id", flag: "/manager/anomalies?flag=:id", request: "/manager/inbox" },
  "Team Lead": { person: "/teamlead/team?user=:id", task: "/teamlead/tasks/:id", project: "/teamlead/projects/:id", sprint: "/teamlead/sprints/:id", flag: "/teamlead/reviews?flag=:id", request: "/teamlead/requests" },
  Director: { person: "/director/roster?user=:id", task: "/director/projects?task=:id", project: "/director/projects/:id", sprint: "/director/reports?sprint=:id", flag: "/director/anomalies?flag=:id", request: "/director/approvals" },
};
export const destinationsFor = (role) => MAP[role] ?? {};
