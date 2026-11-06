import Project      from "../models/Project.js";
import Task         from "../models/Task.js";
import User         from "../models/User.js";
import Organization from "../models/Organization.js";
import { createRequire } from "module";
import { healthForProjects } from "../services/projectHealthService.js";
const _require = createRequire(import.meta.url);
const PDFDocument = _require("pdfkit");

const IS_OID   = /^[0-9a-f]{24}$/i;
const orgFilter = (orgId) => IS_OID.test(orgId) ? { _id: orgId } : { orgId };

// ── GET /api/director/reports/portfolio  — portfolio status ───────────────────
export async function reportPortfolio(req, res) {
  const { orgId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "orgId _id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const projects = await Project.find({ orgId: org._id.toString() })
    .select("title status priority deadline managerId xpPool startDate createdAt")
    .lean();
  const health = await healthForProjects(projects); // computed, never the stored value (D-077)

  const summary = {};
  for (const p of projects) {
    summary[p.status] = (summary[p.status] ?? 0) + 1;
  }

  res.json({
    rows:    projects.map((p) => ({
      id:          p._id,
      title:       p.title,
      status:      p.status,
      priority:    p.priority,
      deadline:    p.deadline,
      healthScore: health.get(String(p._id))?.score ?? null,
      healthBand:  health.get(String(p._id))?.band ?? null,
    })),
    summary,
    total: projects.length,
  });
}

// ── GET /api/director/reports/delivery  — on-time delivery rate ───────────────
export async function reportDelivery(req, res) {
  const { orgId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "orgId _id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const { from, to } = req.query;
  const dateFilter = {};
  if (from) dateFilter.$gte = new Date(from);
  if (to)   dateFilter.$lte = new Date(to);
  const completedFilter = {
    orgId: org._id.toString(),
    status: "Done",
    ...(Object.keys(dateFilter).length ? { completedAt: dateFilter } : {}),
  };

  const [onTime, total] = await Promise.all([
    Task.countDocuments({ ...completedFilter, $expr: { $lte: ["$completedAt", "$deadline"] } }),
    Task.countDocuments(completedFilter),
  ]);
  const rate = total > 0 ? Math.round((onTime / total) * 100) : null;

  res.json({ onTime, total, rate, from: from ?? null, to: to ?? null });
}

// ── GET /api/director/reports/capacity  — team capacity snapshot ──────────────
export async function reportCapacity(req, res) {
  const { orgId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId), "orgId _id").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  const [activeCount, overloadedCount, openTasks, members] = await Promise.all([
    User.countDocuments({ orgId, status: { $ne: "deleted" } }),
    Task.aggregate([
      { $match: { orgId, status: { $nin: ["Done"] } } },
      { $group: { _id: "$assignee", taskCount: { $sum: 1 } } },
      { $match: { taskCount: { $gt: 3 } } },
      { $count: "n" },
    ]),
    Task.countDocuments({ orgId, status: { $nin: ["Done"] } }),
    User.countDocuments({ orgId, status: { $ne: "deleted" } }),
  ]);

  res.json({
    totalMembers: activeCount,
    overloadedMembers: overloadedCount[0]?.n ?? 0,
    openTasks,
    avgTasksPerMember: members > 0 ? Math.round(openTasks / members) : 0,
  });
}

// ── GET /api/director/reports/export  — CSV export ────────────────────────────
export async function exportReport(req, res) {
  const { orgId } = req.user;
  const { type = "portfolio", format = "csv" } = req.query;
  const org = await Organization.findOne(orgFilter(orgId), "orgId _id name").lean();
  if (!org) return res.status(404).json({ error: "Org not found." });

  let rows = [];
  let headers = [];

  if (type === "portfolio") {
    const projects = await Project.find({ orgId: org._id.toString() })
      .select("title status priority deadline startDate createdAt").lean();
    const health = await healthForProjects(projects);
    headers = ["Title","Status","Priority","Deadline","HealthScore"];
    rows    = projects.map((p) => [p.title, p.status, p.priority ?? "", p.deadline?.toISOString()?.split("T")[0] ?? "", health.get(String(p._id))?.score ?? ""]);
  } else if (type === "delivery") {
    const tasks = await Task.find({
      orgId, status: "Done",
    }).select("title deadline completedAt").lean();
    headers = ["Task","Deadline","CompletedAt","OnTime"];
    rows    = tasks.map((t) => [
      t.title,
      t.deadline?.toISOString()?.split("T")[0] ?? "",
      t.completedAt?.toISOString()?.split("T")[0] ?? "",
      (t.deadline && t.completedAt && t.completedAt <= t.deadline) ? "Yes" : "No",
    ]);
  } else {
    return res.status(400).json({ error: "type must be portfolio|delivery" });
  }

  if (format === "pdf") {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="report-${type}-${Date.now()}.pdf"`);
    doc.pipe(res);
    doc.fontSize(16).font("Helvetica-Bold").text(`${type.charAt(0).toUpperCase() + type.slice(1)} Report`, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(10).font("Helvetica").text(`Generated: ${new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})}  |  Org: ${org.name ?? orgId}`, { align: "center" });
    doc.moveDown(1);
    // Header row
    const colW = Math.floor((doc.page.width - 80) / headers.length);
    let x = 40, y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9);
    headers.forEach((h) => { doc.text(h, x, y, { width: colW, lineBreak: false }); x += colW; });
    doc.moveDown(0.4);
    doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke();
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8);
    for (const row of rows) {
      if (doc.y > doc.page.height - 60) doc.addPage();
      x = 40; y = doc.y;
      row.forEach((cell) => { doc.text(String(cell), x, y, { width: colW, lineBreak: false }); x += colW; });
      doc.moveDown(0.4);
    }
    doc.end();
    return;
  }

  const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g,'""')}"`).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="report-${type}-${Date.now()}.csv"`);
  res.send(csv);
}
