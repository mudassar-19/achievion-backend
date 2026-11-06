// U-1 rules: text limits, project setup gate, "Not started" health, leaderboard eligibility/ranks, notification prefs.
import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, lengthError } from "../services/textLimits.js";
import { setupState, activationBlockers } from "../services/projectSetupRules.js";
import { projectHealth } from "../services/projectHealth.js";
import { isRankable, rankRows, rankChange, scopesFor } from "../services/leaderboardRules.js";
import { groupsFor, prefKeyFor, isMuted, sanitizePrefs } from "../services/notificationPrefs.js";

test("name length limits: names 80, task title 120, descriptions and comments 2000", () => {
  assert.deepEqual(LIMITS, { name: 80, taskTitle: 120, description: 2000, comment: 2000 });
  assert.equal(lengthError("Project name", "x".repeat(80), "name"), null);
  assert.equal(lengthError("Project name", "x".repeat(81), "name"), "Project name can be at most 80 characters.");
  assert.equal(lengthError("Title", "x".repeat(121), "taskTitle"), "Title can be at most 120 characters.");
  assert.equal(lengthError("Description", "x".repeat(2001), "description"), "Description can be at most 2000 characters.");
  assert.equal(lengthError("Name", undefined, "name"), null);
});

test("project activate gate: ≥1 module with a Team Lead and ≥1 member", () => {
  assert.deepEqual(activationBlockers({ modules: [], memberCount: 0 }), ["Add at least one module.", "Assign a Team Lead to at least one module.", "Add at least one team member."]);
  assert.deepEqual(activationBlockers({ modules: [{ teamLeadId: null }], memberCount: 2 }), ["Assign a Team Lead to at least one module."]);
  assert.deepEqual(activationBlockers({ modules: [{ teamLeadId: "t" }], memberCount: 1 }), []);
  const s = setupState({ modules: [{ teamLeadId: null }], memberCount: 0 });
  assert.equal(s.complete, false);
  assert.deepEqual(s.steps.map((x) => [x.key, x.done]), [["modules", true], ["lead", false], ["team", false]]);
  assert.equal(setupState({ modules: [{ teamLeadId: "t" }], memberCount: 3 }).complete, true);
});

test("health: a project without tasks is 'Not started' (no score, not red)", () => {
  const h = projectHealth({ startDate: "2026-01-01", deadline: "2026-02-01", now: new Date("2026-06-01"), progressPct: 0, openTasks: 0, overdueTasks: 0, totalTasks: 0 });
  assert.equal(h.band, "Not started");
  assert.equal(h.score, null);
  const old = projectHealth({ startDate: "2026-01-01", deadline: "2026-02-01", now: new Date("2026-06-01"), progressPct: 0, openTasks: 3, overdueTasks: 3, totalTasks: 3 });
  assert.equal(old.band, "Off track");
});

test("leaderboard: only XP roles are ranked; Managers and Directors never", () => {
  for (const r of ["Developer", "Senior Developer", "Junior Designer", "Designer", "Tester", "Senior Tester", "Team Lead"]) assert.equal(isRankable(r), true, r);
  for (const r of ["Manager", "Director", "org_admin", undefined]) assert.equal(isRankable(r), false, String(r));
});

test("leaderboard: ties share a rank (1, 1, 3), zero XP still ranked after others", () => {
  const out = rankRows([{ id: "a", xp: 50 }, { id: "b", xp: 80 }, { id: "c", xp: 80 }, { id: "d", xp: 0 }], (r) => r.xp);
  assert.deepEqual(out.map((r) => [r.id, r.rank]), [["b", 1], ["c", 1], ["a", 3], ["d", 4]]);
});

test("leaderboard: rank change direction and size (no '−#4')", () => {
  assert.deepEqual(rankChange(5, 2), { dir: "up", by: 3 });
  assert.deepEqual(rankChange(1, 4), { dir: "down", by: 3 });
  assert.deepEqual(rankChange(3, 3), { dir: "same", by: 0 });
  assert.deepEqual(rankChange(null, 2), { dir: "new", by: 0 });
});

test("leaderboard scopes per viewer", () => {
  assert.deepEqual(scopesFor("Director"), ["company", "project"]);
  assert.deepEqual(scopesFor("Manager"), ["team", "project"]);
  assert.deepEqual(scopesFor("Team Lead"), ["team", "project"]);
  assert.deepEqual(scopesFor("Developer"), ["company", "team", "project"]);
});

test("notification groups by role; needs-action groups are locked on", () => {
  const mgr = groupsFor("Manager"), tl = groupsFor("Team Lead"), dev = groupsFor("Senior Developer");
  assert.ok(mgr.some((g) => g.key === "module_updates") && !mgr.some((g) => g.key === "xp_gained"));
  assert.ok(tl.some((g) => g.key === "task_unblocked") && tl.some((g) => g.key === "new_module" && g.locked));
  assert.ok(dev.some((g) => g.key === "level_up") && dev.some((g) => g.key === "task_assigned"));
  assert.ok(groupsFor("Manager").every((g) => g.types.length > 0)); // no dead toggle
});

test("prefs: muted only when the group is off and not locked; level-up found by its text", () => {
  assert.equal(prefKeyFor({ type: "system", message: "Level Up! You are now Level 3!" }, "Developer"), "level_up");
  assert.equal(prefKeyFor({ type: "badge", message: "Badge Unlocked" }, "Developer"), "badge_earned");
  assert.equal(isMuted({ role: "Developer", prefs: { level_up: false }, type: "system", message: "Level Up! You are now Level 3!" }), true);
  assert.equal(isMuted({ role: "Developer", prefs: { level_up: true }, type: "system", message: "Level Up! …" }), false);
  assert.equal(isMuted({ role: "Manager", prefs: { deadline_requests: false }, type: "deadline_change_request" }), false); // locked
  assert.equal(isMuted({ role: "Manager", prefs: { overload: false }, type: "workload_over_limit" }), true);
  assert.equal(isMuted({ role: "Manager", prefs: {}, type: "workload_over_limit" }), false); // default on
  assert.equal(isMuted({ role: "Team Lead", prefs: { anything: false }, type: "system", message: "x" }), false); // unmapped type → always delivered
});

test("prefs: sanitize keeps only this role's unlocked keys as booleans", () => {
  assert.deepEqual(sanitizePrefs({ overload: false, deadline_requests: false, evil: true, module_updates: "no" }, "Manager"), { overload: false });
});

test("preferences: landing page per role, date/time format, time zone, AI panel", async () => {
  const { validatePreferences, landingFor } = await import("../services/notificationPrefs.js");
  assert.deepEqual(validatePreferences({ landing: "inbox", dateFormat: "dmy", timeFormat: "24h", timezone: "Asia/Karachi", aiPanel: false }, "Manager").value,
    { landing: "inbox", dateFormat: "dmy", timeFormat: "24h", timezone: "Asia/Karachi", aiPanel: false });
  assert.ok(validatePreferences({ landing: "inbox" }, "Developer").error); // not a Developer page
  assert.ok(validatePreferences({ timezone: "Mars/Base" }, "Manager").error);
  assert.ok(validatePreferences({ dateFormat: "xx" }, "Manager").error);
  assert.equal(landingFor("Team Lead", "modules"), "/teamlead/modules");
  assert.equal(landingFor("Team Lead", "home"), null);
  assert.equal(landingFor("Senior Developer", "tasks"), "/workspace/tasks");
  assert.equal(landingFor("Manager", "nope"), null);
});
