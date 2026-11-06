// S-1 (D-157..D-160): who may read a task, list reviews, open a file. Pure, no DB.
import crypto from "crypto";

export const EMPLOYEE_CATEGORIES = ["developer", "designer", "tester"];
export const isEmployee = (user) => EMPLOYEE_CATEGORIES.includes(user?.roleCategory);
const same = (a, b) => a != null && b != null && String(a) === String(b);
const inList = (list, id) => (list ?? []).some((x) => same(x?._id ?? x, id));
const isMember = (project, id) => inList(project?.members, id);
const worksOn = (task, id) => inList(task?.assignees, id) || same(task?.assignee?._id ?? task?.assignee, id);
const gaveIt = (task, id) => same(task?.createdBy?._id ?? task?.createdBy, id) || same(task?.assignedBy?._id ?? task?.assignedBy, id);

// Assignee, the person who gave the task (a Senior to a Junior), or a member of its project (read only).
export const employeeCanReadTask = (user, task, project) => worksOn(task, user.id) || gaveIt(task, user.id) || isMember(project, user.id);

// null = 403. "senior" = own projects' junior tasks. "all" = the caller's scope as before.
export function reviewListAccess(user) {
  if (!isEmployee(user)) return "all";
  return /^Senior /.test(user.role ?? "") ? "senior" : null;
}

// FR03-09: the model has no assigned-reviewer field, so a Senior reviews inside projects they are on.
export const seniorMayReview = (userId, project) => isMember(project, userId);

export function canOpenFile(user, { task = null, project = null }) {
  if (user.role === "Director") return !!(task || project);
  if (user.role === "Manager") return same(project?.managerId?._id ?? project?.managerId, user.id) || gaveIt(task, user.id);
  if (user.role === "Team Lead") return isMember(project, user.id) || worksOn(task, user.id) || gaveIt(task, user.id);
  return employeeCanReadTask(user, task, project);
}

// E-3b (D-185): one file can sit on several tasks (the design's submission and the developer tasks it was handed to).
// The person may open it when they may open any of them; each pair is { task, project } as canOpenFile takes it.
export const mayOpenAny = (user, places) => places.some((p) => canOpenFile(user, p));

export const isTeamMember = (team, userId) => (team?.members ?? []).some((m) => m.isActive && same(m.userId?._id ?? m.userId, userId));

// D-156-1: the department does not matter; the project does.
export function tlAssignBlock(assignee, project) {
  if (!project) return "Pick a project before assigning this task.";
  if (!EMPLOYEE_CATEGORIES.includes(assignee.roleCategory)) return "A Team Lead assigns tasks to Developers, Designers and Testers.";
  if (!isMember(project, assignee.id)) return "Everyone you assign must be on this project.";
  return null;
}

// ── Signed file links ────────────────────────────────────────────────────────
export const FILE_LINK_SECONDS = 300;
const SAFE_PATH = /^\/uploads\/(submissions|attachments)\/[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9]+)*$/;
export const isSafeUploadPath = (p) => typeof p === "string" && SAFE_PATH.test(p);

const envSecret = () => process.env.JWT_SECRET;
const mac = (path, exp, secret) => crypto.createHmac("sha256", `file-link:${secret}`).update(`${path}|${exp}`).digest("hex");

export function signFilePath(path, { now = Date.now(), secret = envSecret() } = {}) {
  const exp = Math.floor(now / 1000) + FILE_LINK_SECONDS;
  return { exp, sig: mac(path, exp, secret) };
}

