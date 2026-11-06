// E-4 Tester Quality (Employee UX §5, D-187..D-192): QA queue and sign-off, bugs and the bug board, the Team Lead's check,
// test cases, the Tester's Today numbers. Rules in services/qualityRules.js. Never an AI score (D-075).
import mongoose from "mongoose";
import Task from "../models/Task.js";
import Project from "../models/Project.js";
import User from "../models/User.js";
import Bug from "../models/Bug.js";
import TestCase from "../models/TestCase.js";
import AuditLog from "../models/AuditLog.js";
import { orgScope } from "./managerProjectsController.js";
import { createNotification } from "./notificationController.js";
import { sendBack } from "./teamLeadReviewController.js";
import { awardXp } from "../services/gamificationService.js";
import { canTakeSignoff } from "../services/reviewRules.js";
import { taskPeople } from "../services/taskPeople.js";
import { storedFile } from "../middleware/upload.js";
import {
  validateBug, bugMove, bugValidity, bugXp, bugAccess, validateSignoffInput, alreadySigned, validateTestCase, validateRun,
  qaTab, weekRuns, BUG_STATUSES, SEVERITIES, capSlotKeys,
} from "../services/qualityRules.js";

const valid = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));
const OID = (x) => new mongoose.Types.ObjectId(String(x));
const NF = (res, what = "Not found.") => res.status(404).json({ error: what });
const people = (t) => [...new Set([...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].map(String))]; // one entry per person
const isTester = (u) => u.roleCategory === "tester";
const kindOf = (u) => (u.role === "Team Lead" ? "lead" : u.role === "Manager" ? "manager" : u.role === "Director" ? "director" : u.roleCategory);
const notify = (ids, orgId, type, title, message, meta) => Promise.all([...new Set(ids.map(String))].map((userId) => createNotification({ userId, orgId, type, title, message, meta }).catch(() => {})));
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// Projects this person may see bugs and test cases of (Q3): members (and their Team Lead); a Manager the ones they manage; a Director all.
async function visibleProjects(req) {
  const scope = await orgScope(req.user.orgId);
  if (!scope) return { scope: null, projects: [] };
  const filter = { ...scope.filter, isDeleted: { $ne: true }, status: { $ne: "Deleted" } };
  if (req.user.role === "Manager") filter.managerId = req.user.id;
  else if (req.user.role !== "Director") filter.members = req.user.id;
  return { scope, projects: await Project.find(filter, "title members managerId").lean() };
}
async function projectFor(req, projectId) {
  if (!valid(projectId)) return null;
  const scope = await orgScope(req.user.orgId);
  return scope ? Project.findOne({ _id: projectId, ...scope.filter }, "title members managerId").lean() : null;
}
const leadsOfProject = async (project) => (await User.find({ _id: { $in: project?.members ?? [] }, role: "Team Lead" }, "_id").lean()).map((u) => String(u._id));

// ── QA queue: GET /api/quality/qa?tab=waiting|signed|failed&project= (Testers) ───────────────────────────────────
export async function qaQueue(req, res) {
  const { projects } = await visibleProjects(req);
  const pick = req.query.project && projects.find((p) => String(p._id) === String(req.query.project));
  const pids = (pick ? [pick] : projects).map((p) => p._id);
  const tasks = await Task.find({ orgId: req.user.orgId, projectId: { $in: pids }, qaRequired: true, status: { $in: ["In-Review", "In-Progress", "Done"] } },
    "title projectId priority status submittedAt qaSignoffs qaRequired assignees assignee").populate("assignees", "name").populate("assignee", "name").sort({ submittedAt: 1 }).limit(300).lean();
  const title = new Map(projects.map((p) => [String(p._id), p.title]));
  const rows = tasks.map((t) => {
    const tab = qaTab(t);
    if (!tab) return null;
    const last = (t.qaSignoffs ?? []).at(-1);
    const builders = [...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].filter((p, i, a) => p && a.findIndex((x) => String(x._id) === String(p._id)) === i);
    return { id: String(t._id), title: t.title, project: title.get(String(t.projectId)) ?? null, projectId: String(t.projectId), priority: t.priority, status: t.status, tab,
      builtBy: builders.map((p) => p.name).join(", "), readySince: t.submittedAt, yours: builders.some((p) => String(p._id) === String(req.user.id)), signedAt: tab !== "waiting" ? last?.at ?? null : null };
  }).filter(Boolean);
  const tab = ["waiting", "signed", "failed"].includes(req.query.tab) ? req.query.tab : "waiting";
  const count = (k) => rows.filter((r) => r.tab === k).length;
  res.json({ rows: rows.filter((r) => r.tab === tab), counts: { waiting: count("waiting"), signed: count("signed"), failed: count("failed") }, projects: projects.map((p) => ({ id: String(p._id), title: p.title })) });
}

