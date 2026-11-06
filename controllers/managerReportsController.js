// Manager Reports (V2 Phase 3 · M-6, UX §11): Delivery, People, XP trend, Well-being, Lessons learned,
// PDF/CSV export. Manager only (route guard) + every project / sprint / member / note inside the caller's org.
// No AI here: the narrative and "Generate with AI" wait for M-7.
import mongoose from "mongoose";
import { createRequire } from "module";
import Project  from "../models/Project.js";
import Sprint   from "../models/Sprint.js";
import Lesson   from "../models/Lesson.js";
import AuditLog from "../models/AuditLog.js";
import { orgScope } from "./managerProjectsController.js";
import { parseReportQuery, validateLesson, exportDoc } from "../services/reportRules.js";
import { buildDelivery, buildPeople, buildXp, buildWellbeing, buildLessons, lessonView } from "../services/reportService.js";

const _require = createRequire(import.meta.url);
const PDFDocument = _require("pdfkit");
const IS_OID = /^[0-9a-f]{24}$/i;
const SORTS = ["name", "role", "tasksDone", "onTimePct", "avgScore", "rework", "xp"];

// Filters → ctx. Answers 400 / 404 itself and returns null.
async function context(req, res, { needProject = false } = {}) {
  const { errors, value: q } = parseReportQuery(req.query);
  if (Object.keys(errors).length) { res.status(400).json({ error: Object.values(errors)[0], fields: errors }); return null; }
  // A project / sprint / member id that is not an id at all is "not found", never silently "All".
  for (const k of ["project", "sprint", "member"]) if (req.query[k] && !IS_OID.test(String(req.query[k]))) { res.status(404).json({ error: `That ${k} was not found.` }); return null; }
  if (req.query.sprint && !q.project) { res.status(400).json({ error: "Pick a project before a sprint." }); return null; }
  if (needProject && !q.project) { res.status(400).json({ error: "Pick a project to see its lessons." }); return null; }
  const scope = await orgScope(req.user.orgId);
  if (!scope) { res.status(404).json({ error: "Organization not found." }); return null; }
  const projects = await Project.find({ ...scope.filter, isDeleted: { $ne: true }, status: { $ne: "Deleted" } }, "_id title status members startDate createdAt").lean();
  const project = q.project ? projects.find((p) => String(p._id) === q.project) : null;
  if (q.project && !project) { res.status(404).json({ error: "Project not found." }); return null; }
  const sprint = q.sprint ? await Sprint.findOne({ _id: q.sprint, projectId: project._id, ...scope.filter }, "name status tasks startDate endDate").lean() : null;
  if (q.sprint && !sprint) { res.status(404).json({ error: "Sprint not found in this project." }); return null; }
  return { scope, q, projects, project, sprint };
}

const peopleSort = (req) => ({ sort: SORTS.includes(req.query.sort) ? req.query.sort : "tasksDone", dir: req.query.dir === "asc" ? "asc" : "desc" });
const BUILD = {
  delivery: (ctx) => buildDelivery(ctx),
  people: (ctx, req) => buildPeople(ctx, peopleSort(req)),
  xp: (ctx) => buildXp(ctx),
  wellbeing: (ctx) => buildWellbeing(ctx),
  lessons: (ctx) => buildLessons(ctx),
};

const tab = (name) => async (req, res) => {
  const ctx = await context(req, res, { needProject: name === "lessons" });
  if (!ctx) return;
  const data = await BUILD[name](ctx, req);
  if (!data) return res.status(404).json({ error: "That person is not in this team." });
  res.json(data);
};
export const getDelivery  = tab("delivery");
export const getPeople    = tab("people");
export const getXpTrend   = tab("xp");
export const getWellbeing = tab("wellbeing");
export const getLessons   = tab("lessons");

// ── GET /api/manager/reports/options  (filter choices: projects + their sprints) ──
export async function getOptions(req, res) {
  const scope = await orgScope(req.user.orgId);
  if (!scope) return res.status(404).json({ error: "Organization not found." });
  const projects = await Project.find({ ...scope.filter, isDeleted: { $ne: true }, status: { $ne: "Deleted" } }, "_id title status").sort({ title: 1 }).lean();
  const sprints = await Sprint.find({ ...scope.filter, projectId: { $in: projects.map((p) => p._id) } }, "_id name status projectId startDate").sort({ startDate: -1 }).lean();
  res.json({
    projects: projects.map((p) => ({ id: p._id, title: p.title, status: p.status })),
    sprints: sprints.map((s) => ({ id: s._id, name: s.name, status: s.status, projectId: s.projectId })),
  });
}

