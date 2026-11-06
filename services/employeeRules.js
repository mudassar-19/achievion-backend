// Employee daily loop (E-2, Employee UX §4.1-4.3): pure rules for Today, My tasks and the task drawer.
// No DB here; workspaceController loads the data. The AI score never leaves this file (D-075): reviewView builds
// its output field by field and never copies aiScore / aiScores.
import { scoreToStars } from "./xpEngine.js";

const PRIORITY = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const OPEN = ["To-Do", "In-Progress"];
const time = (d) => (d ? new Date(d).getTime() : Infinity);
const byUrgency = (a, b) => time(a.deadline) - time(b.deadline) || (PRIORITY[a.priority] ?? 4) - (PRIORITY[b.priority] ?? 4);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** My tasks list order: open first (nearest deadline, none last, then priority), Done at the end. */
export const sortRows = (rows) => [...rows].sort((a, b) => (a.status === "Done") - (b.status === "Done") || byUrgency(a, b));

/** The one task to start now: To Do or In Progress, not blocked; nearest deadline, then priority. */
export function nextBestAction(tasks) {
  return tasks.filter((t) => OPEN.includes(t.status) && !t.blocked).sort(byUrgency)[0] ?? null;
}

/** Up to 5 not-Done tasks, nearest deadline first. */
export function todayTasks(tasks, max = 5) {
  return tasks.filter((t) => t.status !== "Done").sort(byUrgency).slice(0, max);
}

/** Not-Done tasks whose deadline falls on today's calendar day (server time). */
export function dueTodayCount(tasks, now = new Date()) {
  const today = ymd(now);
  return tasks.filter((t) => t.status !== "Done" && t.deadline && ymd(new Date(t.deadline)) === today).length;
}

/** Net XP per day: "week" = last 7 days, "month" = last 30 days, oldest first. */
export function xpTrend(logs, period, now = new Date()) {
  const days = period === "month" ? 30 : 7;
  const points = Array.from({ length: days }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i));
    return { date: ymd(d), xp: 0 };
  });
  const at = new Map(points.map((p) => [p.date, p]));
  for (const l of logs) { const p = at.get(ymd(new Date(l.createdAt))); if (p) p.xp += Number(l.amount) || 0; }
  return points;
}

/** From leaderboard rows (rank, xp): my rank and the XP to the next rank up (ties share a rank). */
export function rankCard(rows, meId) {
  const me = rows.find((r) => String(r.userId) === String(meId));
  if (!me) return null;
  const above = rows.filter((r) => r.xp > me.xp).sort((a, b) => a.xp - b.xp)[0];
  return { rank: me.rank, total: rows.length, gap: above ? above.xp - me.xp : 0, ahead: above?.name ?? null, nextRank: above?.rank ?? null };
}

/** MomentumCoach line from numbers only (the AI version comes in E-8). */
export function dailyInsight({ hp, dueToday, xpToNext, level, streak, openTasks }) {
  const why = [
    { label: "HP", value: hp }, { label: "Due today", value: dueToday }, { label: "Open tasks", value: openTasks },
    { label: "XP to next level", value: xpToNext }, { label: "Streak", value: streak },
  ];
  const due = dueToday === 1 ? "1 task is due today" : `${dueToday} tasks are due today`;
  let text;
  if (hp < 30) text = `Your HP is ${hp}. Take it steady: finish one task before you start the next.`;
  else if (dueToday > 0) text = `${due}. Start with the nearest deadline.`;
  else if (openTasks === 0) text = `No open tasks right now. ${xpToNext} XP to reach level ${level + 1}.`;
  else text = `${xpToNext} XP to reach level ${level + 1}.`;
  return { text, why };
}

const lastRevisionOf = (t) => (t.revisionHistory ?? []).filter((h) => (h.type ?? "revision_requested") === "revision_requested").at(-1) ?? null;
const pct = (m) => `${m >= 1 ? "+" : ""}${Math.round((m - 1) * 100)}%`;

/** Review result block for the assignee: decision, TL score + stars, feedback, last revision, "Why this XP". */
export function reviewView(task, xpLogs = []) {
  const last = lastRevisionOf(task);
  const decision = task.status === "Done" ? "approved" : task.status === "In-Review" ? "waiting" : last ? "revision" : "none";
  const score = task.tlScore ?? null;
  const xp = [];
  let xpTotal = 0;
  for (const l of xpLogs) {
    xpTotal += Number(l.amount) || 0;
    if (l.source === "task_approved") {
      const b = l.breakdown ?? {};
      if (b.base != null) xp.push({ label: "Base for the task", value: b.base });
      if (b.typeMult != null && b.typeMult !== 1) xp.push({ label: "Task type", value: `×${b.typeMult}` });
      if (b.timeMult != null && b.timeMult !== 1) xp.push({ label: "On time or early", value: pct(b.timeMult) });
      if (b.qualMult != null && b.qualMult !== 1) xp.push({ label: `Quality (${scoreToStars(score) ?? "?"} stars)`, value: pct(b.qualMult) });
      if (b.streakMult != null && b.streakMult !== 1) xp.push({ label: "Streak", value: pct(b.streakMult) });
      if (b.lateMult != null && b.lateMult !== 1) xp.push({ label: "Late", value: pct(b.lateMult) });
      xp.push({ label: "XP from the review", value: l.amount });
    } else if (l.source === "flag_reversal") xp.push({ label: "Taken back after a check", value: l.amount });
    else xp.push({ label: l.source === "task_rejected" ? "Revision" : "Other", value: l.amount });
  }
  return {
    decision, score, stars: scoreToStars(score), feedback: task.reviewNote ?? null,
    revisions: task.resubmissionCount ?? 0,
    lastRevision: last ? { reason: last.comment ?? "", unmet: last.unmetCriteria ?? [], at: last.requestedAt ?? null } : null,
    xp, xpTotal,
  };
}

/** Newest review event over my tasks: an approval (Done + reviewedAt) or a revision request. */
export function latestFeedback(tasks) {
  const events = [];
  for (const t of tasks) {
    if (t.status === "Done" && t.reviewedAt) events.push({ kind: "approved", taskId: t.id, title: t.title, at: t.reviewedAt, score: t.tlScore ?? null, stars: scoreToStars(t.tlScore) });
    const r = lastRevisionOf(t);
    if (r?.requestedAt) events.push({ kind: "revision", taskId: t.id, title: t.title, at: r.requestedAt, reason: r.comment ?? "" });
  }
  return events.sort((a, b) => new Date(b.at) - new Date(a.at))[0] ?? null;
}
