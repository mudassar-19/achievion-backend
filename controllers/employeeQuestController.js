// Employee quest board (Batch 3: E13; UC-17, FR07-03/05/06). Developers, Designers and Testers only (routes/workspaceRoutes.js).
// Rules: services/questJoinRules.js. Joining only adds the person to the quest; progress and the reward stay on the one
// existing path (questService.refreshQuest → gamificationService.applyQuestReward, one ledger row per person per quest).
// A card holds the reader's own progress only: no other person's numbers, no AI score (D-075).
import Quest from "../models/Quest.js";
import AuditLog from "../models/AuditLog.js";
import { orgScope } from "./managerProjectsController.js";
import { resolveParticipants, refreshQuest, evaluateQuestsForUser } from "../services/questService.js";
import { joinVerdict, boardOf, questView, isOpen } from "../services/questJoinRules.js";
import { BADGE_DEFINITIONS } from "../services/gamificationService.js"; // read only: the badge's name for the card

const badgeOf = (id) => BADGE_DEFINITIONS.find((b) => b.id === id) ?? null;

const OID = /^[0-9a-f]{24}$/i;
const idsOf = (scope) => scope.filter.orgId.$in;
// ponytail: one small query per quest that is open to join; cache the scope lists if an org ever runs hundreds at once.
const inScope = async (q, userId, ids) => (await resolveParticipants(q, ids)).some((u) => String(u) === String(userId));

// ── GET /api/workspace/quests → { open, mine, finished } ─────────────────────
export async function listMyQuests(req, res) {
  const scope = await orgScope(req.user.orgId);
  if (!scope) return res.status(404).json({ error: "Organization not found." });
  const me = req.user.id, ids = idsOf(scope), now = new Date();
  if (!req.viewAs) await evaluateQuestsForUser(me).catch((e) => console.error("[quests] refresh:", e.message)); // live progress, expiry; View as is read-only (D-109)
  const quests = await Quest.find({ orgId: { $in: ids }, status: { $ne: "draft" }, $or: [{ participants: me }, { entry: "join", status: "active", deadline: { $gt: now } }] })
    .sort({ deadline: 1 }).limit(200).lean();
  const eligible = new Map();
  for (const q of quests) if (!q.participants.some((p) => String(p) === String(me)) && isOpen(q, now)) eligible.set(String(q._id), await inScope(q, me, ids));
  res.json(boardOf(quests, { userId: me, kind: req.user.roleCategory, eligible: (q) => eligible.get(String(q._id)) ?? false, now, badgeOf }));
}

// ── POST /api/workspace/quests/:questId/join ─────────────────────────────────
// Idempotent: a second join answers 200 { already: true } and changes nothing ($addToSet, one entry per person).
export async function joinQuest(req, res) {
  const id = String(req.params.questId ?? "");
  if (!OID.test(id)) return res.status(400).json({ error: "That is not a quest id." });
  const scope = await orgScope(req.user.orgId);
  if (!scope) return res.status(404).json({ error: "Organization not found." });
  const me = req.user.id, ids = idsOf(scope);
  const quest = await Quest.findOne({ _id: id, orgId: { $in: ids } });
  const v = joinVerdict({ quest, role: req.user.role, userId: me, eligible: quest ? await inScope(quest, me, ids) : false });
  if (!v.ok) return res.status(v.status).json({ error: v.error });
  let fresh = quest;
  if (!v.already) {
    // The filter repeats the rules, so a quest that closed a moment ago is not joined.
    const saved = await Quest.findOneAndUpdate({ _id: id, status: "active", entry: "join", deadline: { $gt: new Date() } }, { $addToSet: { participants: me } }, { returnDocument: "after" });
    if (!saved) return res.status(409).json({ error: "This quest has ended, so it can no longer be joined." });
    AuditLog.create({ action: "quest_joined", orgId: scope.org._id, performedBy: me, detail: `Joined the challenge "${saved.title}".` }).catch((e) => console.error("[audit]", e.message));
    fresh = await refreshQuest(saved, { orgIds: ids }); // progress from the ledger; a reward, if due, goes through applyQuestReward
  }
  res.json({ joined: true, already: v.already, quest: questView(fresh.toObject?.() ?? fresh, me, req.user.roleCategory, new Date(), badgeOf) });
}
