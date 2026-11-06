// Team Lead requests inbox (E-3, D-180): more time and one more try from the TL's own projects. The decisions reuse the existing
// handlers: respondExtension (task deadline) and decideLimitRequest (D-142, same rule as the Manager), behind the TL scope.
import mongoose from "mongoose";
import Task from "../models/Task.js";
import OperationalRequest from "../models/OperationalRequest.js";
import User from "../models/User.js";
import { respondExtension } from "./taskController.js";
import { decideLimitRequest } from "./opsHubController.js";
import { tlScope, taskIn } from "./teamLeadWorkController.js";
import { capture, passOn } from "../utils/capture.js";
import { LIMIT_TYPE } from "../services/reviewRules.js";

const OID = (x) => new mongoose.Types.ObjectId(String(x));
const note = (v) => String(v ?? "").trim();

// GET /api/teamlead/requests → { extensions: [...], tries: [...] } waiting for a decision, oldest first.
export async function listRequests(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const pids = [...s.ids].map(OID);
  const [tasks, tries] = await Promise.all([
    Task.find({ ...s.scope.filter, projectId: { $in: pids }, "extensionRequests.status": "PENDING" }, "title deadline projectId extensionRequests").lean(),
    OperationalRequest.find({ orgId: req.user.orgId, type: LIMIT_TYPE, status: { $in: ["Pending", "In Progress"] }, projectId: { $in: pids } }, "taskId attempts message requesterId createdAt").sort({ createdAt: 1 }).lean(),
  ]);
  const triesTasks = new Map((await Task.find({ _id: { $in: tries.map((r) => r.taskId) } }, "title maxResubmissions").lean()).map((t) => [String(t._id), t]));
  const people = new Map((await User.find({ _id: { $in: [...tasks.flatMap((t) => t.extensionRequests.map((e) => e.requestedBy)), ...tries.map((r) => r.requesterId)] } }, "name").lean()).map((u) => [String(u._id), u.name]));
  const title = (pid) => s.projects.find((p) => String(p._id) === String(pid))?.title ?? null;
  res.json({
    extensions: tasks.flatMap((t) => t.extensionRequests.filter((e) => e.status === "PENDING").map((e) => ({ taskId: String(t._id), task: t.title, project: title(t.projectId), who: people.get(String(e.requestedBy)) ?? "Someone",
      deadline: t.deadline, requestedDeadline: e.requestedDeadline, reason: e.reason, at: e.createdAt }))).sort((a, b) => new Date(a.at) - new Date(b.at)),
    tries: tries.map((r) => ({ id: String(r._id), taskId: String(r.taskId), task: triesTasks.get(String(r.taskId))?.title ?? "—", attempts: r.attempts, max: triesTasks.get(String(r.taskId))?.maxResubmissions ?? null,
      who: people.get(String(r.requesterId)) ?? "Someone", message: r.message, at: r.createdAt })),
  });
}

// POST /api/teamlead/requests/extension/:id { approved, note } (route: tw.ownTask). Declining needs a note.
export async function decideExtension(req, res) {
  const approved = req.body?.approved === true, n = note(req.body?.note);
  if (typeof req.body?.approved !== "boolean") return res.status(400).json({ error: "Choose Approve or Decline." });
  if (!approved && n.length < 5) return res.status(400).json({ error: "Say why in a few words (5 characters or more).", field: "note" });
  if (n.length > 300) return res.status(400).json({ error: "Keep the note under 300 characters.", field: "note" });
  const t = await Task.findById(req.params.id, "extensionRequests").lean();
  const index = (t?.extensionRequests ?? []).findIndex((e) => e.status === "PENDING");
  if (index < 0) return res.status(409).json({ error: "There is no open request on this task." });
  passOn(res, await capture(respondExtension, req, { params: { id: req.params.id }, body: { extensionIndex: index, approved, note: n } }));
}

// POST /api/teamlead/requests/limit/:id { decision: allow | decline, note } — only for a task in the TL's projects.
export async function decideTries(req, res) {
  const s = await tlScope(req, res); if (!s) return;
  const r = mongoose.isValidObjectId(req.params.id) ? await OperationalRequest.findOne({ _id: req.params.id, orgId: req.user.orgId, type: LIMIT_TYPE }, "taskId").lean() : null;
  if (!r || !(await taskIn(s, r.taskId, { status: () => ({ json: () => {} }) }))) return res.status(404).json({ error: "Request not found in your projects." });
  if (note(req.body?.note).length > 300) return res.status(400).json({ error: "Keep the note under 300 characters.", field: "note" });
  passOn(res, await capture(decideLimitRequest, req, { params: { id: req.params.id }, body: { decision: req.body?.decision, note: note(req.body?.note) } }));
}