// Task a Tester may open on the QA page: a QA task on one of their projects, else 404.
async function qaTask(req, res, fields = "") {
  if (!valid(req.params.id)) { NF(res, "Task not found."); return null; }
  const t = await Task.findOne({ _id: req.params.id, orgId: req.user.orgId, qaRequired: true }, fields || undefined).lean();
  const p = t?.projectId ? await Project.findOne({ _id: t.projectId, members: req.user.id }, "title members").lean() : null;
  if (!t || !p) { NF(res, "Task not found."); return null; }
  return { t, p };
}

// ── QA page: GET /api/quality/qa/:id ───────────────────────────────────────────────────────────────────────────
export async function qaPage(req, res) {
  const got = await qaTask(req, res, "title description acceptanceCriteria benchmark projectId status submittedAt submissionNote submissionLinks submissionFiles qaSignoffs assignees assignee resubmissionCount qaRequired"); if (!got) return;
  const { t, p } = got;
  const [names, cases, bugs] = await Promise.all([
    User.find({ _id: { $in: [...people(t), ...(t.qaSignoffs ?? []).map((s) => s.by)] } }, "name").lean().then((u) => new Map(u.map((x) => [String(x._id), x.name]))),
    TestCase.find({ taskId: t._id }, "title priority lastResult").sort({ createdAt: 1 }).lean(),
    Bug.find({ taskId: t._id }, "title severity status validity").sort({ createdAt: -1 }).lean(),
  ]);
  const lastFail = qaTab(t) === "failed" && t.status === "In-Progress";
  const block = lastFail ? { error: "QA failed: the task went back to the assignee. Sign it off again when it is submitted again." }
    : canTakeSignoff(t, req.user.id) ?? (alreadySigned(t) ? { error: "This submission is already signed off. It can be signed again after the next submission." } : null);
  res.json({
    id: String(t._id), title: t.title, description: t.description ?? "", acceptanceCriteria: t.acceptanceCriteria ?? [], benchmark: t.benchmark ?? "", status: t.status,
    project: { id: String(p._id), title: p.title }, builtBy: people(t).map((id) => names.get(id) ?? "Someone"), submittedAt: t.submittedAt, attempt: (t.resubmissionCount ?? 0) + 1,
    submission: { note: t.submissionNote ?? "", links: (t.submissionLinks ?? []).map((l) => ({ label: l.label, url: l.url })), files: (t.submissionFiles ?? []).map((f) => ({ name: f.filename, url: f.url })) },
    signoffs: (t.qaSignoffs ?? []).map((s) => ({ by: names.get(String(s.by)) ?? "A Tester", at: s.at, result: s.result, withNotes: !!s.withNotes, note: s.note ?? "", files: s.files ?? [] })).reverse(),
    testCases: cases.map((c) => ({ id: String(c._id), title: c.title, priority: c.priority, lastResult: c.lastResult })),
    bugs: bugs.map((b) => ({ id: String(b._id), title: b.title, severity: b.severity, status: b.status, validity: b.validity })),
    canSign: !block, why: block?.error ?? null,
  });
}

