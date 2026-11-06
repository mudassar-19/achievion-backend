// T-5 (D-142): a task reached its resubmission limit → one open "Resubmission limit reached" request in the Manager's Inbox.
import OperationalRequest from "../models/OperationalRequest.js";
import User from "../models/User.js";
import Project from "../models/Project.js";
import { limitRequestFields, LIMIT_TYPE } from "./reviewRules.js";
import { createNotification } from "../controllers/notificationController.js";

export async function openLimitRequest(task, tl, attempts) {
  const open = await OperationalRequest.findOne({ taskId: task._id, type: LIMIT_TYPE, status: { $in: ["Pending", "In Progress"] } }, "_id").lean();
  if (open) return open;
  const assignee = await User.findById(task.assignee ?? task.assignees?.[0], "name").lean();
  const request = await OperationalRequest.create({ ...limitRequestFields({ taskTitle: task.title, assigneeName: assignee?.name, tlName: tl.name, attempts, max: task.maxResubmissions ?? 3 }),
    orgId: task.orgId, status: "Pending", requesterId: tl.id, projectId: task.projectId ?? null, milestoneId: task.milestoneId ?? null, taskId: task._id, attempts });
  const p = task.projectId ? await Project.findById(task.projectId, "managerId").lean() : null;
  if (p?.managerId) await createNotification({ userId: p.managerId, orgId: task.orgId, type: "manager_decision_required", title: "Resubmission limit reached", message: `"${task.title}" was sent back ${attempts} times. Allow another try or decline in your Inbox.`, meta: { taskId: task._id, projectId: task.projectId } });
  return request;
}
export const limitRequestOf = (taskId) => OperationalRequest.findOne({ taskId, type: LIMIT_TYPE }, "status managerNote createdAt").sort({ createdAt: -1 }).lean();
