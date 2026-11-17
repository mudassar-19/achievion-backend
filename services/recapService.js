// Item 26 (D-538): the numbers of a recap period from the database, and the AI summary of them. The formulas and wording are in
// recapMetrics.js (pure, tested). The AI only sums up numbers it is given (no names exist in them) and only advises (D-011).
import Task from "../models/Task.js";
import XpLog from "../models/XpLog.js";
import Approval from "../models/Approval.js";
import ExtensionRequest from "../models/ExtensionRequest.js";
import { getPrompt } from "../ai/prompts/registry.js";
import { callChain } from "./aiChain.js";
import { buildRecapCards } from "./recapMetrics.js";
import { onTimeExpr } from "./onTimeRule.js";
import { orgTimezone } from "./orgTimezone.js";

// Weekly = Monday to Sunday of the week containing `now`; monthly = the calendar month; yearly = the calendar year (UTC for the last two).
export function periodFor(type, now = new Date()) {
  let start, end;
  if (type === "weekly") {
    const diff = (now.getUTCDay() === 0 ? -6 : 1) - now.getUTCDay(); // Monday to Sunday, in UTC like the other periods
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
    end = new Date(+start + 7 * 86_400_000 - 1);
  } else if (type === "monthly") {
    start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)); end = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999));
  } else {
    start = new Date(Date.UTC(now.getFullYear(), 0, 1)); end = new Date(Date.UTC(now.getFullYear(), 11, 31, 23, 59, 59, 999));
  }
  return { start, end };
}
// The period of the same length right before.
export const previousPeriod = ({ start, end }) => { const len = +end - +start + 1; return { start: new Date(+start - len), end: new Date(+start - 1) }; };

// org: { _id } of the organisation. → the numbers buildRecapCards wants.
export async function gatherPeriod(org, { start, end }, now = new Date()) {
  const oid = String(org._id), range = { $gte: start, $lte: end };
  const upTo = (d) => new Date(Math.min(+d, +now));
  const tz = org.workingTime?.timezone ?? await orgTimezone(org._id);
  const share = async (at) => {
    const total = await Task.countDocuments({ orgId: oid, createdAt: { $lte: at }, isDeleted: { $ne: true } });
    if (!total) return null;
    const done = await Task.countDocuments({ orgId: oid, createdAt: { $lte: at }, isDeleted: { $ne: true }, status: "Done", completedAt: { $lte: at } });
    return Math.round((done / total) * 100);
  };
  const xpMatch = { orgId: org._id, createdAt: range, amount: { $gt: 0 }, source: { $nin: ["adjust", "flag_reversal"] } };
  const [tasksDelivered, doneWithDeadline, onTimeDone, xp, people, extensions, pendingApprovals, progressStart, progressEnd] = await Promise.all([
    Task.countDocuments({ orgId: oid, status: "Done", completedAt: range }),
    Task.countDocuments({ orgId: oid, status: "Done", completedAt: range, deadline: { $ne: null } }),
    Task.countDocuments({ orgId: oid, status: "Done", completedAt: range, deadline: { $ne: null }, $expr: onTimeExpr(tz) }), // QA3 decision 7
    XpLog.aggregate([{ $match: xpMatch }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
    XpLog.distinct("userId", xpMatch),
    ExtensionRequest.countDocuments({ orgId: org._id, createdAt: range }),
    Approval.countDocuments({ orgId: org._id, status: "PENDING" }),
    share(upTo(start)), share(upTo(end)),
  ]);
  return { tasksDelivered, doneWithDeadline, onTimeDone, xpEarned: xp[0]?.total ?? 0, activeMembers: people.length, extensions, pendingApprovals, progressStart, progressEnd };
}

export async function recapCards(org, period, now = new Date()) {
  const [cur, prev] = await Promise.all([gatherPeriod(org, period, now), gatherPeriod(org, previousPeriod(period), now)]);
  return buildRecapCards(cur, prev);
}

// Short AI summary of the cards. Numbers only go in. Returns { text } or { error: "not_configured"|"cap"|"busy" } (never throws).
export async function aiRecapSummary({ orgId, userId, periodLabel, cards }) {
  const data = { period: periodLabel, metrics: cards.map((c) => ({ name: c.title, value: c.metric?.value, unit: c.metric?.unit, change: c.trend ? { direction: c.trend.dir, before: c.trend.prev } : undefined })) };
  const prompt = getPrompt("weekly-summary");
  try {
    const r = await callChain({ feature: "weekly_summary", orgId, requestedBy: userId, promptId: prompt.id, promptVersion: prompt.version,
      systemPrompt: prompt.system, userMessage: prompt.userTemplate(data), validate: prompt.validate });
    return { text: String(r.text).trim() };
  } catch (e) {
    return { error: e.status === 503 ? "not_configured" : e.status === 429 ? "cap" : "busy" };
  }
}
