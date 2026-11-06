import Recap        from "../models/Recap.js";
import Task         from "../models/Task.js";
import Project      from "../models/Project.js";
import Organization from "../models/Organization.js";
import mongoose     from "mongoose";

const IS_OID   = /^[0-9a-f]{24}$/i;
const orgFilter = (orgId) => IS_OID.test(orgId) ? { _id: orgId } : { orgId };

// ── GET /api/director/recaps  — archived list ────────────────────────────────
export async function listRecaps(req, res) {
  const { orgId } = req.user;
  const { page = 1, limit = 20 } = req.query;
  const [items, total] = await Promise.all([
    Recap.find({ orgId })
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean(),
    Recap.countDocuments({ orgId }),
  ]);
  res.json({ items, total, page: Number(page) });
}

// ── GET /api/director/recaps/pending  — unseen, for popup (FL-05) ────────────
export async function pendingRecaps(req, res) {
  const { orgId, id: userId } = req.user;
  const oid = new mongoose.Types.ObjectId(userId);
  const items = await Recap.find({
    orgId,
    "seenBy.userId": { $ne: oid },
  }).sort({ createdAt: -1 }).lean();
  res.json({ items });
}

// ── POST /api/director/recaps/:id/seen ───────────────────────────────────────
export async function markSeen(req, res) {
  const { orgId, id: userId } = req.user;
  const recap = await Recap.findById(req.params.id);
  if (!recap || recap.orgId !== orgId) return res.status(404).json({ error: "Recap not found." });

  const oid = new mongoose.Types.ObjectId(userId);
  if (!recap.seenBy.some((s) => s.userId.equals(oid))) {
    recap.seenBy.push({ userId: oid, seenAt: new Date() });
    await recap.save();
  }
  res.json({ ok: true });
}

// ── POST /api/director/recaps/generate  — generate a recap on demand ─────────
// Computes real aggregates (D-016: no hollow data)
export async function generateRecap(req, res) {
  const { orgId, id: userId } = req.user;
  const { type = "weekly" } = req.body ?? {};

  const org = await Organization.findOne(orgFilter(orgId), "_id orgId").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const now       = new Date();
  let periodStart, periodEnd, periodLabel;

  if (type === "weekly") {
    const day    = now.getDay();
    const diff   = (day === 0 ? -6 : 1) - day;
    periodStart  = new Date(now); periodStart.setDate(now.getDate() + diff); periodStart.setHours(0,0,0,0);
    periodEnd    = new Date(periodStart); periodEnd.setDate(periodStart.getDate() + 6); periodEnd.setHours(23,59,59,999);
    const wn     = Math.ceil(((periodStart - new Date(periodStart.getFullYear(), 0, 1)) / 86400000 + 1) / 7);
    periodLabel  = `Week ${wn} (${periodStart.toLocaleDateString("en-GB",{day:"2-digit",month:"short"})}–${periodEnd.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})})`;
  } else if (type === "monthly") {
    periodStart  = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    periodEnd    = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999));
    periodLabel  = periodStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  } else {
    periodStart  = new Date(Date.UTC(now.getFullYear(), 0,  1));
    periodEnd    = new Date(Date.UTC(now.getFullYear(), 11, 31, 23, 59, 59, 999));
    periodLabel  = `${now.getFullYear()} Annual Recap`;
  }

  // Build cards from real aggregates
  const dateFilter = { createdAt: { $gte: periodStart, $lte: periodEnd } };
  const [projectsCompleted, tasksCompleted, tasksOverdue, avgQuality] = await Promise.all([
    Project.countDocuments({ orgId: org._id.toString(), status: "Completed", updatedAt: { $gte: periodStart, $lte: periodEnd } }),
    Task.countDocuments({ orgId: org._id.toString(), status: "Done", completedAt: { $gte: periodStart, $lte: periodEnd } }),
    Task.countDocuments({ orgId: org._id.toString(), status: { $nin: ["Done"] }, deadline: { $lt: now } }),
    Task.aggregate([
      { $match: { orgId: org._id.toString(), qualityScore: { $ne: null }, completedAt: { $gte: periodStart, $lte: periodEnd } } },
      { $group: { _id: null, avg: { $avg: "$qualityScore" } } },
    ]),
  ]);

  const qualityAvg = avgQuality[0]?.avg ?? null;

  const cards = [
    { title: "Projects Completed", body: `${projectsCompleted} project${projectsCompleted !== 1 ? "s" : ""} completed this period.`, metric: { value: projectsCompleted, unit: "projects" } },
    { title: "Tasks Delivered",    body: `${tasksCompleted} task${tasksCompleted !== 1 ? "s" : ""} completed.`,                     metric: { value: tasksCompleted,   unit: "tasks" } },
    { title: "Overdue Tasks",      body: `${tasksOverdue} task${tasksOverdue !== 1 ? "s" : ""} currently overdue.`,                 metric: { value: tasksOverdue,     unit: "tasks" } },
    ...(qualityAvg !== null ? [{ title: "Average Quality Score", body: `Mean quality score: ${qualityAvg.toFixed(2)}/5.`, metric: { value: qualityAvg, unit: "score" } }] : []),
  ];

  const recap = await Recap.create({
    orgId, type, periodLabel, periodStart, periodEnd,
    cards,
    seenBy: [{ userId: new mongoose.Types.ObjectId(userId), seenAt: new Date() }],
  });

  res.status(201).json({ recap });
}
