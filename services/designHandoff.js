// Q10 / DS-04 (E-3b, D-185): when a design task is approved, its links, files and handoff note are attached read-only to the
// linked developer tasks (tasks that wait for it through dependsOn and have a developer on them). No XP, no status change.
// Listens to the same "task.approved" event as the XP engine, without touching it.
import Task from "../models/Task.js";
import User from "../models/User.js";
import { createNotification } from "../controllers/notificationController.js";
import { isDesignTask, handoffTargets, handoffEntry } from "./submitRules.js";
import { roleCategoryOf } from "./taskPeople.js";

const people = (t) => [...new Set([...(t.assignees ?? []), ...(t.assignee ? [t.assignee] : [])].map(String))]; // one entry per person (E-4: was two notifications when assignee is also in assignees)

export async function handOverDesign(taskId) {
  const t = await Task.findById(taskId, "title type orgId status assignees assignee submissionLinks submissionFiles submissionHandoff").lean();
  if (!t || t.status !== "Done") return 0;
  const designers = await User.find({ _id: { $in: people(t) } }, "name role").lean();
  if (!isDesignTask(t, designers.map((u) => roleCategoryOf(u.role)))) return 0;
  const dependents = await Task.find({ orgId: t.orgId, dependsOn: t._id }, "title status assignees assignee").lean();
  if (!dependents.length) return 0;
  const users = await User.find({ _id: { $in: [...new Set(dependents.flatMap(people))] } }, "role").lean();
  const categoryOf = new Map(users.map((u) => [String(u._id), roleCategoryOf(u.role)]));
  const entry = handoffEntry(t, designers.find((u) => roleCategoryOf(u.role) === "designer")?.name ?? designers[0]?.name);
  if (!entry) return 0;
  let n = 0;
  for (const d of handoffTargets(dependents, categoryOf)) {
    // Once per design per task, also when "task.approved" is emitted twice.
    const r = await Task.updateOne({ _id: d._id, "designHandoffs.fromTask": { $ne: t._id } }, { $push: { designHandoffs: entry } });
    if (!r.modifiedCount) continue;
    n++;
    Task.logActivity(d._id, null, "edited", { note: `Design handed over from "${t.title}"` });
    await Promise.all(people(d).filter((id) => categoryOf.get(id) === "developer").map((uid) => createNotification({ userId: uid, orgId: t.orgId, type: "design_handoff", title: "Design ready for your task",
      message: `"${t.title}" was approved. Its files and handoff note are on "${d.title}" under From design.`, meta: { taskId: d._id, fromTaskId: t._id } }).catch(() => {})));
  }
  return n;
}

export function registerDesignHandoff(emitter) {
  emitter.on("task.approved", ({ taskId }) => { handOverDesign(taskId).catch((e) => console.error("[design handoff]", e.message)); });
}
