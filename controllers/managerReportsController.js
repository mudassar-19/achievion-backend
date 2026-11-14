// Manager Reports (V2 Phase 3 · M-6, UX §11): Delivery, People, XP trend, Well-being, Lessons learned,
// PDF/CSV export. Manager only (route guard) + every project / sprint / member / note inside the caller's org.
// No AI here: the narrative and "Generate with AI" wait for M-7.
import { CSV_BOM, csvCell, toCsv } from "../services/csvRules.js";
import { chartsFor, safeAiText, buildReportPdf } from "../services/reportPdf.js";
import { buildReportXlsx } from "../services/reportXlsx.js";
import { logoBytes } from "./directorOrgController.js";
import { capture } from "../utils/capture.js";
import mongoose from "mongoose";
import Project  from "../models/Project.js";
import Sprint   from "../models/Sprint.js";
import Lesson   from "../models/Lesson.js";
import AuditLog from "../models/AuditLog.js";
import { orgScope } from "./managerProjectsController.js";
import { parseReportQuery, validateLesson, exportDoc } from "../services/reportRules.js";
import { buildDelivery, buildPeople, buildXp, buildWellbeing, buildLessons, lessonView } from "../services/reportService.js";

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
  // Batch 5 (D8, N13, UC-20): the PDF (and its preview) carries the AI summary; null = "AI summary not available".
  const aiSummary = req.query.format === "csv" ? undefined : await aiSummaryFor(req);
  return sendExport(req, res, name, data, ctx.scope.org, { aiSummary });
}

// The Manager's AI report narrative for these filters (cached for the day by managerAiController). Any failure → null.
async function aiSummaryFor(req) {
  try {
    const { reportNarrative } = await import("./managerAiController.js");
    const query = Object.fromEntries(["project", "sprint", "range", "from", "to"].filter((k) => typeof req.query[k] === "string" && req.query[k]).map((k) => [k, req.query[k]]));
    const r = await capture(reportNarrative, req, { query });
    return r.status === 200 ? safeAiText(r.body?.narrative) : null;
  } catch { return null; }
}

// Shared with Team Lead Performance (T-5): preview JSON, CSV or PDF of one report tab.
// extra.aiSummary: text, null ("AI summary not available") or undefined (this report has no AI text, e.g. Team Lead).
export async function sendExport(req, res, name, data, org, extra = {}) {
  const format = ["csv", "json", "xlsx"].includes(req.query.format) ? req.query.format : "pdf";
  const doc = exportDoc(name, data);
  const charts = chartsFor(name, data);
  if (format === "json") return res.json({ ...doc, generatedAt: new Date(), charts: charts.map((c) => ({ title: c.title, unit: c.unit, points: c.points.length })), ...(extra.aiSummary !== undefined && { aiSummary: extra.aiSummary }) }); // the preview shows exactly what the file will hold
  const file = `achievion-${name}-${new Date().toISOString().slice(0, 10)}.${format}`;
  AuditLog.create({ action: "report_exported", orgId: org._id, performedBy: req.user.id, scope: "report", detail: `${doc.title} exported as ${format.toUpperCase()} (${doc.filters}).` })
    .catch((e) => console.error("[audit]", e.message));

  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
  if (format === "csv") {
    // One CSV rule for every export (services/csvRules.js): quoted cells, formulas neutralised, UTF-8 BOM.
    const csv = doc.sections.flatMap((s) => [csvCell(s.heading), toCsv(s.headers, s.rows), ""]).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    return res.send(CSV_BOM + csv);
  }
  if (format === "xlsx") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const generatedBy = req.user.name ? `${req.user.name} (${req.user.role})` : req.user.role ?? "";
    return res.send(Buffer.from(await buildReportXlsx(doc, { orgName: org.name ?? "", aiSummary: extra.aiSummary, generatedBy })));
  }
  res.setHeader("Content-Type", "application/pdf");
  res.send(await buildReportPdf(doc, { orgName: org.name ?? "", logo: await logoBytes(String(org._id)), charts, aiSummary: extra.aiSummary }));
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