// ── POST /api/quality/qa/:id/signoff (multipart: result, note, files) — also serves POST /api/tasks/:id/qa-signoff ─
// Once per submission (atomic). Pass with notes is a pass with withNotes. A fail sends the task back through the Team Lead's
// own revision path (sendBack: attempt +1, the rejection rule, the limit request), D-189.
export async function signOff(req, res) {
  if (!isTester(req.user)) return res.status(403).json({ error: "Only Testers sign off QA." });
  const got = await qaTask(req, res, "title projectId milestoneId orgId status submittedAt qaSignoffs qaRequired assignees assignee resubmissionCount maxResubmissions"); if (!got) return;
  const { t } = got;
  const blocked = canTakeSignoff(t, req.user.id);
  if (blocked) return res.status(blocked.status).json({ error: blocked.error, code: blocked.code });
  if (alreadySigned(t)) return res.status(409).json({ error: "This submission is already signed off.", code: "already_signed" });
  const v = validateSignoffInput(req.body ?? {});
  if (v.error) return res.status(v.status).json({ error: v.error, field: v.field });
  const files = (req.files ?? []).map(storedFile);
  const at = new Date(), since = t.submittedAt ?? new Date(0);
  const saved = await Task.updateOne({ _id: t._id, status: "In-Review", qaSignoffs: { $not: { $elemMatch: { at: { $gte: since } } } } },
    { $push: { qaSignoffs: { by: req.user.id, at, ...v.value, files } } });
  if (!saved.modifiedCount) return res.status(409).json({ error: "This submission is already signed off.", code: "already_signed" });
  const label = v.value.result === "fail" ? "failed" : v.value.withNotes ? "passed with notes" : "passed";
  Task.logActivity(t._id, req.user.id, "reviewed", { note: `QA ${label}${v.value.note ? `: ${v.value.note}` : ""}` });
  AuditLog.create({ action: "task_qa_signoff", orgId: valid(t.orgId) ? t.orgId : null, performedBy: req.user.id, targetProjectId: t.projectId, detail: `QA ${label} on "${t.title}".`,
    after: { taskId: String(t._id), result: v.value.result, withNotes: v.value.withNotes, note: v.value.note, files: files.length } }).catch((e) => console.error("[qa audit]", e.message));
  let sentBack = false;
  // E-4b (D-194): back to the assignee without the Team Lead's penalty or a used try.
  if (v.value.result === "fail") sentBack = !!(await sendBack(t, { id: req.user.id, name: req.user.name }, { reason: `QA failed: ${v.value.note}`, unmet: [] }, null, "qa"));
  const { leads } = await taskPeople(t);
  const who = req.user.name ?? "A Tester";
  await notify(leads, req.user.orgId, "qa_signoff_done", `QA ${label}`, `${who} ${label} "${t.title}".${v.value.note ? ` ${v.value.note.slice(0, 200)}` : ""}${sentBack ? " It went back to the assignee." : ""}`, { taskId: t._id, projectId: t.projectId });
  await notify(people(t), req.user.orgId, "qa_signoff_done", v.value.result === "fail" ? "QA failed: your task came back" : `QA ${label}`,
    `${who} ${label} "${t.title}".${v.value.note ? ` ${v.value.note.slice(0, 200)}` : ""}`, { taskId: t._id, projectId: t.projectId });
  res.status(201).json({ ok: true, result: v.value.result, withNotes: v.value.withNotes, at, sentBack });
}

