// V1 1.5 (24 h deadline alert) and 1.6 (missed deadline → HP). Rules: services/xpEngine.js (unit-tested).
import cron from "node-cron";
import Task from "../models/Task.js";
import Notification from "../models/Notification.js";
import GamificationProfile from "../models/GamificationProfile.js";
import { getIo } from "../utils/io.js";
import { notifyBurnout } from "../services/gamificationService.js";
import { DEADLINE_ALERT_HOURS, MISSED_DEADLINE_HP, deadlineAudience } from "../services/xpEngine.js";
import Milestone from "../models/Milestone.js";
import Project from "../models/Project.js";
import User from "../models/User.js";

const OPEN = ["Backlog", "To-Do", "In-Progress"];
const recipients = (t) => deadlineAudience(t).assignees;

// D-155: the module's Team Lead, else the Team Leads on the project. Settings promises them this alert.
async function leadsOf(t) {
  const m = t.milestoneId ? await Milestone.findById(t.milestoneId, "teamLeadId").lean() : null;
  if (m?.teamLeadId) return [m.teamLeadId];
  const p = t.projectId ? await Project.findById(t.projectId, "members").lean() : null;
  return p ? (await User.find({ _id: { $in: p.members ?? [] }, role: "Team Lead", status: { $ne: "deleted" } }, "_id").lean()).map((u) => u._id) : [];
}

async function notify(userId, orgId, type, tier, title, message, taskId, deepLink = `/workspace/tasks/${taskId}`) {
  await Notification.create({ userId, orgId, type, tier, title, message, deepLink, meta: { taskId } });
  getIo()?.to(`user:${userId}`).emit("notification:new", { type, message });
}

export async function sendDeadlineAlerts(now = new Date()) {
  const soon = new Date(now.getTime() + DEADLINE_ALERT_HOURS * 3_600_000);
  const due = await Task.find({ status: { $in: OPEN }, deadline: { $gt: now, $lte: soon }, deadlineAlertSentAt: null },
    "_id orgId title deadline assignees assignee milestoneId projectId").lean();
  let sent = 0;
  for (const t of due) {
    // Atomic claim: only one run (or instance) sends the alert for this task.
    const claimed = await Task.updateOne({ _id: t._id, deadlineAlertSentAt: null }, { $set: { deadlineAlertSentAt: now } });
    if (!claimed.modifiedCount) continue;
    const hours = Math.max(1, Math.round((new Date(t.deadline) - now) / 3_600_000));
    const { assignees, leads } = deadlineAudience(t, await leadsOf(t));
    for (const uid of assignees) {
      await notify(uid, t.orgId, "deadline_soon", "needs_action", "Deadline in 24 hours",
        `"${t.title}" is due in about ${hours} h. Submit it or ask your Team Lead for an extension.`, t._id);
      sent++;
    }
    for (const uid of leads) {
      await notify(uid, t.orgId, "deadline_soon", "needs_action", "Deadline in 24 hours",
        `"${t.title}" is due in about ${hours} h${assignees.length ? "" : " and nobody is assigned"}.`, t._id, `/teamlead/tasks?task=${t._id}`);
      sent++;
    }
  }
  return sent;
}

export async function chargeMissedDeadlines(now = new Date()) {
  // ponytail: 7-day look-back so the first run doesn't charge years of old overdue tasks at once; widen if the job may be down longer.
  const since  = new Date(now.getTime() - 7 * 86_400_000);
  const missed = await Task.find({ status: { $in: OPEN }, deadline: { $lte: now, $gt: since }, overduePenaltyAt: null },
    "_id orgId title assignees assignee milestoneId projectId").lean();
  let charged = 0;
  for (const t of missed) {
    const claimed = await Task.updateOne({ _id: t._id, overduePenaltyAt: null }, { $set: { overduePenaltyAt: now } });
    if (!claimed.modifiedCount) continue;
    for (const uid of recipients(t)) {
      const before = await GamificationProfile.findOne({ userId: uid }, "hp").lean();
      if (!before) continue;
      const hp = Math.max(0, (before.hp ?? 100) - MISSED_DEADLINE_HP);
      await GamificationProfile.updateOne({ userId: uid }, { $set: { hp } });
      await notify(uid, t.orgId, "deadline_missed", "critical", "Deadline missed",
        `"${t.title}" passed its deadline. −${MISSED_DEADLINE_HP} HP. You can still submit it (late work earns 15% less XP).`, t._id);
      getIo()?.to(`user:${uid}`).emit("xp:penalty", { amount: 0, hpLost: MISSED_DEADLINE_HP, newHP: hp, reason: "Deadline missed" });
      await notifyBurnout(uid, t.orgId, before.hp ?? 100, hp);
      charged++;
    }
    // D-155: the Team Lead is told; only the assignee loses HP.
    for (const uid of deadlineAudience(t, await leadsOf(t)).leads) await notify(uid, t.orgId, "deadline_missed", "critical", "Deadline missed", `"${t.title}" passed its deadline.`, t._id, `/teamlead/tasks?task=${t._id}`);
  }
  return charged;
}

export function startDeadlineJobs() {
  const run = (name, fn) => fn().then((n) => n && console.log(`[deadline] ${name}: ${n}`)).catch((e) => console.error(`[deadline] ${name}:`, e.message));
  cron.schedule("5 * * * *",  () => run("alerts", sendDeadlineAlerts));      // hourly
  cron.schedule("10 0 * * *", () => run("missed", chargeMissedDeadlines));   // daily 00:10, after the streak/HP cron
}
