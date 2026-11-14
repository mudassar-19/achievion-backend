// Team Lead T-2 (V2 Phase 4, UX TL v4 §3.2 / §5 / §6 / §6.1, D-118, D-119, D-122..D-125): task create (single or
// group) / edit / duplicate / extend / files / full detail / bulk / saved filters, module deadline request, QA-ready,
// history. Every route sits behind the T-1 TL scope (own projects / own tasks / own team). Done stays review-only.
// Task creation reuses taskController.createTask per person (department rule, workload warnings, notifications).
import crypto from "crypto";
import mongoose from "mongoose";
import Task from "../models/Task.js";
import User from "../models/User.js";
import Milestone from "../models/Milestone.js";
import AuditLog from "../models/AuditLog.js";
import OperationalRequest from "../models/OperationalRequest.js";
import { createTask, resolveLinks, commentMembers } from "./taskController.js";
import { REACTIONS } from "../services/commentRules.js";
import { getTaskDetail as mgrTaskDetail } from "./managerProjectsController.js";
import { requestExtension } from "./extensionController.js";
import { createNotification } from "./notificationController.js";
import { tlScope, projectIn, taskIn, writableSprint } from "./teamLeadWorkController.js";
import Sprint from "../models/Sprint.js";
import { OPEN_STATUSES } from "../services/sprintRules.js";
import { limitRequestOf } from "../services/limitRequest.js";
import { limitState } from "../services/reviewRules.js";
import { aiEvalView } from "../services/aiEvalService.js";
import { ROLE_TASK_ELIGIBILITY, ROLE_TO_CATEGORY } from "../services/workloadService.js";
import { reassignBlockers } from "../services/resourceRules.js";
import { capture, passOn } from "../utils/capture.js";
import { fileStore } from "../middleware/upload.js";
import { validateTaskInput, groupTasks, canDeleteTask, isBlocked, validateSavedFilter, validateBulk, bulkSprintPlan, MAX_SAVED_FILTERS } from "../services/taskFormRules.js";

const valid = (id) => mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(String(id));
const OID = (x) => new mongoose.Types.ObjectId(String(x));
const fail = (res, errors) => res.status(400).json({ error: Object.values(errors)[0], fields: errors });
const QUALITY = ["acceptanceCriteria", "benchmark", "qaRequired"];

