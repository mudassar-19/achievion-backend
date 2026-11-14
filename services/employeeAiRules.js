// Employee AI rules (Batch 4: E14, E15, N11, N12; FR08-01/03, UC-13 step 4, UC-15, UC-16) — pure, no DB, no network.
// Tests: server/tests/b4EmployeeAi.test.mjs. The AI only suggests; nothing here writes data or touches XP.
// D-075: everything that goes to a prompt is built field by field from the caller's own numbers, so an AI score,
// another person's name or an email cannot reach it.
import { isNeutral } from "./managerAiRules.js";

export const DAILY_LIMIT = 30;     // AI calls per user per day
export const MAX_SUGGESTIONS = 8;  // suggestions per call
export const MAX_MESSAGE = 500;    // characters in one chat message
export const FEATURE_PREFIX = "emp_"; // every call is logged in AIPromptLog as emp_*

const EXPERT = {
  developer: { key: "codementor", name: "CodeMentor", blurb: "Pre-review checklist and code craft." },
  designer: { key: "pixelcritic", name: "PixelCritic", blurb: "Design feedback before you hand off." },
  tester: { key: "bughunter", name: "BugHunter", blurb: "Test ideas and clear bug reports." },
};
const persona = (id, p) => ({ id, ...p, promptId: `emp-chat-${p.key}`, tipsPromptId: `emp-tips-${p.key}` });
export function personasFor(kind) {
  return [persona("momentum", { key: "momentum", name: "MomentumCoach", blurb: "Your pace, priorities and streak." }), persona("expert", EXPERT[kind] ?? EXPERT.developer)];
}
export const QUICK_PROMPTS = {
  developer: ["What should I build first today?", "Give me a checklist before I ask for review."],
  designer: ["What should I design first today?", "What should I check before I hand off a design?"],
  tester: ["What should I inspect first today?", "How do I write a bug report that gets fixed fast?"],
};

// ── Input ─────────────────────────────────────────────────────────────────────
const bad = (error, field) => ({ ok: false, status: 400, error, field });
const OID = /^[0-9a-f]{24}$/i;
export function readPersona(id, kind) {
  if (id === undefined || id === null || id === "") return personasFor(kind)[0];
  return typeof id === "string" ? personasFor(kind).find((p) => p.id === id) ?? null : null;
}
export function readChat(body, kind) {
  const raw = body?.message;
  if (typeof raw !== "string") return bad("Type a question first.", "message");
  const message = raw.trim();
  if (!message) return bad("Type a question first.", "message");
  if (message.length > MAX_MESSAGE) return bad(`Keep the question under ${MAX_MESSAGE} characters.`, "message");
  const p = readPersona(body.persona, kind);
  if (!p) return bad("Pick MomentumCoach or your expert.", "persona");
  const chatId = body.chatId ?? null;
  if (chatId !== null && (typeof chatId !== "string" || !OID.test(chatId))) return bad("This chat could not be found.", "chatId");
  return { ok: true, message, persona: p, chatId };
}
const one = (v, allowed) => v === undefined || (typeof v === "string" && allowed.includes(v));
export function readBoardQuery(q = {}) {
  if (!one(q.scope, ["company", "team", "project"])) return bad("Unknown leaderboard scope.", "scope");
  if (!one(q.period, ["all", "month", "week"])) return bad("Unknown leaderboard period.", "period");
  if (q.projectId !== undefined && (typeof q.projectId !== "string" || !OID.test(q.projectId))) return bad("Unknown project.", "projectId");
  return { ok: true, query: { ...(q.scope && { scope: q.scope }), period: q.period ?? "all", ...(q.projectId && { projectId: q.projectId }) } };
}

