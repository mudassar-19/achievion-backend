// E-1 (employee shell): nav per role, role words, notification links for employees, old URL map.
import test from "node:test";
import assert from "node:assert/strict";
import { notifRedirectPath } from "../../client/src/utils/notifRoutes.js";
import { employeeKind, employeeNav, ROLE_WORDS, OLD_EMPLOYEE_URLS } from "../../client/src/utils/employeePortal.js";

const EMPLOYEE_ROLES = ["Developer", "Senior Developer", "Junior Developer", "Designer", "Senior Designer", "Junior Designer", "Tester", "Senior Tester", "Junior Tester"];
const MANAGER_ONLY = /^\/workspace\/(projects|board|team-overview|gantt|reports|availability|workforce|operations|team)(\/|$|\?)/;
const TYPES = ["task_assigned", "task_updated", "task_approved", "task_rejected", "review_requested", "deadline_soon", "deadline_missed", "mention",
  "qa_signoff_needed", "qa_signoff_done", "resubmission_decided", "project_created", "project_updated", "team_assigned", "team_request",
  "badge_unlocked", "xp_gained", "level_up", "title_unlocked", "sprint_started", "sprint_closed", "approval_requested", "approval_resolved", "risk_alert", "something_new"];
const METAS = [{}, { taskId: "t1", projectId: "p1", sprintId: "s1", memberId: "m1" }];

test("employee notification links never open a Manager-only page and stay in /workspace", () => {
  for (const role of EMPLOYEE_ROLES) for (const type of TYPES) for (const meta of METAS) {
    const to = notifRedirectPath({ type, meta }, role);
    assert.match(to, /^\/workspace(\/|$)/, `${role} ${type}`);
    assert.doesNotMatch(to, MANAGER_ONLY, `${role} ${type} → ${to}`);
  }
  assert.equal(notifRedirectPath({ type: "task_assigned", meta: { taskId: "t1" } }, "Developer"), "/workspace/tasks/t1");
  assert.equal(notifRedirectPath({ type: "badge_unlocked" }, "Tester"), "/workspace/achievements");
  assert.equal(notifRedirectPath({ type: "project_created", meta: { projectId: "p1" } }, "Designer"), "/workspace/tasks");
});

test("Manager, Team Lead and no-role links are unchanged", () => {
  const n = (type, meta = {}) => ({ type, meta });
  assert.equal(notifRedirectPath(n("project_created", { projectId: "p1" }), "Manager"), "/manager/projects/p1");
  assert.equal(notifRedirectPath(n("task_assigned", { taskId: "t1" }), "Team Lead"), "/teamlead/tasks?task=t1");
  // The old shared NotificationsPage (still used by /manager/notifications) calls it without a role.
  assert.equal(notifRedirectPath(n("project_created", { projectId: "p1" })), "/workspace/projects/p1");
  assert.equal(notifRedirectPath(n("team_assigned")), "/workspace/team-overview");
  assert.equal(notifRedirectPath(n("badge_unlocked")), "/workspace/badges");
});

test("employee kind and role words", () => {
  assert.equal(employeeKind("Senior Developer"), "developer");
  assert.equal(employeeKind("Junior Designer"), "designer");
  assert.equal(employeeKind("Tester"), "tester");
  assert.equal(employeeKind("Manager"), null);
  assert.equal(employeeKind("Team Lead"), null);
  assert.deepEqual(ROLE_WORDS.developer, ["build", "ship", "review"]);
  assert.deepEqual(ROLE_WORDS.designer, ["create", "iterate", "approve"]);
  assert.deepEqual(ROLE_WORDS.tester, ["inspect", "verify", "report"]);
});

test("nav: Work, Play, Talk for all; Quality only for the Tester", () => {
  const labels = (k) => employeeNav(k, "/workspace").map((g) => g.label);
  assert.deepEqual(labels("developer"), ["Work", "Play", "Talk"]);
  assert.deepEqual(labels("designer"), ["Work", "Play", "Talk"]);
  assert.deepEqual(labels("tester"), ["Work", "Quality", "Play", "Talk"]);
  const items = (k) => employeeNav(k, "/workspace").flatMap((g) => g.items.map((i) => i.label));
  assert.deepEqual(items("developer"), ["Today", "My tasks", "My submissions", "Quests", "Leaderboard", "Achievements", "Shop and avatar", "Collaboration", "Announcements"]);
  assert.deepEqual(employeeNav("tester", "/workspace")[1].items.map((i) => i.to), ["/workspace/qa", "/workspace/bugs", "/workspace/test-cases"]);
  assert.equal(employeeNav("developer", "/workspace/senior")[0].items[0].to, "/workspace/senior");
  for (const k of ["developer", "designer", "tester"]) for (const g of employeeNav(k, "/workspace")) for (const i of g.items) assert.doesNotMatch(i.to, MANAGER_ONLY);
});

test("old URLs map to the new ones", () => {
  assert.deepEqual(OLD_EMPLOYEE_URLS, { badges: "/workspace/achievements", avatar: "/workspace/inventory", sprint: "/workspace/tasks" });
});