// ── POST /api/teamlead/tasks/create ──────────────────────────────────────────
// { projectId, milestoneId?, title, description, type, priority, difficulty, estimatedHours, startDate, deadline,
//   tags, xpValue, acceptanceCriteria, benchmark, qaRequired, parentId, dependsOn,
//   assign: { mode: "none" | "single" | "group", userId?, userIds? } }
export async function createTasks(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const body = req.body ?? {};
  const p = valid(body.projectId) ? projectIn(s, body.projectId) : null;
  if (!p) return res.status(404).json({ error: "Project not found in your projects." });
  const { errors, value } = validateTaskInput(body);
  const mode = ["single", "group"].includes(body.assign?.mode) ? body.assign.mode : "none";
  const people = mode === "single" ? [body.assign?.userId] : mode === "group" ? (Array.isArray(body.assign?.userIds) ? body.assign.userIds : []) : [];
  const members = new Set((p.members ?? []).map((m) => String(m._id ?? m)));
  if (mode === "single" && !people[0]) errors.assign = "Pick the person who does this task.";
  if (mode === "group" && people.length < 2) errors.assign = "Pick at least two people for a group task, or assign one person.";
  if (people.length > 25) errors.assign = "A group can have at most 25 people.";
  const bad = people.find((id) => !valid(id) || !s.team.has(String(id)) || !members.has(String(id)));
  if (bad !== undefined) errors.assign = "Everyone you assign must be on this project and in your team.";
  if (Object.keys(errors).length) return fail(res, errors);
  if (body.milestoneId && !(valid(body.milestoneId) && await Milestone.exists({ _id: body.milestoneId, projectId: p._id }))) return fail(res, { milestoneId: "That module is not in this project." });
  // T-5 (D-143): optional sprint of this project (open, and not another Team Lead's).
  let sprintForNew = null;
  if (body.sprintId) {
    const w = await writableSprint(req, res, body.sprintId); if (!w) return;
    if (String(w.sprint.projectId) !== String(p._id) || !OPEN_STATUSES.includes(w.sprint.status)) return fail(res, { sprintId: "Pick an open sprint of this project." });
    sprintForNew = w.sprint;
  }

  const groupTag = mode === "group" ? `grp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}` : null;
  const base = { title: value.title, description: value.description, type: value.type, priority: value.priority, difficulty: value.difficulty,
    estimatedHours: value.estimatedHours, deadline: value.deadline ?? null, tags: value.tags ?? [], xpValue: value.xpValue,
    projectId: String(p._id), milestoneId: body.milestoneId || null, parentId: body.parentId || null, dependsOn: body.dependsOn ?? [] };
  const bodies = mode === "none" ? [{ ...base }] : groupTasks(base, people, groupTag);

  const created = [], warnings = [];
  for (const b of bodies) {
    const r = await capture(createTask, req, { body: b });
    if (r.status >= 400) { // all or nothing: undo the tasks this request made
      if (created.length) await Task.deleteMany({ _id: { $in: created.map((t) => t._id) }, createdBy: req.user.id });
      return res.status(r.status).json({ error: r.body?.error ?? "The task could not be created.", ...(created.length ? { undone: created.length } : {}) });
    }
    const t = r.body.task ?? r.body;
    created.push(t);
    warnings.push(...(r.body.warnings ?? []));
  }
  const extra = { groupTag, startDate: value.startDate ?? null, ...Object.fromEntries(QUALITY.filter((k) => value[k] !== undefined).map((k) => [k, value[k]])) };
  await Task.updateMany({ _id: { $in: created.map((t) => t._id) } }, { $set: extra });
  if (sprintForNew) await Sprint.updateOne({ _id: sprintForNew._id }, { $addToSet: { tasks: { $each: created.map((t) => t._id) } } });
  res.status(201).json({ created: created.length, groupTag, warnings: [...new Set(warnings.map((w) => (typeof w === "string" ? w : w.message ?? String(w))))].slice(0, 10),
    tasks: created.map((t) => ({ id: t._id, title: t.title, assignee: t.assignee ?? null, status: t.status })) });
}

// ── PATCH /api/teamlead/tasks/:id/edit ──────────────────────────────────────
export async function editTask(req, res) {
  const task = await Task.findById(req.params.id, "status projectId deadline title").lean();
  if (task.status === "Done") return res.status(409).json({ error: "A done task cannot be edited." });
  const { errors, value } = validateTaskInput(req.body ?? {}, { mode: "edit" });
  if (Object.keys(errors).length) return fail(res, errors);
  if (req.body.dependsOn !== undefined || req.body.parentId !== undefined) {
    const { error, links } = await resolveLinks(req.user.orgId, { parentId: req.body.parentId, dependsOn: req.body.dependsOn }, req.params.id);
    if (error) return fail(res, { dependsOn: error });
    Object.assign(value, links);
  }
  if (value.deadline !== undefined) value.deadlineAlertSentAt = null; // 1.5: alert again for the new date
  // T-5 (D-143): Sprint field. "" or null = no sprint. Moves only between open sprints of the task's project.
  let sprintChanged = false;
  if (req.body.sprintId !== undefined) {
    let to = null;
    if (req.body.sprintId) {
      const w = await writableSprint(req, res, req.body.sprintId); if (!w) return;
      if (String(w.sprint.projectId) !== String(task.projectId) || !OPEN_STATUSES.includes(w.sprint.status)) return fail(res, { sprintId: "Pick an open sprint of this project." });
      to = w.sprint;
    }
    const from = await Sprint.findOne({ tasks: req.params.id, status: { $in: OPEN_STATUSES } }, "_id").lean();
    if (String(from?._id ?? "") !== String(to?._id ?? "")) {
      if (from) await Sprint.updateOne({ _id: from._id }, { $pull: { tasks: OID(req.params.id) } });
      if (to) await Sprint.updateOne({ _id: to._id }, { $addToSet: { tasks: OID(req.params.id) } });
      sprintChanged = true;
    }
  }
  if (!Object.keys(value).length) return res.json({ ok: true, changed: sprintChanged ? 1 : 0 });
  await Task.updateOne({ _id: req.params.id }, { $set: value });
  Task.logActivity(req.params.id, req.user.id, "edited", { note: Object.keys(value).filter((k) => k !== "deadlineAlertSentAt").join(", ").slice(0, 300) });
  res.json({ ok: true, changed: Object.keys(value).length });
}

