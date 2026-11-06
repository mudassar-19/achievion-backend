// Task link rules (V1 1.9) — pure, no DB. Tests: server/tests/taskRules.test.mjs.
export const MAX_DEPENDENCIES = 10;

// Prerequisites that still block starting/submitting (anything not Done).
export function unfinishedPrereqs(prereqs = []) {
  return prereqs.filter((t) => t?.status !== "Done");
}

// graph: { taskId: [prerequisiteIds] }. Returns the cycle path if `taskId` → newDeps closes one, else null.
export function findDependencyCycle(taskId, newDeps, graph) {
  const start = String(taskId);
  const seen = new Set();
  const walk = (node, path) => {
    if (node === start) return [...path, node];
    if (seen.has(node)) return null;
    seen.add(node);
    for (const next of graph[node] ?? []) {
      const hit = walk(String(next), [...path, node]);
      if (hit) return hit;
    }
    return null;
  };
  for (const d of newDeps) {
    const hit = walk(String(d), [start]);
    if (hit) return hit;
  }
  return null;
}

// Shape checks that need no DB. `parent` is the loaded parent task (or undefined).
export function linkErrors({ selfId, parentId, dependsOn = [], parent } = {}) {
  const self = selfId ? String(selfId) : null;
  if (self && parentId && String(parentId) === self) return "A task cannot be its own parent.";
  if (self && dependsOn.some((d) => String(d) === self)) return "A task cannot depend on itself.";
  if (new Set(dependsOn.map(String)).size > MAX_DEPENDENCIES) return `At most ${MAX_DEPENDENCIES} prerequisites per task.`;
  if (parent?.parentId) return "Subtasks cannot have their own subtasks (one level only).";
  return null;
}
