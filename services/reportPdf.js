// Report PDF (Batch 5: D8, N13; UC-20 "report with charts and AI insights", FR10-04). One writer for the Manager,
// Team Lead and Director exports: header (logo or name), AI summary, bar charts from the report's own numbers, then the
// tables. No network and no DB here; the controller passes the logo bytes and the AI text.
import { createRequire } from "module";
const PDFDocument = createRequire(import.meta.url)("pdfkit");

const pts = (list, label, value) => (list ?? []).map((x) => ({ label: String(x[label] ?? ""), value: Number(x[value]) || 0 })).filter((p) => p.label);
const chart = (title, unit, points) => (points.some((p) => p.value !== 0) ? [{ title, unit, points: points.slice(0, 24) }] : []);
// Which charts a report tab gets. Built from the same data the tables show, so the picture and the table always agree.
export function chartsFor(tab, data = {}) {
  if (tab === "delivery") return [...chart("Done tasks over time", "tasks", pts(data.done, "label", "value")), ...chart("Velocity per sprint", "XP", pts(data.sprints, "name", "velocity"))];
  if (tab === "people") return chart("Tasks done per person", "tasks", pts(data.rows, "name", "tasksDone"));
  if (tab === "xp") return chart(data.memberName ? `XP for ${data.memberName}` : "Team XP", "XP", pts(data.points, "label", "value"));
  if (tab === "sprints") return chart("Sprint progress", "%", pts(data.rows, "name", "progressPct"));
  if (tab === "wellbeing") return chart("People who need a lighter load", "people", pts(data.trend, "label", "Low"));
  if (tab === "portfolio") return chart("Projects by status", "projects", pts(data.byStatus, "label", "value"));
  if (tab === "delivery-org") return chart("Finished tasks", "tasks", pts(data.onTime, "label", "value"));
  return [];
}

// AI text that may go into a file other people read: no sentence about an AI score, no email address, no database id, 1200 characters.
const AI_SCORE = /\bAI[- ]?(quality[- ]?)?(score|rating|grade)s?\b/i, EMAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, DB_ID = /\b[0-9a-f]{24}\b/i;
export function safeAiText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const kept = text.trim().split(/(?<=[.!?])\s+/).filter((s) => !AI_SCORE.test(s) && !EMAIL.test(s) && !DB_ID.test(s)).join(" ").slice(0, 1200).trim();
  return kept || null;
}

const INK = "#101828", MUTED = "#475467", LINE = "#E4E7EC", BAR = "#3B5BDB";
// options: orgName · logo { buffer, type } · charts (chartsFor) · aiSummary: text, null ("not available") or undefined (no AI block)
export function buildReportPdf(doc, { orgName = "", logo = null, charts = [], aiSummary } = {}) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 48, size: "A4", bufferPages: true, info: { Title: doc.title, Creator: "ACHIEVION" } });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject);
    const left = 48, width = pdf.page.width - 96, bottom = () => pdf.page.height - 72;
    const room = (h) => { if (pdf.y + h > bottom()) pdf.addPage(); };

    // Header: the organisation's logo when it is a PNG or JPG that pdfkit can read, else the name alone.
    let top = 48;
    if (logo?.buffer && ["png", "jpg"].includes(logo.type)) {
      try { pdf.image(logo.buffer, left, top, { fit: [120, 36] }); top += 44; } catch { /* a broken logo never breaks the report */ }
    }
    if (orgName) { pdf.font("Helvetica").fontSize(9).fillColor(MUTED).text(orgName, left, top); top = pdf.y + 2; }
    pdf.font("Helvetica-Bold").fontSize(18).fillColor(INK).text(doc.title, left, top);
    pdf.moveDown(0.3).font("Helvetica").fontSize(10).fillColor(MUTED).text(doc.filters ?? "");
    pdf.text(`Generated ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`);
    pdf.moveDown(1);

    if (aiSummary !== undefined) {
      pdf.font("Helvetica-Bold").fontSize(12).fillColor(INK).text("AI summary", left, pdf.y);
      pdf.moveDown(0.3).font("Helvetica").fontSize(10);
      if (aiSummary) {
        pdf.fillColor(INK).text(aiSummary, { width, lineGap: 2 });
        pdf.moveDown(0.3).fontSize(8).fillColor(MUTED).text("AI-generated from the numbers in this report. It is a suggestion: check the tables before you act on it.", { width });
      } else pdf.fillColor(MUTED).text("AI summary not available. The numbers and charts below are complete without it.", { width });
      pdf.moveDown(1.2);
    }

    for (const c of charts) {
      const h = 150; room(h + 40);
      pdf.font("Helvetica-Bold").fontSize(12).fillColor(INK).text(c.title, left, pdf.y);
      const y0 = pdf.y + 8, max = Math.max(...c.points.map((p) => p.value), 1), slot = width / c.points.length, bw = Math.min(36, slot * 0.6);
      pdf.moveTo(left, y0 + h).lineTo(left + width, y0 + h).lineWidth(0.5).strokeColor(LINE).stroke();
      c.points.forEach((p, i) => {
        const bh = Math.max(0, (Math.max(p.value, 0) / max) * (h - 16)), x = left + i * slot + (slot - bw) / 2;
        pdf.rect(x, y0 + h - bh, bw, bh).fill(BAR);
        if (c.points.length <= 16) pdf.font("Helvetica").fontSize(7).fillColor(INK).text(String(p.value), left + i * slot, y0 + h - bh - 10, { width: slot, align: "center", lineBreak: false });
        if (c.points.length <= 12 || i % Math.ceil(c.points.length / 12) === 0) pdf.font("Helvetica").fontSize(7).fillColor(MUTED).text(p.label.slice(0, 14), left + i * slot, y0 + h + 4, { width: slot, align: "center", lineBreak: false });
      });
      pdf.font("Helvetica").fontSize(8).fillColor(MUTED).text(`Unit: ${c.unit}`, left, y0 + h + 16);
      pdf.x = left; pdf.moveDown(1.5);
    }
    if (charts.length || aiSummary !== undefined) pdf.addPage(); // the tables start on their own page

    for (const s of doc.sections) {
      room(60);
      pdf.font("Helvetica-Bold").fontSize(12).fillColor(INK).text(s.heading, left, pdf.y);
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
        room(h);
        const y = pdf.y;
        let x = left;
        cells.forEach((c, i) => { pdf.fillColor(bold ? MUTED : INK).text(String(c), x, y + 3, { width: widths[i] - 8 }); x += widths[i]; });
        pdf.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.5).strokeColor(LINE).stroke();
        pdf.x = left; pdf.y = y + h;
      };
      row(s.headers, true);
      if (!s.rows.length) { pdf.font("Helvetica").fontSize(9).fillColor(MUTED).text("Nothing in this period.", left, pdf.y + 4); pdf.moveDown(0.5); }
      for (const r of s.rows) row(r, false);
      pdf.moveDown(1.2);
    }

    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(i);
      const margin = pdf.page.margins.bottom;
      pdf.page.margins.bottom = 0; // writing inside the bottom margin must not open a new page
      pdf.font("Helvetica").fontSize(8).fillColor("#667085").text(`Generated by ACHIEVION · Page ${i + 1} of ${range.count}`, left, pdf.page.height - 40, { width, align: "center", lineBreak: false });
      pdf.page.margins.bottom = margin;
    }
    pdf.end();
  });
}
