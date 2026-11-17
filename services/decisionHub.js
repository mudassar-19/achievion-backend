// C-5/C-6: ONE place for "what is waiting for the Director": account approvals + extension requests.
// Used by the sidebar badge, the dashboard card and the bell. Also expires dead extension requests and nudges old ones.
import Approval from "../models/Approval.js";
import ExtensionRequest from "../models/ExtensionRequest.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { isReadOnly } from "../middleware/viewAs.js";
import { createNotification } from "../controllers/notificationController.js";

const DAY = 86_400_000;
export const REMIND_AFTER_DAYS = 3;

/** Pure: is this pending request already pointless (the date it asks for has passed)? */
export const isDeadExtension = (ext, now = new Date()) => !!ext.originalDeadline && +new Date(ext.originalDeadline) + (ext.requestedDays ?? 0) * DAY < +now;
/** Pure: has it waited long enough for a reminder? */
export const needsReminder = (ext, now = new Date()) => !ext.reminderSentAt && +now - +new Date(ext.createdAt) >= REMIND_AFTER_DAYS * DAY;

/** A decided/expired request closes its "needs action" bell items (B-2): read, FYI tier, with the outcome. */
export function resolveNotifications(extId, outcome) {
  return Notification.updateMany({ "meta.extensionRequestId": extId, tier: "needs_action" }, [
    { $set: { read: true, tier: "fyi", "meta.resolved": outcome, message: { $concat: ["$message", ` Decision: ${outcome}.`] } } },
  ], { updatePipeline: true }); // pipeline-style update (needed to append to the existing message)
}

export async function expireAndRemind(orgObjectId, now = new Date()) {
  if (isReadOnly()) return; // a View-as read never writes
  const pending = await ExtensionRequest.find({ orgId: orgObjectId, status: "pending" }).populate("taskId", "title").lean();
  for (const e of pending) {
    if (isDeadExtension(e, now)) {
      await ExtensionRequest.updateOne({ _id: e._id, status: "pending" }, { $set: { status: "expired", decidedAt: now, directorNote: "Expired: the date it asked for had already passed." } });
      await resolveNotifications(e._id, "Expired");
      await createNotification({ userId: String(e.requestedBy), orgId: String(orgObjectId), type: "needs_action", title: "Extension request expired",
        message: `Your extension request for "${e.taskId?.title ?? "a project deadline"}" expired because the new date had already passed. Ask again with a new date.`, meta: { extensionRequestId: e._id } });
    } else if (needsReminder(e, now)) {
      await ExtensionRequest.updateOne({ _id: e._id }, { $set: { reminderSentAt: now } });
      const dirs = await User.find({ orgId: String(orgObjectId), role: "Director", status: { $ne: "deleted" } }, "_id").lean();
      const days = Math.floor((+now - +new Date(e.createdAt)) / DAY);
      for (const d of dirs) await createNotification({ userId: String(d._id), orgId: String(orgObjectId), type: "needs_action", title: "Extension request is waiting",
        message: `An extension request for "${e.taskId?.title ?? "a project deadline"}" has waited ${days} days for your decision.`, meta: { extensionRequestId: e._id } });
    }
  }
}

export async function decisionCounts(orgObjectId) {
  await expireAndRemind(orgObjectId).catch((e) => console.warn("[decision-hub]", e.message));
  const [approvals, extensions] = await Promise.all([
    Approval.countDocuments({ orgId: orgObjectId, status: "PENDING" }),
    ExtensionRequest.countDocuments({ orgId: orgObjectId, status: "pending" }),
  ]);
  return { approvals, extensions, total: approvals + extensions };
}
