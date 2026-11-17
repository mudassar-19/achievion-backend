// QA2 items 68, 69, 71, 72: when may work happen on a task? Pure rules; the controllers answer 409 with `message`.
// Planning is allowed at any time (creating and assigning tasks). Doing (start, time log, submit) is not allowed
// until the Manager has started the project and the Team Lead has accepted the module.

// A task in review or done takes no more time (fair scoring, no hours inflation).
export function timeLogLock(task) {
  return ["In-Review", "Done"].includes(task?.status)
    ? { code: "task_locked", message: task.status === "Done" ? "This task is done. Time can no longer be logged on it." : "This task is in review. Time can no longer be logged on it." }
    : null;
}

// Start, time log and submit. Only a project that is still in Planning, or a module that is new (not accepted and still Pending),
// is locked; any other project or module, including old data already in progress, is never locked.
export function executionLock({ project, milestone }) {
  if (project?.status === "Planning") return { code: "project_not_started", message: "The Manager has not started this project yet. You can plan and assign tasks now; work begins when the project is started." };
  if (milestone && !milestone.tlAcceptedAt && (milestone.status ?? "Pending") === "Pending") return { code: "module_not_accepted", message: "The Team Lead has not accepted this module yet. You can plan and assign tasks now; work begins when the module is accepted." };
  return null;
}

// Submitting a task that is already waiting for review is a success (a double click or a second request), not an error.
export const alreadySubmitted = (task) => task?.status === "In-Review";