// ── POST /api/teamlead/tasks/:id/duplicate → a new unassigned Backlog task ──
export async function duplicateTask(req, res) {
  const t = await Task.findById(req.params.id).lean();
  const copy = await Task.create({
    orgId: t.orgId, projectId: t.projectId, milestoneId: t.milestoneId, parentId: t.parentId, createdBy: req.user.id, assignerRole: "Team Lead",
    title: `${t.title} (copy)`.slice(0, 120), description: t.description, type: t.type, priority: t.priority, difficulty: t.difficulty,
    estimatedHours: t.estimatedHours, tags: t.tags, xpValue: t.xpValue, acceptanceCriteria: t.acceptanceCriteria, benchmark: t.benchmark, qaRequired: t.qaRequired,
    status: "Backlog", assignees: [], assignee: null,
  });
  res.status(201).json({ id: copy._id, title: copy.title });
}

// ── POST /api/teamlead/tasks/:id/extend { reason, days } (org extension rules, D-086 flow) ──
export async function extendTask(req, res) {
  const reason = String(req.body?.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) return fail(res, { reason: "Write a reason of 10 to 500 characters." });
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days < 1 || days > 60) return fail(res, { days: "Extend by 1 to 60 days." });
  passOn(res, await capture(requestExtension, req, { body: { taskId: req.params.id, reason, requestedDays: days } }));
}

// ── Files: POST /api/teamlead/tasks/:id/attachments (multipart "files"), DELETE …/attachments/:attId ──
export async function addAttachments(req, res) {
  const files = req.files ?? [];
  if (!files.length) return res.status(400).json({ error: "Pick a file (PDF, DOC, DOCX, CSV, PNG or JPG, up to 5 MB)." });
  const t = await Task.findById(req.params.id, "attachments").lean();
  if ((t.attachments?.length ?? 0) + files.length > 20) return res.status(400).json({ error: "A task can hold at most 20 files." });
  const add = files.map((f) => ({ name: f.originalname.slice(0, 120), url: f.stored.url, size: f.size, by: req.user.id, at: new Date() }));
  await Task.updateOne({ _id: req.params.id }, { $push: { attachments: { $each: add } } });
  Task.logActivity(req.params.id, req.user.id, "edited", { note: `added ${add.length} file${add.length === 1 ? "" : "s"}` });
  res.status(201).json({ added: add.length });
}
export async function removeAttachment(req, res) {
  if (!valid(req.params.attId)) return res.status(404).json({ error: "File not found." });
  const t = await Task.findById(req.params.id, "attachments").lean();
  const gone = (t?.attachments ?? []).find((a) => String(a._id) === String(req.params.attId));
  if (!gone) return res.status(404).json({ error: "File not found." }); // (modifiedCount is 1 even for a missing id: updatedAt changes)
  await Task.updateOne({ _id: req.params.id }, { $pull: { attachments: { _id: OID(req.params.attId) } } });
  if (gone?.url) fileStore.remove(gone.url); // the stored file goes too; a failure is logged and never blocks the user
  Task.logActivity(req.params.id, req.user.id, "edited", { note: "removed a file" });
  res.json({ ok: true });
}

