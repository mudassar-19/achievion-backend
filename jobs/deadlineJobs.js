// V1 1.5 (24 h deadline alert) and 1.6 (missed deadline → HP). Rules: services/xpEngine.js (unit-tested).
import cron from "node-cron";
import Task from "../models/Task.js";
import Notification from "../models/Notification.js";
import GamificationProfile from "../models/GamificationProfile.js";
import { getIo } from "../utils/io.js";
import { notifyBurnout } from "../services/gamificationService.js";
import { DEADLINE_ALERT_HOURS, MISSED_DEADLINE_HP, deadlineAudience, deadlineAlertDue } from "../services/xpEngine.js";
import Organization from "../models/Organization.js";
import Milestone from "../models/Milestone.js";
import Project from "../models/Project.js";
import User from "../models/User.js";
import { effectiveDeadline } from "../services/streakService.js";
import { needsFlagReminder, flagAgeDays, REMIND_FLAG_DAYS } from "../services/anomalyRules.js";

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
  // H1a: an org that set a "deadline warning point" (Settings > Alerts) is judged by it; every other org keeps the 24 h window.
  const orgs = await Organization.find({ "alertSettings.orgRules.deadlineWarnPct": { $type: "number" } }, "_id orgId alertSettings").lean();
  const pctOf = new Map(orgs.flatMap((o) => [String(o._id), o.orgId].filter(Boolean).map((k) => [k, o.alertSettings.orgRules.deadlineWarnPct])));
  // ponytail: pct orgs read every open task with a future deadline once an hour; add an index on deadline if that gets big.
  const candidates = await Task.find({ status: { $in: OPEN }, deadlineAlertSentAt: null,
    $or: [{ deadline: { $gt: now, $lte: soon } }, { orgId: { $in: [...pctOf.keys()] }, deadline: { $gt: now } }] },
    "_id orgId title deadline assignees assignee milestoneId projectId status createdAt").lean();
  const due = candidates.filter((t) => deadlineAlertDue(t, now, pctOf.get(String(t.orgId)) ?? null));
  let sent = 0;
  for (const t of due) {
    const alertTitle = pctOf.has(String(t.orgId)) ? "Deadline approaching" : "Deadline in 24 hours";
    // Atomic claim: only one run (or instance) sends the alert for this task.
    const claimed = await Task.updateOne({ _id: t._id, deadlineAlertSentAt: null }, { $set: { deadlineAlertSentAt: now } });
    if (!claimed.modifiedCount) continue;
    const hours = Math.max(1, Math.round((new Date(t.deadline) - now) / 3_600_000));
    const { assignees, leads } = deadlineAudience(t, await leadsOf(t));
    for (const uid of assignees) {
      await notify(uid, t.orgId, "deadline_soon", "needs_action", alertTitle,
        `"${t.title}" is due in about ${hours} h. Submit it or ask your Team Lead for an extension.`, t._id);
      sent++;
    }
    for (const uid of leads) {
      await notify(uid, t.orgId, "deadline_soon", "needs_action", alertTitle,
        `"${t.title}" is due in about ${hours} h${assignees.length ? "" : " and nobody is assigned"}.`, t._id, `/teamlead/tasks?task=${t._id}`);
      sent++;
    }
  }
  return sent;
}

// F-049: Backlog tasks are not started work, so they never cost HP. F-007: date-only deadlines end at the org's local midnight.
const CHARGEABLE = OPEN.filter((s) => s !== "Backlog");
const LOOKBACK_MS = 7 * 86_400_000;
export function isMissedDeadline(t, now, timezone) {
  if (!CHARGEABLE.includes(t.status) || !t.deadline) return false;
  const eff = effectiveDeadline(t.deadline, timezone).getTime();
  return eff <= now.getTime() && eff > now.getTime() - LOOKBACK_MS;
}

export async function chargeMissedDeadlines(now = new Date()) {
  // ponytail: 7-day look-back so the first run doesn't charge years of old overdue tasks at once; widen if the job may be down longer.
  // The effective deadline is never earlier than the stored one, so "stored <= now" is a safe superset; 2 extra days cover the shift.
  const since  = new Date(now.getTime() - LOOKBACK_MS - 2 * 86_400_000);
  const cands = await Task.find({ status: { $in: CHARGEABLE }, deadline: { $lte: now, $gt: since }, overduePenaltyAt: null },
    "_id orgId title assignees assignee milestoneId projectId status deadline").lean();
  const tzOf = new Map();
  for (const o of await Organization.find({}, "_id orgId workingTime.timezone").lean())
    for (const k of [String(o._id), o.orgId].filter(Boolean)) tzOf.set(k, o.workingTime?.timezone || "Asia/Karachi");
  const missed = cands.filter((t) => isMissedDeadline(t, now, tzOf.get(String(t.orgId)) || "Asia/Karachi"));
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
  cron.schedule("30 * * * *", () => run("manager digest", sendManagerDigests)); // QA4 M-13: once per Manager per day (hourly check, deduped)
  cron.schedule("20 * * * *", () => run("flag reminders", remindStaleFlags)); // hourly: open review flags older than 3 days (QA3 G-16)
}