// ── Bugs ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function bugRow(b, names, titles, taskTitles) {
  return { id: String(b._id), title: b.title, severity: b.severity, status: b.status, validity: b.validity, project: titles.get(String(b.projectId)) ?? null, projectId: String(b.projectId),
    taskId: b.taskId ? String(b.taskId) : null, task: b.taskId ? taskTitles.get(String(b.taskId)) ?? null : null, reporter: names.get(String(b.createdBy)) ?? "A Tester", createdAt: b.createdAt, updatedAt: b.updatedAt };
}
async function lookups(bugs) {
  const [users, tasks] = await Promise.all([
    User.find({ _id: { $in: [...new Set(bugs.flatMap((b) => [b.createdBy, b.fixedBy, ...(b.history ?? []).map((h) => h.by)].filter(Boolean).map(String)))] } }, "name").lean(),
    Task.find({ _id: { $in: bugs.map((b) => b.taskId).filter(Boolean) } }, "title assignees assignee").lean(),
  ]);
  return { names: new Map(users.map((u) => [String(u._id), u.name])), taskTitles: new Map(tasks.map((t) => [String(t._id), t.title])), tasks: new Map(tasks.map((t) => [String(t._id), t])) };
}

// GET /api/quality/bugs?project=&status=&severity=&task=&mine=1
export async function listBugs(req, res) {
  const { projects } = await visibleProjects(req);
  const titles = new Map(projects.map((p) => [String(p._id), p.title]));
  const q = { orgId: req.user.orgId, projectId: { $in: projects.map((p) => p._id) } };
  if (req.query.project) { if (!titles.has(String(req.query.project))) return res.json({ rows: [], counts: {}, projects: [] }); q.projectId = OID(req.query.project); }
  if (req.query.task) { if (!valid(req.query.task)) return res.json({ rows: [], counts: {}, projects: [] }); q.taskId = OID(req.query.task); }
  if (SEVERITIES.includes(req.query.severity)) q.severity = req.query.severity;
  if (req.query.mine === "1") q.createdBy = req.user.id;
  const all = await Bug.find(q, "title severity status validity projectId taskId createdBy createdAt updatedAt").sort({ createdAt: -1 }).limit(500).lean();
  const { names, taskTitles } = await lookups(all);
  const rows = all.filter((b) => !BUG_STATUSES.includes(req.query.status) || b.status === req.query.status).map((b) => bugRow(b, names, titles, taskTitles));
  res.json({ rows, counts: Object.fromEntries(BUG_STATUSES.map((s) => [s, all.filter((b) => b.status === s).length])), projects: projects.map((p) => ({ id: String(p._id), title: p.title })),
    canReport: isTester(req.user) });
}

// The bug and what this person may do with it; 404 outside Q3 visibility.
async function bugFor(req, res) {
  if (!valid(req.params.id)) { NF(res, "Bug not found."); return null; }
  const b = await Bug.findOne({ _id: req.params.id, orgId: req.user.orgId }).lean();
  const project = b ? await projectFor(req, b.projectId) : null;
  const access = b ? bugAccess(req.user, project) : null;
  if (!access) { NF(res, "Bug not found."); return null; }
  const task = b.taskId ? await Task.findById(b.taskId, "title assignees assignee milestoneId projectId").lean() : null;
  const actor = { id: String(req.user.id), kind: kindOf(req.user), onTask: !!task && people(task).includes(String(req.user.id)), isLead: req.user.role === "Team Lead" && access === "write" };
  return { b, project, access, task, actor };
}

// GET /api/quality/bugs/:id
export async function getBug(req, res) {
  const got = await bugFor(req, res); if (!got) return;
  const { b, project, access, actor } = got;
  const { names, taskTitles } = await lookups([b]);
  const moves = access === "write" ? BUG_STATUSES.filter((to) => bugMove({ bug: b, to, actor, note: "xxx" }).ok) : [];
  res.json({ ...bugRow(b, names, new Map([[String(project._id), project.title]]), taskTitles), steps: b.steps, expected: b.expected, actual: b.actual, environment: b.environment,
    duplicateOf: b.duplicateOf ? String(b.duplicateOf) : null, files: b.files ?? [], fixedBy: b.fixedBy ? names.get(String(b.fixedBy)) ?? null : null,
    history: (b.history ?? []).map((h) => ({ at: h.at, by: names.get(String(h.by)) ?? "Someone", action: h.action, from: h.from, to: h.to, note: h.note })),
    access, moves, canCheck: access === "write" && bugValidity({ bug: b, validity: "valid", actor }).ok === true });
}