// ── GET /api/teamlead/tasks/:id/full (drawer tabs) ──────────────────────────
export async function fullTask(req, res) {
  const base = await capture(mgrTaskDetail, req, { params: { id: req.params.id } });
  if (base.status !== 200) return passOn(res, base);
  const t = await Task.findById(req.params.id, "projectId milestoneId parentId dependsOn tags estimatedHours difficulty startDate xpValue acceptanceCriteria benchmark qaRequired groupTag attachments aiEval tlScore assignee assignees resubmissionCount maxResubmissions")
    .populate("attachments.by", "name").lean();
  const [subtasks, prereqs, blocks, parent, group] = await Promise.all([
    Task.find({ parentId: t._id }, "title status assignee").populate("assignee", "name").lean(),
    Task.find({ _id: { $in: t.dependsOn ?? [] } }, "title status").lean(),
    Task.find({ dependsOn: t._id }, "title status").lean(),
    t.parentId ? Task.findById(t.parentId, "title status").lean() : null,
    t.groupTag ? Task.countDocuments({ groupTag: t.groupTag }) : 0,
  ]);
  const statusOf = new Map(prereqs.map((p) => [String(p._id), p.status]));
  const view = (x) => ({ id: x._id, title: x.title, status: x.status });
  res.json({
    ...base.body,
    projectId: t.projectId, milestoneId: t.milestoneId, tags: t.tags ?? [], estimatedHours: t.estimatedHours, difficulty: t.difficulty, startDate: t.startDate, xpValue: t.xpValue,
    acceptanceCriteria: t.acceptanceCriteria ?? [], benchmark: t.benchmark ?? "", qaRequired: !!t.qaRequired, groupTag: t.groupTag, groupSize: group,
    attachments: (t.attachments ?? []).map((a) => ({ id: a._id, name: a.name, url: a.url, size: a.size, by: a.by?.name ?? null, at: a.at })),
    parent: parent ? view(parent) : null, subtasks: subtasks.map((x) => ({ ...view(x), assignee: x.assignee?.name ?? null })),
    dependsOn: prereqs.map(view), blocks: blocks.map(view), blocked: isBlocked(t, statusOf),
    aiReview: aiEvalView(t, t.tlScore != null), // D-075: AI score only once the TL has scored
    canDelete: canDeleteTask(base.body.status),
    ...(await commentsView(t, req.user.id)),
    sprint: await Sprint.findOne({ tasks: t._id, status: { $in: OPEN_STATUSES } }, "name").lean().then((x) => (x ? { id: x._id, name: x.name } : null)),
    // D-142: at the resubmission limit the TL sees who it waits for.
    limitState: (t.resubmissionCount ?? 0) >= (t.maxResubmissions ?? 3) && base.body.status === "In-Progress" ? limitState(await limitRequestOf(t._id)) : null,
  });
}

// T-4 (D-139): comments with reactions, plus who can be mentioned.
export async function commentsView(t, me) {
  const [doc, members] = await Promise.all([Task.findById(t._id, "comments").populate("comments.author", "name").lean(), commentMembers(t)]);
  return { members, reactionSet: REACTIONS, comments: (doc?.comments ?? []).map((c) => ({ id: c._id, author: c.author?.name ?? "—", mine: String(c.author?._id) === String(me), text: c.text, at: c.createdAt, editedAt: c.editedAt ?? null,
    reactions: REACTIONS.map((emoji) => { const r = (c.reactions ?? []).filter((x) => x.emoji === emoji); return { emoji, count: r.length, mine: r.some((x) => String(x.user) === String(me)) }; }).filter((x) => x.count) })) };
}

