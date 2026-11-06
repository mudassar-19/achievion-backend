// Who works around a task (E-3b): its Team Leads (module TL, else TLs on the project), the project's Manager and members.
// Shared by the review notice (D-184), extension / one more try (D-179, D-180) and the design handoff (D-185).
import Milestone from "../models/Milestone.js";
import Project from "../models/Project.js";
import { projectLeadIds } from "./submitRules.js";

/** "Senior Designer" → "designer"; non-employee roles → null (User.roleCategory is a virtual, lost on lean()). */
export const roleCategoryOf = (role) => /(Developer|Designer|Tester)$/.exec(role ?? "")?.[1].toLowerCase() ?? null;

export async function taskPeople(t) {
  const [milestone, project] = await Promise.all([
    t.milestoneId ? Milestone.findById(t.milestoneId, "teamLeadId").lean() : null,
    t.projectId ? Project.findById(t.projectId, "managerId members").populate("members", "role").lean() : null,
  ]);
  const members = project?.members ?? [];
  return { leads: projectLeadIds({ milestone, members }), managerId: project?.managerId ? String(project.managerId) : null, members };
}
