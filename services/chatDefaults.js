// D-QA3B-5 (runbook decision 3): every community has exactly three default groups: Announcements (admins post), General (all members) and
// Leadership (Director + Managers). #random and department groups are NOT seeded (a leader can make them with "New group").
// Pure: tests/chatDefaults.test.mjs.
export const DEFAULT_GROUPS = [
  { name: "announcements", icon: "megaphone", type: "announcement", description: "Official announcements. Everyone reads; Director and Manager post.", send: "admins" },
  { name: "general", icon: "chat", type: "general", description: "Open chat for everyone.", send: "everyone" },
  { name: "leadership", icon: "shield", type: "custom", description: "Director and Managers.", send: "everyone", leadersOnly: true },
];

// Which of the three still need creating, given the names that exist. `prefix` ("fleettrack-") is used for project communities.
export const missingDefaults = (existingNames = [], prefix = "") => {
  const have = new Set(existingNames);
  return DEFAULT_GROUPS.filter((d) => !have.has(`${prefix}${d.name}`)).map((d) => ({ ...d, name: `${prefix}${d.name}` }));
};

// Members of a default group: everyone in the community, or only leaders for Leadership. Leaders are always included.
export const defaultMembers = (def, { memberIds = [], leaderIds = [] }) =>
  [...new Set((def.leadersOnly ? leaderIds : [...memberIds, ...leaderIds]).map(String))];

// The community's name must follow the project (E-8): a project community keeps the project's title.
export const isProjectCommunity = (c) => c?.type === "project" && !!c?.projectId;
// A project community can be deactivated only when its project is over (E-8).
export const canDeactivateCommunity = (c, projectStatus) => !isProjectCommunity(c) || ["Completed", "Archived", "Deleted"].includes(projectStatus);