// ── POST /api/teamlead/tasks/bulk { ids, action: assign | priority | tag | deadline, value } ──
// "Add to sprint" waits for T-5 (TL sprint writes, D-121).
export async function bulkTasks(req, res) {
  const v = validateBulk(req.body ?? {});
  if (v.error) return res.status(400).json({ error: v.error });
  const s = await tlScope(req, res); if (!s) return;
  const tasks = await Task.find({ _id: { $in: v.ids.map(OID) }, ...s.scope.filter, projectId: { $in: [...s.ids].map(OID) } }, "title status type tags assignee assignees projectId milestoneId").lean();
  if (tasks.length !== v.ids.length) return res.status(404).json({ error: "Some of these tasks are not in your projects." });
  const skipped = [], done = [];
  const { action, value } = req.body;
  if (action === "priority" || action === "deadline") {
    await Task.updateMany({ _id: { $in: tasks.map((t) => t._id) } }, { $set: action === "priority" ? { priority: value } : { deadline: v.value, deadlineAlertSentAt: null } });
    done.push(...tasks.map((t) => t._id));
  } else if (action === "sprint") { // T-5 (D-143): same rules as the planning screen
    const w = await writableSprint(req, res, v.value); if (!w) return;
    if (!OPEN_STATUSES.includes(w.sprint.status)) return res.status(409).json({ error: "A closed sprint cannot be changed." });
    const others = await Sprint.find({ _id: { $ne: w.sprint._id }, tasks: { $in: tasks.map((t) => t._id) }, status: { $in: OPEN_STATUSES } }, "name tasks").lean();
    const elsewhere = new Map(others.flatMap((o) => o.tasks.map((id) => [String(id), o.name])));
    const foreignMods = new Set((await Milestone.find({ projectId: w.sprint.projectId, teamLeadId: { $nin: [null, req.user.id] } }, "_id").lean()).map((m) => String(m._id)));
    const mine = tasks.filter((t) => { if (!foreignMods.has(String(t.milestoneId))) return true; skipped.push({ id: t._id, title: t.title, reason: "it is in another Team Lead's module" }); return false; });
    const plan = bulkSprintPlan(mine, w.sprint, elsewhere);
    skipped.push(...plan.skipped);
    if (plan.add.length) {
      await Sprint.updateOne({ _id: w.sprint._id, status: { $in: OPEN_STATUSES } }, { $addToSet: { tasks: { $each: plan.add.map(OID) } } });
      const p = projectIn(s, w.sprint.projectId);
      AuditLog.create({ action: "sprint_tasks_changed", orgId: s.scope.org._id, performedBy: req.user.id, targetProjectId: w.sprint.projectId, projectTitle: p?.title, detail: `${plan.add.length} task(s) added to sprint "${w.sprint.name}".`, after: { taskIds: plan.add, action: "add" } }).catch(() => {});
    }
    done.push(...plan.add);
  } else if (action === "tag") {
    for (const t of tasks) (t.tags ?? []).length >= 5 && !(t.tags ?? []).includes(v.value) ? skipped.push({ id: t._id, title: t.title, reason: "already has 5 tags" }) : done.push(t._id);
    await Task.updateMany({ _id: { $in: done } }, { $addToSet: { tags: v.value } });
  } else { // assign: same rules as reassign (D-095), unassigned tasks get their first person
    const to = s.team.has(v.value) ? await User.findById(v.value, "name role status").lean() : null;
    if (!to) return res.status(400).json({ error: "Pick someone from your team." });
    for (const t of tasks) {
      const p = projectIn(s, t.projectId);
      const reasons = reassignBlockers({ task: t, to, fromId: t.assignee ?? null, eligibleTypes: ROLE_TASK_ELIGIBILITY[ROLE_TO_CATEGORY[to.role] ?? "developer"] ?? [], projectMemberIds: (p?.members ?? []).map((m) => m._id ?? m) });
      if (reasons.length) { skipped.push({ id: t._id, title: t.title, reason: reasons[0] }); continue; }
      const r = await Task.updateOne({ _id: t._id, status: { $in: ["Backlog", "To-Do", "In-Progress"] } },
        { $set: { assignee: to._id, assignees: [to._id], assignedBy: req.user.id, ...(t.status === "Backlog" ? { status: "To-Do" } : {}) } });
      if (!r.modifiedCount) { skipped.push({ id: t._id, title: t.title, reason: "it changed in the meantime" }); continue; }
      done.push(t._id);
      createNotification({ userId: to._id, orgId: req.user.orgId, type: "task_assigned", title: "A task was assigned to you", message: `"${t.title}" is now yours.`, meta: { taskId: t._id, projectId: t.projectId } }).catch(() => {});
    }
    if (done.length) AuditLog.create({ action: "task_reassigned", orgId: s.scope.org._id, performedBy: req.user.id, targetUserId: to._id, detail: `${done.length} task(s) assigned to ${to.name} in bulk.`, scope: "project" }).catch(() => {});
  }
  for (const id of done) Task.logActivity(id, req.user.id, "edited", { note: `bulk ${action}` });
  res.json({ updated: done.length, skipped });
}

