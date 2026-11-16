// Item 26 (D-538): recap cards from real numbers, each with a trend against the period before. Pure: numbers in, cards out.
// Tests: server/tests/recapMetrics.test.mjs. Nothing is invented: a metric without data is null and the card says so.
export function trendOf(now, before) {
  if (now == null || before == null) return null;
  const delta = Math.round((now - before) * 10) / 10;
  if (delta === 0) return { dir: "flat", delta: 0, prev: before };
  if (before === 0) return { dir: "new", delta, prev: before };
  return { dir: delta > 0 ? "up" : "down", delta, prev: before };
}

const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// cur / prev: { tasksDelivered, onTimeDone, doneWithDeadline, xpEarned, activeMembers, progressStart, progressEnd, extensions, pendingApprovals }
export function buildRecapCards(cur, prev) {
  const onTime = pctOf(cur.onTimeDone, cur.doneWithDeadline), onTimePrev = prev ? pctOf(prev.onTimeDone, prev.doneWithDeadline) : null;
  const prog = cur.progressStart != null && cur.progressEnd != null ? cur.progressEnd - cur.progressStart : null;
  const progPrev = prev && prev.progressStart != null && prev.progressEnd != null ? prev.progressEnd - prev.progressStart : null;
  const t = (a, b) => (prev ? trendOf(a, b) : null);
  const withTrend = (card, tr) => (tr ? { ...card, trend: tr } : card);
  return [
    withTrend({ title: "Tasks delivered", body: `${s(cur.tasksDelivered, "task", "tasks")} finished and approved in this period.`, metric: { value: cur.tasksDelivered, unit: "tasks" } }, t(cur.tasksDelivered, prev?.tasksDelivered)),
    withTrend({ title: "On-time delivery", body: onTime == null ? "No finished task with a deadline in this period." : `${cur.onTimeDone} of ${cur.doneWithDeadline} finished tasks were on time.`, metric: { value: onTime, unit: "%" } }, t(onTime, onTimePrev)),
    withTrend({ title: "XP earned", body: `${cur.xpEarned} XP earned by the team (task, quest and badge XP; Director corrections are not counted).`, metric: { value: cur.xpEarned, unit: "XP" } }, t(cur.xpEarned, prev?.xpEarned)),
    withTrend({ title: "Active members", body: `${s(cur.activeMembers, "person", "people")} earned XP in this period.`, metric: { value: cur.activeMembers, unit: "people" } }, t(cur.activeMembers, prev?.activeMembers)),
    withTrend({ title: "Project progress", body: prog == null ? "No tasks to measure progress on." : `Finished share of all tasks moved from ${cur.progressStart}% to ${cur.progressEnd}%.`, metric: { value: prog, unit: "points" } }, t(prog, progPrev)),
    withTrend({ title: "Extension requests", body: `${s(cur.extensions, "deadline extension was", "deadline extensions were")} requested.`, metric: { value: cur.extensions, unit: "requests" } }, t(cur.extensions, prev?.extensions)),
    { title: "Pending approvals", body: `${s(cur.pendingApprovals, "request is", "requests are")} waiting for the Director right now.`, metric: { value: cur.pendingApprovals, unit: "requests" } },
  ];
}

// "16 Nov – 22 Nov 2026": what the recap COVERS (not when it was generated).
export function periodRange(start, end) {
  const f = (d, y) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(y ? { year: "numeric" } : {}), timeZone: "UTC" });
  return `${f(start)} – ${f(end, true)}`;
}
