// T-4 (D-137): a QA-required task entered In-Review → the Testers on its project are told. Never blocks the submit.
import Project from "../models/Project.js";
import User from "../models/User.js";
import { createNotification } from "../controllers/notificationController.js";

export async function notifyQaNeeded(task, orgId) {
  if (!task.qaRequired || !task.projectId) return;
  const p = await Project.findById(task.projectId, "members").lean();
  const testers = await User.find({ _id: { $in: p?.members ?? [] }, role: /Tester$/, status: { $ne: "deleted" } }, "_id").lean();
  const skip = [...(task.assignees ?? []), ...(task.assignee ? [task.assignee] : [])].map(String);
  await Promise.all(testers.filter((u) => !skip.includes(String(u._id))).map((u) => createNotification({ userId: u._id, orgId, type: "qa_signoff_needed", title: "QA sign-off needed", message: `"${task.title}" is in review and needs your QA sign-off.`, meta: { taskId: task._id, projectId: task.projectId } })));
}