// ── Saved filters (D-123): GET / POST { name, query } / DELETE :filterId ────
export async function listFilters(req, res) {
  const u = await User.findById(req.user.id, "savedTaskFilters").lean();
  res.json({ filters: (u?.savedTaskFilters ?? []).map((f) => ({ id: f._id, name: f.name, query: f.query })), max: MAX_SAVED_FILTERS });
}
export async function saveFilter(req, res) {
  const u = await User.findById(req.user.id, "savedTaskFilters").lean();
  const v = validateSavedFilter(req.body ?? {}, u?.savedTaskFilters?.length ?? 0);
  if (v.error) return res.status(400).json({ error: v.error });
  const r = await User.updateOne({ _id: req.user.id, [`savedTaskFilters.${MAX_SAVED_FILTERS - 1}`]: { $exists: false } }, { $push: { savedTaskFilters: v.value } });
  if (!r.modifiedCount) return res.status(400).json({ error: `You can keep ${MAX_SAVED_FILTERS} saved filters. Delete one first.` });
  return listFilters(req, res);
}
export async function deleteFilter(req, res) {
  if (!valid(req.params.filterId)) return res.status(404).json({ error: "Filter not found." });
  const r = await User.updateOne({ _id: req.user.id }, { $pull: { savedTaskFilters: { _id: OID(req.params.filterId) } } });
  if (!r.modifiedCount) return res.status(404).json({ error: "Filter not found." });
  return listFilters(req, res);
}