// POST /api/quality/bugs (multipart) — Testers on the project.
export async function reportBug(req, res) {
  if (!isTester(req.user)) return res.status(403).json({ error: "Only Testers report bugs here." });
  const project = await projectFor(req, req.body?.projectId);
  if (!project || bugAccess(req.user, project) !== "write") return res.status(400).json({ error: "Pick one of your projects.", field: "projectId" });
  let task = null;
  if (req.body?.taskId) {
    task = valid(req.body.taskId) ? await Task.findOne({ _id: req.body.taskId, orgId: req.user.orgId, projectId: project._id }, "title assignees assignee milestoneId projectId").lean() : null;
    if (!task) return res.status(400).json({ error: "Pick a task of this project, or no task.", field: "taskId" });
  }
  const v = validateBug(req.body ?? {});
  if (v.errors) return res.status(400).json({ error: Object.values(v.errors)[0], field: Object.keys(v.errors)[0], fields: v.errors });
  const bug = await Bug.create({ ...v.value, orgId: req.user.orgId, projectId: project._id, taskId: task?._id ?? null, createdBy: req.user.id, files: (req.files ?? []).map(storedFile),
    history: [{ by: req.user.id, action: "reported", to: "Open" }] });
  const leads = task ? (await taskPeople(task)).leads : await leadsOfProject(project);
  const meta = { bugId: bug._id, taskId: task?._id ?? null, projectId: project._id };
  await notify(leads, req.user.orgId, "bug_reported", "New bug to check", `${req.user.name ?? "A Tester"} reported "${bug.title}" (${bug.severity}). Mark it valid or invalid.`, meta);
  if (task) await notify(people(task).filter((id) => id !== String(req.user.id)), req.user.orgId, "bug_reported", "Bug reported on your task", `"${bug.title}" (${bug.severity}) on "${task.title}". Your Team Lead checks it first.`, meta);
  res.status(201).json({ id: String(bug._id) });
}

// POST /api/quality/bugs/:id/move { to, note }
export async function moveBug(req, res) {
  const got = await bugFor(req, res); if (!got) return;
  const { b, task, actor, access } = got;
  if (access !== "write") return res.status(403).json({ error: actor.kind === "manager" ? "Managers can see bugs but not change them. The Team Lead does that." : "You can see this bug but not change it." });
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  const m = bugMove({ bug: b, to: req.body?.to, actor, note });
  if (!m.ok) return res.status(m.status).json({ error: m.error, field: m.field });
  const action = m.status === "Fixed" ? "fixed" : m.status === "Verified" ? "verified" : m.status === "Closed" ? "closed" : "reopened";
  const moved = await Bug.updateOne({ _id: b._id, status: b.status }, { $set: { status: m.status, ...(m.status === "Fixed" ? { fixedBy: req.user.id } : {}) }, $push: { history: { by: req.user.id, action, from: b.status, to: m.status, note } } });
  if (!moved.modifiedCount) return res.status(409).json({ error: "Someone moved this bug just now. Reload it." });
  const meta = { bugId: b._id, taskId: b.taskId, projectId: b.projectId }, who = req.user.name ?? "Someone";
  const leads = task ? (await taskPeople(task)).leads : await leadsOfProject(got.project);
  if (action === "fixed") await notify([b.createdBy], req.user.orgId, "bug_fixed", "Bug fixed: please verify", `${who} fixed "${b.title}": ${note.slice(0, 200)}`, meta);
  if (action === "verified") await notify([...(task ? people(task) : []), ...(b.fixedBy ? [b.fixedBy] : []), ...leads], req.user.orgId, "bug_verified", "Bug fix verified", `${who} verified the fix of "${b.title}".`, meta);
  if (action === "reopened") await notify([...(task ? people(task) : []), ...(b.fixedBy ? [b.fixedBy] : [])], req.user.orgId, "bug_reopened", "Bug reopened", `${who} reopened "${b.title}": ${note.slice(0, 200)}`, meta);
  if (action === "closed") await notify([b.createdBy], req.user.orgId, "bug_closed", "Bug closed", `${who} closed "${b.title}".`, meta);
  res.json({ ok: true, status: m.status });
}