// QA3 G-16: an open review flag older than REMIND_FLAG_DAYS reminds the project's Manager once (remindedAt is set so it never repeats).
export async function remindStaleFlags(now = new Date()) {
  const since = new Date(+now - REMIND_FLAG_DAYS * 86_400_000);
  const tasks = await Task.find({ reviewFlags: { $elemMatch: { status: "open", remindedAt: null, createdAt: { $lte: since } } } }, "title orgId projectId reviewFlags").lean();
  let sent = 0;
  for (const t of tasks) {
    const project = await Project.findById(t.projectId, "managerId title").lean();
    for (const f of t.reviewFlags.filter((x) => needsFlagReminder(x, now))) {
      const claimed = await Task.updateOne({ _id: t._id, "reviewFlags._id": f._id, "reviewFlags.remindedAt": null }, { $set: { "reviewFlags.$.remindedAt": now } });
      if (!claimed.modifiedCount || !project?.managerId) continue;
      await Notification.create({ userId: project.managerId, orgId: String(t.orgId), type: "needs_action", tier: "needs_action", title: "Review flag is still open",
        message: `A flag on "${t.title}"${project.title ? ` (${project.title})` : ""} has waited ${flagAgeDays(f, now)} days for a decision.`, meta: { taskId: t._id } });
      sent++;
    }
  }
  return sent;
}

// QA4 M-13: ONE serious-items digest per Manager per day in the bell (overdue tasks, a sprint ending within 2 days with open tasks, open anomaly flags).
// Switch: Settings > Notifications > "AI insights digest" (type ai_digest). Only the Manager's own projects count (D-QA4-8).
export function digestText({ overdue = 0, sprints = [], flags = 0 }) {
  const parts = [];
  if (overdue) parts.push(`${overdue} overdue task${overdue === 1 ? "" : "s"}`);
  for (const s of sprints) parts.push(`${s.name} ends in ${s.days} day${s.days === 1 ? "" : "s"} with ${s.open} open task${s.open === 1 ? "" : "s"}`);
  if (flags) parts.push(`${flags} flag${flags === 1 ? "" : "s"} waiting for a second look`);
  return parts.length ? `${parts.join("; ")}.` : null;
}
export async function sendManagerDigests(now = new Date()) {
  const Sprint = (await import("../models/Sprint.js")).default, day = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const m of await User.find({ role: "Manager", status: "active" }, "_id orgId").lean()) {
    if (await Notification.exists({ userId: m._id, type: "ai_digest", "meta.day": day })) continue; // once a day
    const projects = await Project.find({ managerId: m._id, isDeleted: { $ne: true }, status: { $nin: ["Completed", "Archived", "Deleted"] } }, "_id").lean(), pids = projects.map((p) => p._id);
    if (!pids.length) continue;
    const [overdue, sp, flagAgg] = await Promise.all([
      Task.countDocuments({ projectId: { $in: pids }, status: { $nin: ["Done", "Cancelled"] }, deadline: { $lt: now, $ne: null } }),
      Sprint.find({ projectId: { $in: pids }, status: "Active", endDate: { $gte: now, $lte: new Date(+now + 2 * 86_400_000) } }, "name endDate tasks").populate("tasks", "status").lean(),
      Task.aggregate([{ $match: { projectId: { $in: pids }, "reviewFlags.0": { $exists: true } } }, { $unwind: "$reviewFlags" }, { $match: { "reviewFlags.status": "open" } }, { $count: "n" }]),
    ]);
    const sprints = sp.map((s) => ({ name: s.name, days: Math.max(0, Math.ceil((+new Date(s.endDate) - +now) / 86_400_000)), open: (s.tasks ?? []).filter((t) => t?.status !== "Done").length })).filter((s) => s.open > 0);
    const text = digestText({ overdue, sprints, flags: flagAgg[0]?.n ?? 0});
    if (!text) continue;
    await Notification.create({ userId: m._id, orgId: String(m.orgId), type: "ai_digest", tier: "fyi", title: "Today's team digest", message: text, meta: { day }, deepLink: "/manager" });
    sent++;
  }
  return sent;
}
