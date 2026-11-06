/**
 * Saved Portfolio Views — per-Director named filter sets.
 * GET  /api/director/portfolio/views          → list
 * POST /api/director/portfolio/views          → create
 * PATCH  /api/director/portfolio/views/:id    → update name/filters
 * DELETE /api/director/portfolio/views/:id    → delete
 */
import SavedPortfolioView from "../models/SavedPortfolioView.js";
import AuditLog           from "../models/AuditLog.js";

function auditEntry(orgId, performedBy, action, detail) {
  return AuditLog.create({ orgId, performedBy, action, detail: JSON.stringify(detail), scope: "account" }).catch(() => {});
}

export async function listViews(req, res) {
  const { orgId, id: userId } = req.user;
  const views = await SavedPortfolioView.find({ orgId, userId }).sort({ updatedAt: -1 }).lean();
  res.json(views.map((v) => ({ id: v._id, name: v.name, filters: v.filters, updatedAt: v.updatedAt })));
}

export async function createView(req, res) {
  const { orgId, id: userId } = req.user;
  const { name, filters }     = req.body;

  if (!name?.trim()) return res.status(400).json({ error: "name is required." });

  const view = await SavedPortfolioView.create({ orgId, userId, name: name.trim(), filters: filters ?? {} });
  auditEntry(orgId, userId, "portfolio_view_saved", { viewId: String(view._id), name: view.name });
  res.status(201).json({ id: view._id, name: view.name, filters: view.filters });
}

export async function updateView(req, res) {
  const { orgId, id: userId } = req.user;
  const { id }                = req.params;
  const { name, filters }     = req.body;

  const update = {};
  if (name !== undefined) { if (!name?.trim()) return res.status(400).json({ error: "name cannot be empty." }); update.name = name.trim(); }
  if (filters !== undefined) update.filters = filters;
  if (!Object.keys(update).length) return res.status(400).json({ error: "Nothing to update." });

  const view = await SavedPortfolioView.findOneAndUpdate({ _id: id, orgId, userId }, { $set: update }, { returnDocument: "after" }).lean();
  if (!view) return res.status(404).json({ error: "View not found." });
  auditEntry(orgId, userId, "portfolio_view_updated", { viewId: view._id, name: view.name });
  res.json({ id: view._id, name: view.name, filters: view.filters });
}

export async function deleteView(req, res) {
  const { orgId, id: userId } = req.user;
  const { id }                = req.params;

  const view = await SavedPortfolioView.findOneAndDelete({ _id: id, orgId, userId }).lean();
  if (!view) return res.status(404).json({ error: "View not found." });
  auditEntry(orgId, userId, "portfolio_view_deleted", { viewId: view._id, name: view.name });
  res.json({ ok: true });
}