// POST /api/quality/bugs/:id/check { validity: valid|invalid|duplicate, note, duplicateOf } — the project's Team Lead, once.
// Valid → the reporter's +15 XP through the existing awardXp (Q2): once per bug (atomic xpAwardedAt), 5 rewarded bugs a day.
export async function checkBug(req, res) {
  const got = await bugFor(req, res); if (!got) return;
  const { b, task, actor } = got;
  if (actor.kind === "manager" || actor.kind === "director") return res.status(403).json({ error: "The Team Lead of the project checks bugs." });
  let duplicateOf = null;
  if (req.body?.validity === "duplicate" && req.body?.duplicateOf) {
    duplicateOf = valid(req.body.duplicateOf) && String(req.body.duplicateOf) !== String(b._id) ? await Bug.findOne({ _id: req.body.duplicateOf, projectId: b.projectId }, "_id").lean() : null;
    if (!duplicateOf) return res.status(400).json({ error: "Pick another bug of this project.", field: "duplicateOf" });
  }
  const v = bugValidity({ bug: b, validity: req.body?.validity, actor, note: req.body?.note, duplicateOf: duplicateOf?._id });
  if (!v.ok) return res.status(v.status).json({ error: v.error, field: v.field });
  const saved = await Bug.updateOne({ _id: b._id, status: "Open", validity: "pending" }, { $set: { validity: v.validity, ...(duplicateOf ? { duplicateOf: duplicateOf._id } : {}) },
    $push: { history: { by: req.user.id, action: v.validity, note: v.note } } });
  if (!saved.modifiedCount) return res.status(409).json({ error: "This bug was already checked." });
  let xp = { xp: 0, reason: "not_valid" };
  if (v.validity === "valid") {
    xp = bugXp({ validity: "valid", awarded: !!b.xpAwardedAt, countToday: 0 }); // the cap is decided by the slot claim below
    if (xp.xp) {
      // E-4b (D-196): race-free cap. A reward takes a unique slot "reporter:day:n" (n = 1..5) together with xpAwardedAt, in one
      // conditional update; a taken slot fails on the unique index and the next one is tried. Rewards of today from before
      // E-4b have no slot, so they use up the first places.
      const now = new Date();
      const legacy = await Bug.countDocuments({ createdBy: b.createdBy, xpAwardedAt: { $gte: startOfDay(now) }, xpSlot: { $exists: false } });
      let claimed = false;
      for (const slot of capSlotKeys(String(b.createdBy), now, legacy)) {
        try {
          const r = await Bug.updateOne({ _id: b._id, xpAwardedAt: null }, { $set: { xpAwardedAt: now, xpSlot: slot } });
          if (!r.modifiedCount) break; // this bug was rewarded already (another check at the same moment)
          claimed = true; break;
        } catch (e) { if (e?.code !== 11000) throw e; } // slot taken: try the next one
      }
      if (claimed) await awardXp(String(b.createdBy), req.user.orgId, xp.xp, "manual").catch((e) => { console.error("[bug xp]", e.message); xp = { xp: 0, reason: "error" }; });
      else xp = { xp: 0, reason: (await Bug.exists({ _id: b._id, xpAwardedAt: { $ne: null } })) ? "already_awarded" : "daily_cap" };
    }
  }
  const meta = { bugId: b._id, taskId: b.taskId, projectId: b.projectId }, word = { valid: "accepted", invalid: "not accepted", duplicate: "marked as a duplicate" }[v.validity];
  await notify([b.createdBy], req.user.orgId, `bug_${v.validity}`, `Bug ${word}`, `"${b.title}" was ${word}.${xp.xp ? ` +${xp.xp} XP.` : xp.reason === "daily_cap" ? " No XP: 5 bugs were already rewarded today." : ""}${v.note ? ` ${v.note.slice(0, 200)}` : ""}`, meta);
  if (v.validity === "valid" && task) await notify(people(task), req.user.orgId, "bug_assigned", "Bug to fix on your task", `"${b.title}" (${b.severity}) on "${task.title}". Mark it fixed with a note when done.`, meta);
  res.json({ ok: true, validity: v.validity, xp: xp.xp, xpReason: xp.reason });
}

