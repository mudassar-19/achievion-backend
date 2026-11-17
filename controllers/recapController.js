import Recap        from "../models/Recap.js";
import Organization from "../models/Organization.js";
import mongoose     from "mongoose";
import { recapCards, aiRecapSummary } from "../services/recapService.js";
import { periodRange, completedPeriodFor } from "../services/recapMetrics.js";

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
  // QA3 B-29: the Settings switch "Weekly recap" off means no recap pop-up on sign-in.
  const org = await Organization.findOne(orgFilter(orgId), "gamificationSettings.recapEnabled").lean();
  if (org?.gamificationSettings?.recapEnabled === false) return res.json({ items: [] });
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

const LABEL = { weekly: "Weekly recap", monthly: "Monthly recap", yearly: "Yearly recap" };

// ── POST /api/director/recaps/generate { type, summary? } — generate a recap now ─
// Item 26 (D-538): real numbers (tasks delivered, on-time %, XP, active members, progress change, extensions, pending approvals)
// each with a trend against the period before, and an optional short AI summary of those numbers (advisory, no names in it).
// A failing AI never fails the recap: it is saved without a summary and `aiNote` says why.
export async function generateRecap(req, res) {
  const { orgId, id: userId } = req.user;
  const type = ["weekly", "monthly", "yearly"].includes(req.body?.type) ? req.body.type : "weekly";

  const org = await Organization.findOne(orgFilter(orgId), "_id orgId").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const period = completedPeriodFor(type); // QA3 G-17: only a period that has ended; never the running week
  const range = periodRange(period.start, period.end);
  const periodLabel = type === "weekly"
    ? `Week of ${new Date(period.start).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`
    : type === "monthly" ? period.start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : `${period.start.getUTCFullYear()}`;
  const cards = await recapCards(org, period);

  let aiSummary = null, aiNote = null;
  if (req.body?.summary !== false) {
    const r = await aiRecapSummary({ orgId, userId, periodLabel: `${LABEL[type]}, ${range}`, cards });
    if (r.text) aiSummary = r.text;
    else aiNote = r.error === "not_configured" ? "AI is not configured, so there is no AI summary." : r.error === "cap" ? "The daily AI limit is reached, so there is no AI summary." : "The AI is busy right now, so there is no AI summary. Press Generate again to retry.";
  }

  // QA3 G-17: one period = one recap. Asking again refreshes the same recap instead of adding a second "Week 44".
  const seen = { userId: new mongoose.Types.ObjectId(userId), seenAt: new Date() };
  const recap = await Recap.findOneAndUpdate({ orgId, type, periodStart: period.start },
    { $set: { periodLabel, periodRange: range, periodEnd: period.end, cards, aiSummary }, $setOnInsert: { seenBy: [seen] } }, { upsert: true, new: true });
  res.status(201).json({ recap, aiNote });
}
