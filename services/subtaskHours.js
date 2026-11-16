// Item 51 (D-526): subtask hours may not add up to more than the parent's estimate. Pure. Tests: tests/subtaskHours.test.mjs.
const sum = (a) => a.reduce((s, x) => s + (Number(x) || 0), 0);

// parentHours: the parent's estimate (null/0 = none, no limit). siblingHours: the other subtasks' estimates. newHours: this subtask's.
export function subtaskHoursError({ parentHours, siblingHours = [], newHours }) {
  if (!(Number(parentHours) > 0) || !(Number(newHours) > 0)) return null;
  const total = sum(siblingHours) + Number(newHours);
  return total > parentHours ? `Raise the parent's estimate first. The subtasks would add up to ${total} h, the parent has ${parentHours} h.` : null;
}

// Changing the parent's own estimate: it may not drop below what its subtasks already add up to.
export function parentHoursError({ newParentHours, childHours = [] }) {
  const total = sum(childHours);
  return Number(newParentHours) > 0 && total > newParentHours ? `Raise the parent's estimate first: its subtasks add up to ${total} h.` : null;
}
