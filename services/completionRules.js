// C-1/C-2/C-3: when a project or module may be Completed, what a finished project's health says, module overdue.
// Pure (no DB). Tests: server/tests/qa3CompletionRules.test.mjs.
export const CLOSED_PROJECT = ["Completed", "Archived"];
const DAY = 86_400_000;

/** Reasons a project/module cannot be Completed yet. Empty list = it may. */
export function completionBlockers({ openTasks = 0, openRisks = 0 } = {}) {
  const out = [];
  if (openTasks > 0) out.push(`${openTasks} task${openTasks === 1 ? " is" : "s are"} still open (finish them, or close with open tasks and give a reason).`);
  if (openRisks > 0) out.push(`${openRisks} risk${openRisks === 1 ? " is" : "s are"} still open.`);
  return out;
}

/** Frozen health of a finished project: green or neutral, never red. */
export function frozenHealth({ deadline, completedAt, now = new Date() }) {
  const done = completedAt ? +new Date(completedAt) : +new Date(now);
  const due = deadline ? +new Date(deadline) : NaN;
  const daysLate = Number.isFinite(due) && done > due + DAY - 1 ? Math.ceil((done - (due + DAY - 1)) / DAY) : 0; // the deadline day counts as on time
  return { score: 100, band: "Completed", daysLate, note: daysLate ? `Completed ${daysLate} day${daysLate === 1 ? "" : "s"} late` : "Completed on time" };
}

/** A task due date may not be after the end of its module. */
export const dueAfterModuleEnd = (due, moduleEnd) => !!(due && moduleEnd && +new Date(due) > +new Date(moduleEnd) + DAY - 1);

/** Whole days a running module is past its end date (0 when not overdue or finished). */
export function moduleOverdueDays({ endDate, status }, now = new Date()) {
  if (!endDate || status === "Completed") return 0;
  const d = Math.floor((+new Date(now) - (+new Date(endDate) + DAY)) / DAY) + 1;
  return d > 0 ? d : 0;
}

// QA4 M-43: the date hierarchy task due <= module due <= project due (the task side is in taskDueError). Dates may be strings or Dates.
export function moduleDateError({ start, due }, projectDeadline) {
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null), s = day(start), e = day(due), p = day(projectDeadline);
  if (s && e && e < s) return "A module cannot end before it starts.";
  if (e && p && e > p) return `A module cannot end after the project's deadline (${p}). Extend the project first.`;
  return null;
}