// ── Test cases (Testers write; people on the project read) ──────────────────────────────────────────────────────
const caseView = (c, names, taskTitles) => ({ id: String(c._id), title: c.title, steps: c.steps, expected: c.expected, priority: c.priority, projectId: String(c.projectId),
  taskId: c.taskId ? String(c.taskId) : null, task: c.taskId ? taskTitles.get(String(c.taskId)) ?? null : null, lastResult: c.lastResult,
  runs: (c.runs ?? []).slice(-20).reverse().map((r) => ({ at: r.at, by: names.get(String(r.by)) ?? "Someone", result: r.result, note: r.note })), updatedAt: c.updatedAt });
async function caseLookups(cases) {
  const [users, tasks] = await Promise.all([User.find({ _id: { $in: [...new Set(cases.flatMap((c) => (c.runs ?? []).map((r) => String(r.by))))] } }, "name").lean(), Task.find({ _id: { $in: cases.map((c) => c.taskId).filter(Boolean) } }, "title").lean()]);
  return { names: new Map(users.map((u) => [String(u._id), u.name])), taskTitles: new Map(tasks.map((t) => [String(t._id), t.title])) };
}

// GET /api/quality/test-cases?project=&task=
export async function listCases(req, res) {
  const { projects } = await visibleProjects(req);
  const ids = new Set(projects.map((p) => String(p._id)));
  const q = { orgId: req.user.orgId, projectId: { $in: [...ids].map(OID) } };
  if (req.query.project) { if (!ids.has(String(req.query.project))) return res.json({ rows: [], projects: [] }); q.projectId = OID(req.query.project); }
  if (req.query.task && valid(req.query.task)) q.taskId = OID(req.query.task);
  const cases = await TestCase.find(q).sort({ updatedAt: -1 }).limit(300).lean();
  const { names, taskTitles } = await caseLookups(cases);
  res.json({ rows: cases.map((c) => caseView(c, names, taskTitles)), projects: projects.map((p) => ({ id: String(p._id), title: p.title })), canWrite: isTester(req.user) });
}

async function caseInput(req, res, projectId) {
  const project = await projectFor(req, projectId);
  if (!project || bugAccess(req.user, project) !== "write") { res.status(400).json({ error: "Pick one of your projects.", field: "projectId" }); return null; }
  let taskId = null;
  if (req.body?.taskId) {
    const t = valid(req.body.taskId) ? await Task.findOne({ _id: req.body.taskId, orgId: req.user.orgId, projectId: project._id }, "_id").lean() : null;
    if (!t) { res.status(400).json({ error: "Pick a task of this project, or no task.", field: "taskId" }); return null; }
    taskId = t._id;
  }
  const v = validateTestCase(req.body ?? {});
  if (v.errors) { res.status(400).json({ error: Object.values(v.errors)[0], field: Object.keys(v.errors)[0], fields: v.errors }); return null; }
  return { project, taskId, value: v.value };
}