// "ok" | "expired" | "bad". The signature is checked first, so nobody learns anything from a forged expiry.
export function verifyFileLink(path, { exp, sig } = {}, { now = Date.now(), secret = envSecret() } = {}) {
  if (typeof sig !== "string" || !/^\d+$/.test(String(exp)) || Array.isArray(exp)) return "bad";
  const want = Buffer.from(mac(path, String(exp), secret)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return "bad";
  return Number(exp) * 1000 < now ? "expired" : "ok";
}

// ── Private Cloudinary files (S-2, D-164) ────────────────────────────────────
// A task stores the URL without Cloudinary's s--…-- signature: that signature never expires. Only type "authenticated" matches;
// older public files (type "upload") are left as they are.
const CLD_URL = /^https:\/\/res\.cloudinary\.com\/([\w-]+)\/(image|video|raw)\/authenticated\/(?:s--[\w-]+--\/)?(?:v\d+\/)?([\w./-]+)$/;
export function parseCloudinaryUrl(url) {
  const m = typeof url === "string" ? CLD_URL.exec(url) : null;
  if (!m || m[3].split("/").includes("..")) return null;
  const [, cloud, resourceType, rest] = m;
  if (resourceType === "raw") return { cloud, resourceType, publicId: rest, format: undefined };
  const dot = rest.lastIndexOf(".");
  return dot > rest.lastIndexOf("/") ? { cloud, resourceType, publicId: rest.slice(0, dot), format: rest.slice(dot + 1) } : { cloud, resourceType, publicId: rest, format: undefined };
}
export const stripCloudinarySignature = (url) => String(url).replace(/(\/authenticated\/)s--[\w-]+--\//, "$1");

// S13: the same list as Cloudinary's allowed_formats, also for files kept on disk.
export const SUBMISSION_FORMATS = ["jpg", "jpeg", "png", "pdf", "zip", "docx", "xlsx", "txt", "md"];
export const isAllowedSubmissionFile = (name) => typeof name === "string" && SUBMISSION_FORMATS.includes(/\.([^.]+)$/.exec(name)?.[1]?.toLowerCase());

// ── S-3 (D-167) ──────────────────────────────────────────────────────────────
// S8: the department decides nothing for assigning any more (D-160), but it is the Director's to set.
export const selfUpdateError = (body, _role) => (body?.department !== undefined ? "Your department is set by your Director." : null);

// S9: same table as client/src/pages/workspace/AvatarPage.jsx (keep both in step).
const AVATAR_LOCKS = {
  style: { adventurer: { level: 5 }, lorelei: { level: 5 }, thumbs: { level: 5 }, micah: { level: 5 }, avataaars: { level: 10 }, miniavs: { level: 10 }, notionists: { level: 10 },
    croodles: { level: 20, streak: 30 }, "open-peeps": { level: 15, badge: "speed_demon" } },
  visualStyle: { futuristic: { level: 5 }, gamer: { level: 7 }, shadow: { level: 8 }, neon: { level: 10 } },
  preset: { titan: { level: 3 }, warrior: { level: 5 }, hacker: { level: 5 }, eclipse: { level: 6 }, shadow: { level: 8 }, nova: { level: 10 } },
  effects: { glow: { level: 3 }, pulse: { level: 5 }, aura: { level: 8 }, particle: { level: 15 } },
};
export function avatarLockError(cfg, unlock) {
  const picks = [["style", cfg.style], ["visualStyle", cfg.visualStyle], ["preset", cfg.preset], ...(cfg.effects ?? []).map((e) => ["effects", e])];
  for (const [kind, key] of picks) {
    const lock = key != null ? AVATAR_LOCKS[kind][key] : null;
    if (!lock) continue;
    if ((unlock.level ?? 1) < lock.level) return `"${key}" unlocks at Level ${lock.level}.`;
    if (lock.streak && (unlock.streak ?? 0) < lock.streak) return `"${key}" needs a ${lock.streak}-day streak.`;
    if (lock.badge && !(unlock.badges ?? []).includes(lock.badge)) return `"${key}" needs the ${lock.badge.replace("_", " ")} badge.`;
  }
  return null;
}

// S10: people pickers. Leads add people by email; others see names and roles only.
export const coworkerFields = (role) => (["Director", "Manager", "Team Lead"].includes(role) ? "name role email avatarStyle avatarSeed department" : "name role avatarStyle avatarSeed department");

// S11: Mongoose throws a CastError for a malformed id.
export function errorStatus(err) {
  if (err?.name === "CastError") return err.kind === "ObjectId" && err.path === "_id" ? 404 : 400;
  return err?.status ?? err?.statusCode ?? 500;
}

// S12: the task's people: assignees, creator, project members (Team Lead included) and the project's Manager.
export const taskEventAudience = (task, project) => [...new Set([...(task.assignees ?? []), task.assignee, task.createdBy, ...(project?.members ?? []), project?.managerId]
  .filter(Boolean).map((x) => String(x?._id ?? x)))];
