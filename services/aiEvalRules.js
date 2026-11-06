// AI evaluation rules (ACHIEVION_AI_EVAL_SPEC.md §1-4, D-075) — pure, no DB, no network.
// Tests: server/tests/aiEvalRules.test.mjs. The AI only advises; the TL score is final (D-063).

export const LIMITS = { devLines: 300, devBytes: 12 * 1024, testerBytes: 12 * 1024, outlineBytes: 3500, noteBytes: 500 };
export const EVAL_DAILY_LIMIT = 10;     // evaluations per user per day (spec §3)
export const DISAGREEMENT_POINTS = 20;  // |AI - TL| above this → Manager flag (D-063)

const R = (key, label, max) => ({ key, label, max });
export const RUBRICS = {
  developer: [R("correctness", "Correctness vs task", 30), R("readability", "Readability and naming", 20),
    R("structure", "Structure and maintainability", 20), R("security", "Security and error handling", 15), R("completeness", "Completeness and tests", 15)],
  designer:  [R("brief", "Matches the brief", 30), R("clarity", "Clarity and hierarchy", 20),
    R("consistency", "Consistency (spacing, colour, type)", 20), R("accessibility", "Accessibility (contrast, text size)", 15), R("completeness", "Completeness", 15)],
  tester:    [R("coverage", "Coverage", 30), R("reproducible", "Reproducible steps", 25),
    R("expected_actual", "Expected vs actual clarity", 20), R("severity", "Severity and priority", 15), R("clarity", "Clarity", 10)],
};
export const rubricFor = (roleCategory) => RUBRICS[roleCategory] ?? null;

// Designers tick these; the AI sees only the description and this list (D-061, no image).
export const DESIGN_CHECKLIST = [
  { key: "brief",       label: "Matches the task brief" },
  { key: "hierarchy",   label: "Clear visual hierarchy" },
  { key: "consistency", label: "Consistent spacing, colour and type" },
  { key: "contrast",    label: "Text contrast and size checked" },
  { key: "states",      label: "All screens and states included" },
];

const bytes = (s) => Buffer.byteLength(s, "utf8");
function cutBytes(s, max) {
  if (bytes(s) <= max) return s;
  let out = s.slice(0, max);
  while (bytes(out) > max) out = out.slice(0, -1);
  return out;
}

// Function / class / method signatures — enough for the AI to see the shape of a big file.
const SIGNATURE = /^\s*(export\s+)?(default\s+)?(async\s+)?(function\b|class\b|def\b|interface\b|type\s+\w+\s*=|(public|private|protected|static)\s|(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>)/;
export const extractOutline = (code) => code.split("\n").filter((l) => SIGNATURE.test(l)).map((l) => l.trim()).join("\n");

// Builds what the AI may see. { text, partial, empty }
export function prepareSubmission({ roleCategory, content = "", note = "", checklist = [] }) {
  const n = cutBytes(String(note ?? "").trim(), LIMITS.noteBytes);
  const body = String(content ?? "").replace(/\r\n/g, "\n");

  if (roleCategory === "designer") {
    if (!n) return { text: "", partial: false, empty: true };
    const ticked = new Set((checklist ?? []).map(String));
    const list = DESIGN_CHECKLIST.map((c) => `- [${ticked.has(c.key) ? "x" : " "}] ${c.label}`).join("\n");
    return { text: `Description:\n${n}\n\nDesigner's checklist:\n${list}`, partial: false, empty: false };
  }

  if (roleCategory === "tester") {
    const all = [n && `Note: ${n}`, body.trim()].filter(Boolean).join("\n\n");
    if (!all) return { text: "", partial: false, empty: true };
    const text = cutBytes(all, LIMITS.testerBytes);
    return { text, partial: text.length < all.length, empty: false };
  }

  // developer
  if (!body.trim()) return { text: "", partial: false, empty: true };
  const lines = body.split("\n");
  const head = n ? `Note: ${n}\n\n` : "";
  if (lines.length <= LIMITS.devLines && bytes(body) <= LIMITS.devBytes) return { text: `${head}Code:\n${body}`, partial: false, empty: false };
  const outline = cutBytes(extractOutline(body), LIMITS.outlineBytes);
  const first = cutBytes(lines.slice(0, LIMITS.devLines).join("\n"), LIMITS.devBytes);
  return { text: `${head}Outline of the whole file (signatures only):\n${outline}\n\nFirst ${LIMITS.devLines} lines:\n${first}`, partial: true, empty: false };
}

// Pull the JSON object out of a model reply (drops <think> blocks and prose around it).
export function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const shortList = (v) => Array.isArray(v) && v.length <= 3 && v.every((s) => typeof s === "string" && s.trim());

// Spec §3: integers, 0..criterion max, total = sum, ≤3 strengths/improvements, confidence high|partial.
export function validateEvaluation(obj, rubric) {
  if (!obj || typeof obj !== "object" || !rubric) return { ok: false, error: "not an object" };
  const scores = {};
  for (const c of rubric) {
    const v = obj.scores?.[c.key];
    if (!Number.isInteger(v) || v < 0 || v > c.max) return { ok: false, error: `bad score: ${c.key}` };
    scores[c.key] = v;
  }
  const sum = Object.values(scores).reduce((s, v) => s + v, 0);
  if (obj.total !== sum) return { ok: false, error: "total is not the sum" };
  if (!shortList(obj.strengths) || !shortList(obj.improvements)) return { ok: false, error: "lists" };
  if (!["high", "partial"].includes(obj.confidence)) return { ok: false, error: "confidence" };
  const evidence = {};
  for (const c of rubric) if (typeof obj.evidence?.[c.key] === "string") evidence[c.key] = obj.evidence[c.key].slice(0, 200);
  const clip = (l) => l.map((s) => s.trim().slice(0, 200));
  return { ok: true, value: { scores, total: sum, strengths: clip(obj.strengths), improvements: clip(obj.improvements), confidence: obj.confidence, evidence } };
}

export function validateTaskSuggestion(obj) {
  if (!obj || typeof obj !== "object") return { ok: false };
  const { description, estimatedHours, tags, why } = obj;
  const str = (s, max) => typeof s === "string" && s.trim().length > 0 && s.length <= max;
  if (!str(description, 1000) || !str(why, 200)) return { ok: false };
  if (typeof estimatedHours !== "number" || !(estimatedHours >= 0.25 && estimatedHours <= 200)) return { ok: false };
  if (!Array.isArray(tags) || tags.length > 5 || !tags.every((t) => str(t, 24))) return { ok: false };
  return { ok: true, value: { description: description.trim(), estimatedHours: Math.round(estimatedHours * 4) / 4,
    tags: tags.map((t) => t.trim().toLowerCase()), why: why.trim() } };
}

export function parseTlScore(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

export const isDisagreement = (aiScore, tlScore) =>
  Number.isFinite(aiScore) && Number.isFinite(tlScore) && Math.abs(aiScore - tlScore) > DISAGREEMENT_POINTS;

export const underDailyLimit = (usedToday) => usedToday < EVAL_DAILY_LIMIT;

// PII scrub for submission text (spec §3). Lighter than aiService.scrubPii so code keeps its numbers:
// phones need a "+" or 10+ digits; also neutralises a closing </data> so the delimiter can't be escaped.
export const scrubForEval = (text) => String(text ?? "")
  .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]")
  .replace(/\+\d[\d\s-]{7,}\d|\b\d[\d\s-]{9,}\d\b/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "[phone]" : m))
  .replace(/\b[0-9a-f]{24}\b/gi, "[id]")
  .replace(/<\s*\/?\s*data\s*>/gi, "[data-tag]");