// ── GET /api/manager/reports/export?tab=&format=pdf|csv&<filters> ───────────
export async function exportReport(req, res) {
  const name = String(req.query.tab ?? "");
  if (!BUILD[name]) return res.status(400).json({ error: "Choose a report tab to export." });
  const ctx = await context(req, res, { needProject: name === "lessons" });
  if (!ctx) return;
  const data = await BUILD[name](ctx, req);
  if (!data) return res.status(404).json({ error: "That person is not in this team." });
  return sendExport(req, res, name, data, ctx.scope.org);
}

// Shared with Team Lead Performance (T-5): preview JSON, CSV or PDF of one report tab.
export function sendExport(req, res, name, data, org) {
  const format = ["csv", "json"].includes(req.query.format) ? req.query.format : "pdf";
  const doc = exportDoc(name, data);
  if (format === "json") return res.json({ ...doc, generatedAt: new Date() }); // the preview shows exactly what the file will hold
  const file = `achievion-${name}-${new Date().toISOString().slice(0, 10)}.${format}`;
  AuditLog.create({ action: "report_exported", orgId: org._id, performedBy: req.user.id, scope: "report", detail: `${doc.title} exported as ${format.toUpperCase()} (${doc.filters}).` })
    .catch((e) => console.error("[audit]", e.message));

  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
  if (format === "csv") {
    // Quote every cell; a cell starting with = + - @ gets a leading ' so a spreadsheet does not run it as a formula.
    const safe = (v) => (/^[=+\-@]/.test(v) && !/^[+-]?\d+(\.\d+)?( XP|%)?$/.test(v) ? `'${v}` : v); // plain numbers like -10 stay numbers
    const cell = (c) => `"${safe(String(c)).replace(/"/g, '""')}"`;
    const csv = doc.sections.flatMap((s) => [cell(s.heading), s.headers.map(cell).join(","), ...s.rows.map((r) => r.map(cell).join(",")), ""]).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    return res.send(`﻿${csv}`);
  }
  res.setHeader("Content-Type", "application/pdf");
  renderPdf(doc, res);
}

// Title, filters, date, one table per section, "Generated by ACHIEVION" footer on every page.
function renderPdf(doc, out) {
  const pdf = new PDFDocument({ margin: 48, size: "A4", bufferPages: true, info: { Title: doc.title, Creator: "ACHIEVION" } });
  pdf.pipe(out);
  const left = 48, width = pdf.page.width - 96, bottom = () => pdf.page.height - 72;
  pdf.font("Helvetica-Bold").fontSize(18).fillColor("#101828").text(doc.title, left, 48);
  pdf.moveDown(0.3).font("Helvetica").fontSize(10).fillColor("#475467").text(doc.filters);
  pdf.text(`Generated ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`);
  pdf.moveDown(1);

  for (const s of doc.sections) {
    if (pdf.y > bottom() - 60) pdf.addPage();
    pdf.font("Helvetica-Bold").fontSize(12).fillColor("#101828").text(s.heading, left, pdf.y);
    pdf.moveDown(0.4);
    const n = s.headers.length;
    // First column holds names / labels; a two-column table sizes it to its longest label (dates stay narrow).
    pdf.font("Helvetica").fontSize(9);
    const first = n > 2 ? Math.max(width * 0.34, 150)
      : Math.min(width * 0.6, Math.max(90, ...[s.headers[0], ...s.rows.map((r) => r[0])].map((c) => pdf.widthOfString(String(c)) + 24)));
    const widths = [first, ...Array(n - 1).fill((width - first) / Math.max(1, n - 1))];
    const row = (cells, bold) => {
      pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
      const h = Math.max(...cells.map((c, i) => pdf.heightOfString(String(c), { width: widths[i] - 8 }))) + 6;
      if (pdf.y + h > bottom()) pdf.addPage();
      const y = pdf.y;
      let x = left;
      cells.forEach((c, i) => { pdf.fillColor(bold ? "#475467" : "#101828").text(String(c), x, y + 3, { width: widths[i] - 8 }); x += widths[i]; });
      pdf.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.5).strokeColor("#E4E7EC").stroke();
      pdf.x = left; pdf.y = y + h;
    };
    row(s.headers, true);
    if (!s.rows.length) { pdf.font("Helvetica").fontSize(9).fillColor("#475467").text("Nothing in this period.", left, pdf.y + 4); pdf.moveDown(0.5); }
    for (const r of s.rows) row(r, false);
    pdf.moveDown(1.2);
  }

  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(i);
    const margin = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0; // writing inside the bottom margin must not open a new page
    pdf.font("Helvetica").fontSize(8).fillColor("#667085")
      .text(`Generated by ACHIEVION · Page ${i + 1} of ${range.count}`, left, pdf.page.height - 40, { width, align: "center", lineBreak: false });
    pdf.page.margins.bottom = margin;
  }
  pdf.end();
}