// ── Slash commands (UC-15 alternative flow): answered from the caller's own data, no AI call ─────────────────────
export function commandOf(message) {
  const m = /^\/([a-z]*)/i.exec(String(message ?? "").trim());
  if (!m) return null;
  const c = m[1].toLowerCase();
  return c === "tasks" || c === "xp" ? c : "help";
}
export const HELP_REPLY = { text: "I know two commands:\n- /tasks shows your open tasks\n- /xp shows your level, XP and streak\nAnything else: just ask in plain words.", sources: [] };
const n = (v) => (Number(v) || 0).toLocaleString("en-US");
const status = (s) => (s === "To-Do" ? "To do" : String(s ?? "").replace("-", " "));
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const due = (d, now) => {
  if (!d) return "no deadline";
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  return days < 0 ? `${-days} ${days === -1 ? "day" : "days"} late` : days === 0 ? "due today" : days === 1 ? "due tomorrow" : `due in ${days} days`;
};
const openOf = (rows) => (rows ?? []).filter((r) => r.status !== "Done");
export function tasksReply(rows, now = new Date()) {
  const open = openOf(rows), sources = [{ key: "tasks", label: "My tasks", to: "/workspace/tasks" }];
  if (!open.length) return { text: "You have no open tasks right now.", sources };
  const lines = open.slice(0, MAX_SUGGESTIONS).map((r) => `- ${r.title} · ${status(r.status)} · ${r.priority} · ${due(r.deadline, now)} · ${r.xp} XP${r.blocked ? " · blocked" : ""}`);
  const more = open.length > lines.length ? `\nShowing the ${lines.length} nearest. The rest are on My tasks.` : "";
  return { text: `You have ${open.length} open ${open.length === 1 ? "task" : "tasks"}:\n${lines.join("\n")}${more}`, sources };
}
export function xpReply({ level = 1, currentXp = 0, maxXp = 100, totalXp = 0, streak = 0, weekXp = 0, rank = null } = {}) {
  const lines = [
    `- Level ${level}: ${n(currentXp)} of ${n(maxXp)} XP`,
    `- ${n(Math.max(0, maxXp - currentXp))} XP to reach level ${level + 1}`,
    `- ${n(totalXp)} XP in total, ${n(weekXp)} XP in the last 7 days`,
    `- Streak: ${n(streak)} day${streak === 1 ? "" : "s"}`,
    ...(rank ? [`- Team rank: #${rank.rank} of ${rank.total}${rank.gap ? `, ${n(rank.gap)} XP to the next rank` : ""}`] : []),
  ];
  return { text: `Your XP right now:\n${lines.join("\n")}`, sources: [{ key: "profile", label: "Profile", to: "/workspace/profile" }] };
}

// ── Prompt data: the caller's own numbers only (D-075) ───────────────────────────────────────────────────────────
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);
export function snapshotFor({ kind, tiles = {}, hp, weekXp, rank, rows = [], totals } = {}) {
  return {
    role: kind, level: num(tiles.level), xpToNextLevel: num(tiles.xpToNext), streakDays: num(tiles.streak), hp: num(hp), xpLast7Days: num(weekXp),
    openTasks: num(tiles.open) ?? openOf(rows).length, dueToday: num(tiles.dueToday),
    rank: rank ? { rank: num(rank.rank), outOf: num(rank.total), xpToNextRank: num(rank.gap) } : null,
    tasks: openOf(rows).slice(0, MAX_SUGGESTIONS).map((r) => ({ title: String(r.title ?? "").slice(0, 120), status: r.status, priority: r.priority, type: r.type,
      deadline: r.deadline ? ymd(r.deadline) : null, xp: num(r.xp), blocked: !!r.blocked || undefined, sentBackForChanges: !!r.revision || undefined })),
    results: totals ? { tasksDone: num(totals.done), tasksTotal: num(totals.total), completionPct: num(totals.completionPct), onTimePct: num(totals.onTimePct), avgReviewScore: num(totals.avgQuality) } : null,
  };
}

// ── Output checks ─────────────────────────────────────────────────────────────
const str = (s, min, max) => typeof s === "string" && s.trim().length >= min && s.trim().length <= max;
// The AI score is never shown to an employee (D-075). No prompt holds one, so an answer that gives one a number invented it.
// Saying "I cannot show an AI score" is fine and is what the prompt asks for.
const AI_SCORE = /\bAI[- ]?(quality[- ]?)?(score|rating|grade)s?\b[^.!?\n]{0,60}\d/i;
const fine = (s) => isNeutral(s) && !AI_SCORE.test(s);
const no = (error) => ({ ok: false, error });
const bare = (s) => s.trim().replace(/^(\d+[.)]|[-•*])\s+/, ""); // models like to number list items; the page numbers them itself
export function checkChat(o) {
  if (!o || !str(o.answer, 1, 1200) || !fine(o.answer)) return no("answer");
  return { ok: true, value: { answer: o.answer.trim() } };
}
export function checkTips(o) {
  if (!o || !Array.isArray(o.tips) || !o.tips.length) return no("tips");
  const tips = o.tips.slice(0, MAX_SUGGESTIONS);
  if (!tips.every((t) => t && str(t.title, 3, 60) && str(t.tip, 10, 240) && fine(t.title) && fine(t.tip))) return no("tip");
  return { ok: true, value: { tips: tips.map((t) => ({ title: t.title.trim(), tip: t.tip.trim() })) } };
}
export function checkCommentary(o) {
  const line = typeof o?.line === "string" ? o.line.replace(/\s+/g, " ").trim() : "";
  if (!str(line, 10, 180) || !fine(line)) return no("line");
  return { ok: true, value: { line } };
}
export function checkSummary(o) {
  if (!o || !str(o.summary, 20, 600) || !fine(o.summary)) return no("summary");
  const recs = o.recommendations ?? [];
  if (!Array.isArray(recs)) return no("recommendations");
  const list = recs.slice(0, MAX_SUGGESTIONS);
  if (!list.every((r) => str(r, 5, 200) && fine(r))) return no("recommendation");
  return { ok: true, value: { summary: o.summary.trim(), recommendations: list.map(bare) } };
}

