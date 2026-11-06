// Manager Resources rules (V2 Phase 3 · M-4).
import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveThreshold, validateThreshold, statusBadge, loadLabel, loadTone, barPct, hpTier, needsLighterLoad, dueThisWeek,
  reassignBlockers, reassignUpdate, previewLoad, candidateReason, rankCandidates, validateAssetInput, expiryState,
} from "../services/resourceRules.js";
import { workloadTier } from "../services/workloadRules.js";

const A = "6aeab4127422de422c4af81b", B = "6aeab42b7422de422c4af82e", C = "6aeab6397422de422c4af831";
const d = (s) => new Date(`2026-11-${s}T00:00:00Z`);

test("threshold: Director default unless the Manager overrides; range 50–150", () => {
  assert.equal(effectiveThreshold(100, null), 100);
  assert.equal(effectiveThreshold(100, 80), 80);
  assert.equal(effectiveThreshold(undefined, null), 100);
  assert.deepEqual(validateThreshold(90), { value: 90 });
  assert.deepEqual(validateThreshold(null), { value: null });
  for (const bad of [49, 151, 85.5, "x"]) assert.ok(validateThreshold(bad).error);
});

test("status badge uses the limit and the HP burnout line; tier formula untouched", () => {
  assert.equal(statusBadge({ utilisation: 30 }), "Available");
  assert.equal(statusBadge({ utilisation: 90 }), "Active");
  assert.equal(statusBadge({ utilisation: 101 }), "Overloaded");
  assert.equal(statusBadge({ utilisation: 90, threshold: 85 }), "Overloaded");
  assert.equal(statusBadge({ utilisation: 30, hp: 20 }), "Overloaded");
  assert.deepEqual([40, 80, 100, 101].map((u) => workloadTier(u).label), ["Free", "Moderate Load", "Busy", "Critical Overload"]);
});

test("wording: over capacity ×7.6 instead of 756%, bar capped, amber > 85, red > 100", () => {
  assert.equal(loadLabel(76), "76%");
  assert.equal(loadLabel(100), "100%");
  assert.equal(loadLabel(756), "Over capacity ×7.6");
  assert.equal(barPct(756), 100);
  assert.deepEqual([85, 86, 100, 101].map(loadTone), ["ok", "amber", "amber", "red"]);
});

test("HP tier, lighter-load chip, due this week", () => {
  assert.deepEqual([10, 45, 90].map(hpTier), ["Low", "Tired", "Healthy"]);
  assert.equal(needsLighterLoad("High"), true); assert.equal(needsLighterLoad("Moderate"), false);
  assert.equal(dueThisWeek([{ deadline: d("05") }, { deadline: d("20") }, { deadline: null }], d("04")), 1);
});

test("reassign: status, eligibility, project team, duplicates", () => {
  const to = { _id: B, name: "Bo", role: "Designer", status: "active" };
  const task = { status: "In-Progress", type: "Feature", assignee: A, assignees: [A] };
  const r = reassignBlockers({ task, to, fromId: A, eligibleTypes: ["Design", "Documentation"], projectMemberIds: [A] });
  assert.match(r.join(" "), /Designers do not take "Feature"/);
  assert.match(r.join(" "), /not on this task's project/);
  assert.deepEqual(reassignBlockers({ task, to: { ...to, role: "Developer" }, fromId: A, eligibleTypes: ["Feature"], projectMemberIds: [A, B] }), []);
  assert.match(reassignBlockers({ task: { ...task, status: "In-Review" }, to: { ...to, role: "Developer" }, fromId: A, eligibleTypes: ["Feature"] }).join(), /in review cannot be reassigned/);
  assert.match(reassignBlockers({ task: { ...task, status: "Done" }, to: { ...to, role: "Developer" }, fromId: A, eligibleTypes: ["Feature"] }).join(), /done cannot be reassigned/);
  assert.match(reassignBlockers({ task, to: { ...to, role: "Team Lead" }, fromId: A, eligibleTypes: [] }).join(), /not to leads/);
  assert.match(reassignBlockers({ task: { ...task, assignees: [A, B] }, to: { ...to, role: "Developer" }, fromId: A, eligibleTypes: ["Feature"] }).join(), /already works on/);
});

test("reassign writes only assignee + assignees, swapping from → to", () => {
  const u = reassignUpdate({ assignee: A, assignees: [A, C], title: "x", status: "To-Do" }, A, B);
  assert.deepEqual(u, { $set: { assignee: B, assignees: [B, C] } });
  assert.deepEqual(Object.keys(u), ["$set"]);
  assert.deepEqual(Object.keys(u.$set).sort(), ["assignee", "assignees"]);
  assert.deepEqual(reassignUpdate({ assignee: C, assignees: [C] }, A, B).$set, { assignee: C, assignees: [C, B] });
  assert.equal(reassignUpdate({}, "x", B), null);
});

test("preview, reason and ranking from engine numbers", () => {
  assert.equal(previewLoad({ allocatedHours: 3.5, dailyCapacityHours: 7 }, 1.4), 70);
  assert.equal(previewLoad({ allocatedHours: 1, dailyCapacityHours: 7 }, -2), 0);
  assert.equal(candidateReason({ workloadTier: "Free", sameRole: true, availableHours: 2.4 }), "Free, same role, 12 h free this week");
  assert.equal(candidateReason({ workloadTier: "Busy", sameRole: false, availableHours: 0 }), "Busy, 0 h free this week");
  const ranked = rankCandidates([
    { name: "C", role: "Developer", availableHours: 2, utilisation: 70 },
    { name: "A", role: "Senior Developer", availableHours: 5, utilisation: 30 },
    { name: "B", role: "Developer", availableHours: 5, utilisation: 30 },
  ], "Developer");
  assert.deepEqual(ranked.map((x) => x.name), ["B", "A", "C"]);
});

test("asset form: name, type, link rules, projects, partial edit", () => {
  const bad = validateAssetInput({ name: "x", type: "Car", url: "ftp://a", projectIds: ["nope"], expiresAt: "soon" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["expiresAt", "name", "projectIds", "type", "url"]);
  assert.ok(validateAssetInput({ name: "Design files", type: "File link", url: "" }).errors.url);
  const ok = validateAssetInput({ name: " Figma ", type: "License", url: "https://figma.com", notes: "5 seats", expiresAt: "2026-12-01", projectIds: [A, A] });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.value.name, "Figma"); assert.deepEqual(ok.value.projectIds, [A]);
  assert.deepEqual(Object.keys(validateAssetInput({ notes: "n" }, { partial: true }).value), ["notes"]);
  const minimal = validateAssetInput({ name: "Jira", type: "Tool" });
  assert.deepEqual(minimal.errors, {}); assert.equal(minimal.value.expiresAt, null);
});

test("expiry state", () => {
  assert.equal(expiryState(null), null);
  assert.equal(expiryState(d("01"), d("04")).state, "expired");
  assert.equal(expiryState(d("20"), d("04")).state, "soon");
  assert.equal(expiryState(new Date("2027-03-01"), d("04")).state, "ok");
});