// ── Lessons learned notes ───────────────────────────────────────────────────
const auditLesson = (scope, req, action, lesson, detail) => AuditLog.create({
  action, orgId: scope.org._id, performedBy: req.user.id, targetProjectId: lesson.projectId, scope: "report", detail,
}).catch((e) => console.error("[audit]", e.message));

export async function createLesson(req, res) {
  const { error, value } = validateLesson(req.body);
  if (error) return res.status(400).json({ error, fields: { text: error } });
  const projectId = String(req.body.project ?? ""), sprintId = req.body.sprint ? String(req.body.sprint) : null;
  if (!IS_OID.test(projectId) || (sprintId && !IS_OID.test(sprintId))) return res.status(404).json({ error: "Project not found." });
  const scope = await orgScope(req.user.orgId);
  if (!scope) return res.status(404).json({ error: "Organization not found." });
  const project = await Project.findOne({ _id: projectId, ...scope.filter, isDeleted: { $ne: true } }, "_id title").lean();
  if (!project) return res.status(404).json({ error: "Project not found." });
  if (sprintId && !(await Sprint.exists({ _id: sprintId, projectId: project._id, ...scope.filter }))) return res.status(404).json({ error: "Sprint not found in this project." });
  const lesson = await Lesson.create({ orgId: String(scope.org._id), projectId: project._id, sprintId, text: value.text, createdBy: req.user.id, updatedBy: req.user.id });
  auditLesson(scope, req, "lesson_created", lesson, `Lesson note added to "${project.title}".`);
  res.status(201).json(lessonView(lesson.toObject(), { [String(req.user.id)]: req.user.name ?? null }));
}

async function loadLesson(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: "Note not found." }); return null; }
  const scope = await orgScope(req.user.orgId);
  if (!scope) { res.status(404).json({ error: "Organization not found." }); return null; }
  const lesson = await Lesson.findOne({ _id: req.params.id, ...scope.filter });
  if (!lesson) { res.status(404).json({ error: "Note not found." }); return null; }
  return { scope, lesson };
}

export async function updateLesson(req, res) {
  const { error, value } = validateLesson(req.body);
  if (error) return res.status(400).json({ error, fields: { text: error } });
  const loaded = await loadLesson(req, res); if (!loaded) return;
  const { scope, lesson } = loaded;
  lesson.text = value.text; lesson.updatedBy = req.user.id;
  await lesson.save();
  auditLesson(scope, req, "lesson_updated", lesson, "Lesson note edited.");
  res.json(lessonView(lesson.toObject(), { [String(req.user.id)]: req.user.name ?? null }));
}

// The Manager's own note; the UI asks first (ConfirmDialog). The audit row keeps the text.
export async function deleteLesson(req, res) {
  const loaded = await loadLesson(req, res); if (!loaded) return;
  const { scope, lesson } = loaded;
  await Lesson.deleteOne({ _id: lesson._id });
  auditLesson(scope, req, "lesson_deleted", lesson, `Lesson note deleted: "${lesson.text.slice(0, 200)}"`);
  res.json({ ok: true });
}