// ── Fallback words when the AI is slow or down (numbers only) ────────────────────────────────────────────────────
const FIRST = { developer: "Build", designer: "Design", tester: "Inspect" };
export function fallbackTips(snap) {
  const tips = [], next = snap.tasks?.find((t) => !t.blocked);
  if (snap.hp !== null && snap.hp < 30) tips.push({ title: "Take it steady", tip: `Your HP is ${snap.hp}. Finish one task before you start the next and take short breaks.` });
  if (next) tips.push({ title: "Start with the nearest deadline", tip: `${FIRST[snap.role] ?? "Start"} "${next.title.slice(0, 80)}" first${next.deadline ? `: its deadline is ${next.deadline}` : ""}.` });
  if (snap.dueToday) tips.push({ title: "Due today", tip: `${snap.dueToday} of your tasks ${snap.dueToday === 1 ? "is" : "are"} due today. Close those before new work.` });
  if (snap.tasks?.some((t) => t.sentBackForChanges)) tips.push({ title: "Finish the changes first", tip: "A task came back with change requests. Read the review note and resubmit before you start something new." });
  if (snap.xpToNextLevel) tips.push({ title: "Next level", tip: `${snap.xpToNextLevel} XP takes you to level ${(snap.level ?? 1) + 1}.` });
  if (!tips.length) tips.push({ title: "All clear", tip: "You have no open tasks right now. Check Quests or ask your Team Lead for the next task." });
  return { tips: tips.slice(0, MAX_SUGGESTIONS) };
}
export function fallbackCommentary(rank) {
  if (!rank?.rank) return { line: "A rank appears here once at least two people in this view have XP." };
  if (rank.rank === 1) return { line: `You are #1 of ${rank.outOf ?? rank.total}. Keep the lead.` };
  const gap = rank.xpToNextRank ?? rank.gap;
  return { line: `You are #${rank.rank} of ${rank.outOf ?? rank.total}.${gap ? ` ${n(gap)} XP takes you to the next rank.` : ""}` };
}
export function fallbackSummary(t) {
  if (!t?.total) return { summary: "There are no tasks to analyse yet. Your charts fill in as you finish tasks.", recommendations: [] };
  const parts = [`You finished ${t.done} of ${t.total} tasks (${t.completionPct}%).`];
  if (t.onTimePct !== null) parts.push(`${t.onTimePct}% of the finished tasks with a deadline were on time.`);
  if (t.avgQuality !== null) parts.push(`Your average review score is ${t.avgQuality} out of 100.`);
  const recs = [];
  if (t.onTimePct !== null && t.onTimePct < 80) recs.push("Start the task with the nearest deadline first.");
  if (t.avgQuality !== null && t.avgQuality < 70) recs.push("Check every acceptance criterion before you submit.");
  return { summary: parts.join(" "), recommendations: recs };
}

// ── Analytics (N12, UC-16): completion and quality per week over the last 8 weeks, the caller's tasks only ───────
// Completion of a week = finished share of the tasks whose deadline fell in that week. Quality = average Team Lead
// review score (0-100) of the tasks reviewed in that week. Built from status / deadline / completedAt / reviewedAt / tlScore only.
const WEEKS = 8, WEEK_MS = 7 * 86_400_000;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const avg = (list) => (list.length ? Math.round(list.reduce((s, x) => s + x, 0) / list.length) : null);
export function analyticsOf(tasks = [], now = new Date()) {
  const weekOf = (d) => { if (!d) return -1; const ago = Math.floor((+now - +new Date(d)) / WEEK_MS); return ago >= 0 && ago < WEEKS && +new Date(d) <= +now ? WEEKS - 1 - ago : -1; };
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ weekStart: ymd(new Date(+now - (WEEKS - i) * WEEK_MS)), due: 0, done: 0, scores: [] }));
  const scores = [];
  let done = 0, judged = 0, onTime = 0;
  for (const t of tasks) {
    const isDone = t.status === "Done", w = weekOf(t.deadline), r = weekOf(t.reviewedAt);
    if (w >= 0) { weeks[w].due++; if (isDone) weeks[w].done++; }
    if (isDone) { done++; if (t.deadline && t.completedAt) { judged++; if (+new Date(t.completedAt) <= +new Date(t.deadline)) onTime++; } }
    if (isDone && typeof t.tlScore === "number") { scores.push(t.tlScore); if (r >= 0) weeks[r].scores.push(t.tlScore); }
  }
  return {
    weeks: weeks.map(({ scores: s, ...w }) => ({ ...w, completionPct: pct(w.done, w.due), quality: avg(s) })),
    totals: { done, total: tasks.length, completionPct: pct(done, tasks.length), onTimePct: pct(onTime, judged), avgQuality: avg(scores), reviewed: scores.length },
  };
}