// ── Module: deadline change request (the Manager decides in the Inbox), QA-ready, history ──
async function loadModule(req, res, s) {
  const p = valid(req.params.projectId) ? projectIn(s, req.params.projectId) : null;
  if (!p) { res.status(404).json({ error: "Module not found in your projects." }); return null; }
  const id = req.body?.moduleId ?? req.query?.module;
  const mod = id ? (valid(id) ? await Milestone.findOne({ _id: id, projectId: p._id, teamLeadId: req.user.id }).lean() : null) : null;
  if (id && !mod) { res.status(404).json({ error: "Module not found in your projects." }); return null; }
  return { p, mod };
}
export async function requestModuleDeadline(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const m = await loadModule(req, res, s); if (!m) return;
  const reason = String(req.body?.reason ?? "").trim();
  const date = new Date(req.body?.newDate);
  const errors = {};
  if (Number.isNaN(+date)) errors.newDate = "Pick the new deadline.";
  else if (date < new Date(new Date().toDateString())) errors.newDate = "The new deadline cannot be in the past.";
  if (reason.length < 10 || reason.length > 1000) errors.reason = "Write a reason of 10 to 1000 characters.";
  if (Object.keys(errors).length) return fail(res, errors);
  if (!m.p.managerId) return res.status(409).json({ error: "This project has no Manager yet, so there is nobody to ask." });
  const pending = await OperationalRequest.exists({ orgId: req.user.orgId, type: "Deadline Extension", projectId: m.p._id, milestoneId: m.mod?._id ?? null, requesterId: req.user.id, status: { $in: ["Pending", "In Progress"] } });
  if (pending) return res.status(409).json({ error: "You already asked for a deadline change here. Wait for your Manager's answer." });
  const name = m.mod?.title ?? m.p.title;
  const current = m.mod?.dueDate ?? m.p.deadline;
  const r = await OperationalRequest.create({ orgId: req.user.orgId, type: "Deadline Extension", priority: "Medium", status: "Pending",
    title: `Deadline change for "${name}": ${date.toDateString()}`.slice(0, 200), message: `Current deadline: ${current ? new Date(current).toDateString() : "none"}. Reason: ${reason}`.slice(0, 2000),
    projectId: m.p._id, milestoneId: m.mod?._id ?? null, requesterId: req.user.id });
  createNotification({ userId: m.p.managerId._id, orgId: req.user.orgId, type: "deadline_change_request", title: "Deadline change requested",
    message: `${req.user.name ?? "Your Team Lead"} asks to move "${name}" to ${date.toDateString()}.`, meta: { projectId: m.p._id, milestoneId: m.mod?._id ?? null, requestId: r._id } }).catch(() => {});
  res.status(201).json({ ok: true, id: r._id, to: m.p.managerId.name });
}
export async function markQaReady(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const mod = valid(req.params.moduleId) ? await Milestone.findOne({ _id: req.params.moduleId, teamLeadId: req.user.id }, "title projectId tlAcceptedAt qaReadyAt").lean() : null;
  const p = mod && projectIn(s, mod.projectId);
  if (!mod || !p) return res.status(404).json({ error: "Module not found in your projects." });
  if (!mod.tlAcceptedAt) return res.status(409).json({ error: "Accept the module first." });
  const r = await Milestone.updateOne({ _id: mod._id, qaReadyAt: null }, { $set: { qaReadyAt: new Date() } });
  if (!r.modifiedCount) return res.status(409).json({ error: "This module is already marked ready for QA." });
  const testers = (p.members ?? []).filter((x) => /Tester/.test(x.role ?? "")).map((x) => x._id);
  for (const userId of [p.managerId?._id, ...testers].filter(Boolean)) {
    createNotification({ userId, orgId: req.user.orgId, type: "module_qa_ready", title: "Module ready for QA sign-off", message: `"${mod.title}" in "${p.title}" is ready for QA sign-off.`, meta: { projectId: p._id, milestoneId: mod._id } }).catch(() => {});
  }
  AuditLog.create({ action: "module_qa_ready", orgId: s.scope.org._id, performedBy: req.user.id, targetProjectId: p._id, projectTitle: p.title, detail: `Module "${mod.title}" marked ready for QA sign-off.`, scope: "project" }).catch(() => {});
  res.json({ ok: true, qaReadyAt: new Date(), notified: testers.length + (p.managerId ? 1 : 0) });
}
export async function moduleHistory(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const m = await loadModule(req, res, s); if (!m) return;
  const [audit, requests] = await Promise.all([
    AuditLog.find({ targetProjectId: m.p._id }, "action detail performedBy createdAt").sort({ createdAt: -1 }).limit(50).lean(),
    OperationalRequest.find({ projectId: m.p._id, type: "Deadline Extension" }, "title status managerNote createdAt resolvedAt").sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const ids = [...new Set(audit.map((a) => String(a.performedBy)).filter(valid))];
  const names = Object.fromEntries((await User.find({ _id: { $in: ids } }, "name").lean()).map((u) => [String(u._id), u.name]));
  res.json({
    events: audit.map((a) => ({ id: a._id, action: a.action, detail: a.detail, who: names[String(a.performedBy)] ?? null, at: a.createdAt })),
    deadlineRequests: requests.map((r) => ({ id: r._id, title: r.title, status: r.status, note: r.managerNote, at: r.createdAt, resolvedAt: r.resolvedAt })),
  });
}
