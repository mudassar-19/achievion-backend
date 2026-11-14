// Challenges (Quest) rules (V2 Phase 3 · M-5, UX §8, FR07). Pure: no DB, no clock unless passed in.
// Progress is read from the XP ledger (one task_approved row per user per task), so nothing is counted twice.
export const METRICS = {
  tasks_completed: { label: "Tasks completed",         unit: "tasks" },
  on_time_tasks:   { label: "On-time tasks",           unit: "tasks" },
  avg_quality:     { label: "Average quality (stars)", unit: "stars" },
  streak_days:     { label: "Streak days",             unit: "days" },
};
export const SCOPES = ["individual", "team", "organisation"];
// Type decides the window: Daily resets at midnight, Weekly on Monday (both UTC; the org has no time zone
// setting yet), Sprint ends with its linked sprint, Custom uses its own dates. Daily/Weekly may repeat.
export const TYPES = ["daily", "weekly", "sprint", "custom"];
export const REPEATABLE = ["daily", "weekly"];
const DAY = 86_400_000;
export const STATUSES = ["draft", "active", "completed", "expired"];
export const DEFAULT_CAP = { xp: 500, gold: 250 };
export const PAGE_SIZE = 25;
const OID = /^[0-9a-f]{24}$/i;

const toDate = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const whole = (v) => (Number.isInteger(Number(v)) && String(v).trim() !== "" ? Number(v) : NaN);

export function rewardCap(org) {
  const c = org?.questRewardCap ?? {};
  return { xp: Number.isFinite(c.xp) ? c.xp : DEFAULT_CAP.xp, gold: Number.isFinite(c.gold) ? c.gold : DEFAULT_CAP.gold };
}

const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const endOf = (start, days) => new Date(start.getTime() + days * DAY - 1);

// The window a quest of this type covers when it starts at `anchor`.
export function periodFor(type, anchor, { sprintEnd = null, deadline = null } = {}) {
  const a = toDate(anchor); if (!a) return null;
  if (type === "daily") { const s = dayStart(a); return { start: s, end: endOf(s, 1) }; }
  if (type === "weekly") { const d0 = dayStart(a); const s = new Date(d0.getTime() - ((d0.getUTCDay() + 6) % 7) * DAY); return { start: s, end: endOf(s, 7) }; }
  if (type === "sprint") { const e = toDate(sprintEnd); return e ? { start: a, end: endOf(dayStart(e), 1) } : null; }
  const e = toDate(deadline); return e ? { start: a, end: e } : null;
}

// Repeat: the next window after the one that ended. If periods were missed, jump to the one containing `now`
// (no back-dated quests). null when the quest does not repeat.
export function nextPeriod(quest, now = new Date()) {
  if (!quest.repeat || !REPEATABLE.includes(quest.type)) return null;
  const after = new Date(new Date(quest.deadline).getTime() + 1);
  return periodFor(quest.type, now > after ? now : after);
}

// Create / edit form. `locked` = the quest is active: metric, target, scope and rewards stay as published.
export function validateQuestInput(body = {}, { cap = DEFAULT_CAP, locked = false, validBadgeIds = null } = {}) {
  const errors = {}, value = {};
  const title = String(body.title ?? "").trim();
  if (title.length < 3 || title.length > 80) errors.title = "Give the challenge a title (3–80 characters)."; // U-1 (D-130)
  value.title = title;
  value.description = String(body.description ?? "").trim().slice(0, 500);
  const type = TYPES.includes(body.type) ? body.type : "custom";
  value.type = type;
  value.repeat = REPEATABLE.includes(type) && Boolean(body.repeat);
  value.sprintId = null;
  if (type === "sprint") {
    if (!OID.test(String(body.sprintId ?? "")) || !toDate(body.sprintEnd)) errors.sprintId = "Choose the sprint this challenge follows.";
    else value.sprintId = String(body.sprintId);
  }
  const startDate = toDate(body.startDate);
  if (!startDate) errors.startDate = "Pick a start date.";
  const period = startDate ? periodFor(type, startDate, { sprintEnd: body.sprintEnd, deadline: body.deadline }) : null;
  if (type === "custom" && !toDate(body.deadline)) errors.deadline = "Pick a deadline.";
  else if (startDate && period && period.end <= startDate) errors.deadline = type === "sprint" ? "That sprint has already ended." : "The deadline must be after the start date.";
  value.startDate = period?.start ?? startDate; value.deadline = period?.end ?? null;
  if (locked) return { errors, value };

  if (!METRICS[body.metric]) errors.metric = "Choose what to measure.";
  value.metric = body.metric;
  const target = body.metric === "avg_quality" ? Number(body.target) : whole(body.target);
  if (body.metric === "avg_quality" ? !(target >= 1 && target <= 5) : !(target >= 1 && target <= 365)) {
    errors.target = body.metric === "avg_quality" ? "Average quality is between 1 and 5 stars." : "Set a target from 1 to 365.";
  }
  value.target = body.metric === "avg_quality" ? Math.round(target * 10) / 10 : target;
  if (!SCOPES.includes(body.scope)) errors.scope = "Choose who takes part.";
  value.scope = body.scope;
  value.scopeRef = null;
  if (body.scope === "individual" || body.scope === "team") {
    const ref = body.scopeRef ?? {};
    const kind = body.scope === "individual" ? "user" : ref.kind;
    if (!["user", "project", "team"].includes(kind) || !OID.test(String(ref.id ?? ""))) {
      errors.scopeRef = body.scope === "individual" ? "Choose the person." : "Choose a project or a team.";
    } else value.scopeRef = { kind, id: String(ref.id) };
  }
  const xp = whole(body.rewardXp), gold = whole(body.rewardGold ?? 0);
  if (!(xp >= 1 && xp <= cap.xp)) errors.rewardXp = `Reward XP must be 1 to ${cap.xp} (the Director's limit).`;
  if (!(gold >= 0 && gold <= cap.gold)) errors.rewardGold = `Reward gold must be 0 to ${cap.gold} (the Director's limit).`;
  value.rewardXp = xp; value.rewardGold = gold;
  const bid = body.rewardBadgeId ? String(body.rewardBadgeId).trim() : null;
  if (bid) {
    if (validBadgeIds && !validBadgeIds.has(bid)) errors.rewardBadgeId = "Unknown badge ID.";
    else value.rewardBadgeId = bid;
  } else {
    value.rewardBadgeId = null;
  }
  return { errors, value };
}

