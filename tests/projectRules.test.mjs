// Manager Projects rules (V2 Phase 3 · M-2): list query, project input, deadline extension limits, archive/restore.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseListQuery, validateProjectInput, extensionDecision, archiveTransition, PAGE_SIZE,
} from "../services/projectRules.js";

const d = (s) => new Date(`2026-11-${s}T00:00:00Z`);

// ── list query ───────────────────────────────────────────────────────────────
test("list query: defaults", () => {
  assert.deepEqual(parseListQuery({}), { search: "", status: [], priority: [], archived: false, page: 1, limit: PAGE_SIZE, sort: "deadline", dir: 1 });
  assert.equal(PAGE_SIZE, 25);
});

test("list query: keeps only known statuses/priorities, CSV or array", () => {
  const q = parseListQuery({ status: "Active,Bogus,On Hold", priority: ["High", "x"], page: "3", sort: "title", dir: "desc" });
  assert.deepEqual(q.status, ["Active", "On Hold"]);
  assert.deepEqual(q.priority, ["High"]);
  assert.equal(q.page, 3); assert.equal(q.sort, "title"); assert.equal(q.dir, -1);
});

test("list query: archived flag, bad page and unknown sort fall back", () => {
  const q = parseListQuery({ archived: "1", page: "-4", sort: "$where" });
  assert.equal(q.archived, true); assert.equal(q.page, 1); assert.equal(q.sort, "deadline");
});

test("list query: search is trimmed, capped and regex-safe", () => {
  const q = parseListQuery({ search: "  a.b*(c)  " + "x".repeat(200) });
  assert.ok(q.search.length <= 80);
  assert.ok(q.search.startsWith("a\\.b\\*\\(c\\)"));
});

// ── project input ────────────────────────────────────────────────────────────
const good = { title: "Client portal", priority: "High", startDate: "2026-11-10", deadline: "2026-12-20", teamLeadId: "6ae482651b917d09d0d30eaf", techStack: ["React"], workingHoursPerDay: 7 };

test("project input: valid create passes with normalised values", () => {
  const { errors, value } = validateProjectInput(good, { mode: "create", now: d("04") });
  assert.deepEqual(errors, {});
  assert.equal(value.title, "Client portal");
  assert.equal(value.priority, "High");
  assert.ok(value.deadline instanceof Date);
});

test("project input: create needs title, Team Lead, dates in order, start not in the past", () => {
  const { errors } = validateProjectInput({ title: " ", priority: "Urgent", startDate: "2026-11-01", deadline: "2026-10-30", techStack: "React" }, { mode: "create", now: d("04") });
  assert.ok(errors.title); assert.ok(errors.teamLeadId); assert.ok(errors.priority);
  assert.ok(errors.startDate); assert.ok(errors.deadline); assert.ok(errors.techStack);
});

test("project input: edit does not need a Team Lead and never takes the deadline", () => {
  const { errors, value } = validateProjectInput({ title: "Renamed", deadline: "2027-01-01" }, { mode: "edit", now: d("04") });
  assert.deepEqual(errors, {});
  assert.equal(value.deadline, undefined);
  assert.equal(value.teamLeadId, undefined);
});

test("project input: bad Team Lead id and too many tech items are rejected", () => {
  const { errors } = validateProjectInput({ ...good, teamLeadId: "nope", techStack: Array.from({ length: 31 }, (_, i) => `t${i}`) }, { mode: "create", now: d("04") });
  assert.ok(errors.teamLeadId); assert.ok(errors.techStack);
});

// ── extension (PD-026: Manager alone within limits, else Director) ───────────
const rules = { extensionMaxDays: 3, extensionMaxPct: 20, extensionCumCapPct: 20 };
const proj = { startDate: d("01"), deadline: d("21") }; // 20-day plan

test("extension: 2 days on a 20-day plan is within the Manager's limit", () => {
  const r = extensionDecision({ ...proj, newDeadline: d("23"), extendedDaysSoFar: 0, rules });
  assert.equal(r.error, undefined); assert.equal(r.days, 2); assert.equal(r.withinLimit, true);
});

test("extension: more days than the day limit needs the Director", () => {
  const r = extensionDecision({ ...proj, newDeadline: d("25"), extendedDaysSoFar: 0, rules });
  assert.equal(r.days, 4); assert.equal(r.withinLimit, false);
  assert.ok(r.reasons.some((x) => /3 days/.test(x)));
});

test("extension: percent and cumulative caps count earlier extensions", () => {
  // 20-day plan, 3 days already given → original plan 17 days; 2 more = 5 > 20 % of 17 (3.4)
  const r = extensionDecision({ startDate: d("01"), deadline: d("21"), newDeadline: d("23"), extendedDaysSoFar: 3, rules });
  assert.equal(r.withinLimit, false);
  assert.ok(r.reasons.some((x) => /in total/.test(x)));
});

test("extension: new date must be after the current deadline; no deadline → error", () => {
  assert.ok(extensionDecision({ ...proj, newDeadline: d("20"), extendedDaysSoFar: 0, rules }).error);
  assert.ok(extensionDecision({ ...proj, newDeadline: "not a date", extendedDaysSoFar: 0, rules }).error);
  assert.ok(extensionDecision({ startDate: d("01"), deadline: null, newDeadline: d("23"), extendedDaysSoFar: 0, rules }).error);
});

test("extension: missing org rules use the PD-026 defaults", () => {
  assert.equal(extensionDecision({ ...proj, newDeadline: d("24"), extendedDaysSoFar: 0, rules: {} }).withinLimit, true);
  assert.equal(extensionDecision({ ...proj, newDeadline: d("25"), extendedDaysSoFar: 0, rules: {} }).withinLimit, false);
});

// ── archive / restore ────────────────────────────────────────────────────────
test("archive: open project archives and remembers its status", () => {
  assert.deepEqual(archiveTransition({ status: "Active" }, "archive"), { status: "Archived", statusBeforeArchive: "Active" });
});

test("archive: already archived or deleted cannot be archived", () => {
  assert.ok(archiveTransition({ status: "Archived" }, "archive").error);
  assert.ok(archiveTransition({ status: "Deleted" }, "archive").error);
});

test("restore: goes back to the remembered status, else Planning; only archived projects", () => {
  assert.deepEqual(archiveTransition({ status: "Archived", statusBeforeArchive: "On Hold" }, "restore"), { status: "On Hold", statusBeforeArchive: null });
  assert.deepEqual(archiveTransition({ status: "Archived" }, "restore"), { status: "Planning", statusBeforeArchive: null });
  assert.ok(archiveTransition({ status: "Active" }, "restore").error);
});