// POST /api/quality/test-cases
export async function createCase(req, res) {
  if (!isTester(req.user)) return res.status(403).json({ error: "Only Testers write test cases." });
  const x = await caseInput(req, res, req.body?.projectId); if (!x) return;
  const c = await TestCase.create({ ...x.value, orgId: req.user.orgId, projectId: x.project._id, taskId: x.taskId, createdBy: req.user.id });
  res.status(201).json({ id: String(c._id) });
}

async function caseFor(req, res) {
  if (!valid(req.params.id)) { NF(res, "Test case not found."); return null; }
  const c = await TestCase.findOne({ _id: req.params.id, orgId: req.user.orgId }).lean();
  const project = c ? await projectFor(req, c.projectId) : null;
  if (!c || !bugAccess(req.user, project)) { NF(res, "Test case not found."); return null; }
  if (!isTester(req.user) || bugAccess(req.user, project) !== "write") { res.status(403).json({ error: "Only Testers on the project change test cases." }); return null; }
  return c;
}

// PATCH /api/quality/test-cases/:id  (same fields; the project stays)
export async function updateCase(req, res) {
  const c = await caseFor(req, res); if (!c) return;
  const x = await caseInput(req, res, c.projectId); if (!x) return;
  await TestCase.updateOne({ _id: c._id }, { $set: { ...x.value, taskId: x.taskId, updatedBy: req.user.id } });
  res.json({ ok: true });
}

// POST /api/quality/test-cases/:id/runs { result: Pass|Fail|Blocked, note }
export async function runCase(req, res) {
  const c = await caseFor(req, res); if (!c) return;
  const v = validateRun(req.body ?? {});
  if (v.error) return res.status(v.status).json({ error: v.error, field: v.field });
  await TestCase.updateOne({ _id: c._id }, { $set: { lastResult: v.value.result }, $push: { runs: { $each: [{ by: req.user.id, ...v.value }], $slice: -200 } } });
  res.status(201).json({ ok: true, result: v.value.result });
}

// ── GET /api/quality/today (Testers): the Tester version of Today's numbers ────────────────────────────────────────
export async function testerToday(req, res) {
  const { projects } = await visibleProjects(req);
  const pids = projects.map((p) => p._id);
  const [tasks, myOpen, toVerify, cases] = await Promise.all([
    Task.find({ orgId: req.user.orgId, projectId: { $in: pids }, qaRequired: true, status: "In-Review" }, "status submittedAt qaSignoffs qaRequired").lean(),
    Bug.countDocuments({ orgId: req.user.orgId, createdBy: req.user.id, status: { $ne: "Closed" } }),
    Bug.countDocuments({ orgId: req.user.orgId, projectId: { $in: pids }, status: "Fixed", fixedBy: { $ne: OID(req.user.id) } }),
    TestCase.find({ orgId: req.user.orgId, projectId: { $in: pids }, "runs.by": OID(req.user.id) }, "runs").lean(),
  ]);
  res.json({ qaWaiting: tasks.filter((t) => qaTab(t) === "waiting").length, myOpenBugs: myOpen, fixedToVerify: toVerify,
    week: weekRuns(cases.flatMap((c) => (c.runs ?? []).filter((r) => String(r.by) === String(req.user.id))), new Date()) });
}


// GET /api/quality/projects/:id/tasks — tasks to link a bug or a test case to (people on the project).
export async function projectTasks(req, res) {
  const project = await projectFor(req, req.params.id);
  if (!project || bugAccess(req.user, project) !== "write") return NF(res, "Project not found.");
  const tasks = await Task.find({ orgId: req.user.orgId, projectId: project._id }, "title status").sort({ createdAt: -1 }).limit(300).lean();
  res.json({ rows: tasks.map((t) => ({ id: String(t._id), title: t.title, status: t.status })) });
}