// Can publish now? (dates still ahead, someone takes part)
export function publishBlockers(quest, { participants, now = new Date() }) {
  const r = [];
  if (quest.status !== "draft") r.push("Only a draft can be published.");
  if (!quest.deadline || new Date(quest.deadline) <= now) r.push("The deadline has passed. Pick a later deadline first.");
  if (!participants) r.push("Nobody is in this scope yet.");
  return r;
}

// Member's value from their approvals inside the window (+ current streak for streak_days).
export function progressValue(metric, logs, { start, end, streakDays = 0 }) {
  const s = toDate(start), e = toDate(end);
  const inWindow = (logs ?? []).filter((l) => { const t = toDate(l.createdAt); return t && (!s || t >= s) && (!e || t <= e); });
  if (metric === "tasks_completed") return inWindow.length;
  if (metric === "on_time_tasks") return inWindow.filter((l) => !l.isLate).length;
  if (metric === "avg_quality") {
    const q = inWindow.map((l) => l.qualityScore).filter((x) => x != null);
    return q.length ? Math.round((q.reduce((a, b) => a + b, 0) / q.length) * 10) / 10 : 0;
  }
  if (metric === "streak_days") return streakDays;
  return 0;
}

// Average quality needs at least 3 approved tasks, so one 5-star task does not finish a 4.5-star challenge.
export const MIN_QUALITY_TASKS = 3;
export function reached(metric, value, target, taskCount = Infinity) {
  if (metric === "avg_quality") return taskCount >= MIN_QUALITY_TASKS && value >= target;
  return value >= target;
}

export const progressPct = (value, target) => (target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0);

// Status after looking at the clock and the members. Rewards already given are never taken back (FR07-06).
export function nextStatus(quest, { now = new Date(), everyoneDone = false }) {
  if (quest.status !== "active") return quest.status;
  if (everyoneDone) return "completed";
  if (quest.deadline && new Date(quest.deadline) < now) return "expired";
  return "active";
}

// Members who reached the target and have no reward yet.
export const dueRewards = (rows, rewarded) => rows.filter((r) => r.reached && !rewarded.has(String(r.userId))).map((r) => String(r.userId));

// Which fields a status allows to change.
export const editable = (status) => (status === "draft" ? "all" : status === "active" ? "title" : "none");

// New draft from an existing quest (dates cleared if they are already in the past).
export function duplicateOf(q, now = new Date()) {
  const future = q.deadline && new Date(q.deadline) > now;
  return {
    title: `${q.title} (copy)`.slice(0, 100), description: q.description ?? "", metric: q.metric, target: q.target,
    scope: q.scope, scopeRef: q.scopeRef ?? null, rewardXp: q.rewardXp, rewardGold: q.rewardGold,
    type: q.type ?? "custom", repeat: Boolean(q.repeat), sprintId: q.sprintId ?? null,
    startDate: future ? q.startDate : null, deadline: future ? q.deadline : null, status: "draft",
  };
}

// Approvals count from the later of the window start and the moment the challenge was published,
// so a weekly challenge published on Thursday does not pay for Monday's work.
export function countFrom(q) {
  const s = toDate(q.startDate), p = toDate(q.publishedAt);
  return s && p ? (p > s ? p : s) : s ?? p;
}
