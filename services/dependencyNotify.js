// T-2 (D-124): "Task unblocked" notifications when a prerequisite reaches Done. Never throws into the caller.
import Task from "../models/Task.js";
import { createNotification } from "../controllers/notificationController.js";
import { unblockedTasks } from "./taskFormRules.js";

export async function notifyUnblocked(done) {
  const dependents = await Task.find({ dependsOn: done._id, status: { $ne: "Done" } }, "title status dependsOn assignee assignees createdBy orgId").lean();
  if (!dependents.length) return;
  const prereqIds = [...new Set(dependents.flatMap((t) => (t.dependsOn ?? []).map(String)))];
  const prereqs = await Task.find({ _id: { $in: prereqIds } }, "status").lean();
  const statusOf = new Map(prereqs.map((p) => [String(p._id), String(p._id) === String(done._id) ? "Done" : p.status]));
  const free = new Set(unblockedTasks(String(done._id), dependents.map((t) => ({ id: String(t._id), status: t.status, dependsOn: t.dependsOn })), statusOf));
  for (const t of dependents.filter((x) => free.has(String(x._id)))) {
    const people = [...new Set([...(t.assignees ?? []), t.assignee, t.createdBy].filter(Boolean).map(String))];
    for (const userId of people) {
      await createNotification({ userId, orgId: t.orgId, type: "task_unblocked", title: "Task unblocked",
        message: `"${t.title}" can start: "${done.title}" is done.`, meta: { taskId: t._id, prerequisiteId: done._id } }).catch(() => {});
    }
  }
}
