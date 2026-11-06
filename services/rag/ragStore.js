/**
 * RAG store — in-memory BM25 + optional vector embeddings.
 * orgId + role filter enforced on every query.
 * @xenova/transformers used when available; BM25-only when not installed.
 *
 * Documents indexed from: Goals, Recaps, PerformanceLog, Projects (read-only).
 */

import { BM25Index } from "./bm25.js";

// One BM25 index across all orgs (filtered at query time)
const bm25 = new BM25Index();

// Vector store: docId → Float32Array(384)
let vectorStore = null; // null = not initialised
let embedder    = null; // xenova pipeline, null = not available

// ── Try to load @xenova/transformers ─────────────────────────────────────────
async function loadEmbedder() {
  if (embedder !== null) return embedder;
  try {
    const { pipeline } = await import("@xenova/transformers");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
    vectorStore = new Map();
    console.log("[rag] embedder loaded: all-MiniLM-L6-v2");
  } catch {
    embedder = false; // mark as unavailable
    console.log("[rag] @xenova/transformers not available — BM25 only");
  }
  return embedder;
}

// ── Cosine similarity ─────────────────────────────────────────────────────────
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── Add documents to index ────────────────────────────────────────────────────
export async function addDocs(docs) {
  bm25.addBatch(docs);
  const emb = await loadEmbedder();
  if (emb && vectorStore) {
    for (const doc of docs) {
      try {
        const out = await emb(doc.text, { pooling: "mean", normalize: true });
        vectorStore.set(doc.id, new Float32Array(out.data));
      } catch { /* skip vector for this doc */ }
    }
  }
}

// ── Query ─────────────────────────────────────────────────────────────────────
export async function query(queryText, { orgId, role, topK = 5 } = {}) {
  // BM25 results (always available)
  const bm25Results = bm25.search(queryText, { orgId, role, topK: topK * 2 });

  // Vector results (if embedder available)
  let hybridResults = bm25Results;
  const emb = await loadEmbedder();
  if (emb && vectorStore && bm25Results.length) {
    try {
      const qOut  = await emb(queryText, { pooling: "mean", normalize: true });
      const qVec  = new Float32Array(qOut.data);
      hybridResults = bm25Results.map((doc) => {
        const dVec = vectorStore.get(doc.id);
        const vecScore = dVec ? cosineSim(qVec, dVec) : 0;
        return { ...doc, hybridScore: 0.5 * doc.score + 0.5 * vecScore };
      }).sort((a, b) => b.hybridScore - a.hybridScore);
    } catch { /* fall back to BM25 */ }
  }

  return hybridResults.slice(0, topK);
}

// ── Re-index org from DB ──────────────────────────────────────────────────────
export async function reindexOrg(orgId, mongoose) {
  bm25.clear(orgId);
  if (vectorStore) {
    for (const [k] of vectorStore) { if (k.startsWith(orgId + ":")) vectorStore.delete(k); }
  }

  const db = mongoose.connection;
  const docs = [];

  // Goals
  const goals = await db.collection("goals").find({ orgId }).project({ title: 1, metric: 1, status: 1, targetValue: 1, currentValue: 1 }).toArray();
  goals.forEach((g) =>
    docs.push({ id: `${orgId}:goal:${g._id}`, orgId, role: null,
      text: `Goal: ${g.title} Metric: ${g.metric} Status: ${g.status} Target: ${g.targetValue ?? "?"} Current: ${g.currentValue ?? 0}`,
      source: "goal", ref: g._id.toString() })
  );

  // Recaps
  const recaps = await db.collection("recaps").find({ orgId }).project({ content: 1, type: 1, createdAt: 1 }).limit(50).sort({ createdAt: -1 }).toArray();
  recaps.forEach((r) =>
    docs.push({ id: `${orgId}:recap:${r._id}`, orgId, role: null, text: String(r.content ?? "").slice(0, 500), source: "recap", ref: r._id.toString() })
  );

  // Projects — with deadline + description
  const projects = await db.collection("projects").find({ orgId }).project({ title: 1, status: 1, deadline: 1, description: 1 }).toArray();
  projects.forEach((p) =>
    docs.push({ id: `${orgId}:project:${p._id}`, orgId, role: null,
      text: `Project: ${p.title} Status: ${p.status}${p.deadline ? " Deadline: " + new Date(p.deadline).toLocaleDateString() : ""}${p.description ? " " + String(p.description).slice(0, 120) : ""}`,
      source: "project", ref: p._id.toString() })
  );

  // Risks
  const risks = await db.collection("risks").find({ orgId }).project({ title: 1, description: 1, likelihood: 1, impact: 1, status: 1, score: 1 }).toArray();
  risks.forEach((r) =>
    docs.push({ id: `${orgId}:risk:${r._id}`, orgId, role: null,
      text: `Risk: ${r.title}. ${r.description ?? ""} Likelihood: ${r.likelihood} Impact: ${r.impact} Score: ${r.score ?? "?"} Status: ${r.status}`,
      source: "risk", ref: r._id.toString() })
  );

  // Tasks — active + overdue (Director-relevant)
  const tasks = await db.collection("tasks").find({ orgId, status: { $in: ["In Progress", "To Do", "Overdue", "In Review"] } })
    .project({ title: 1, status: 1, priority: 1, deadline: 1 }).limit(120).toArray();
  tasks.forEach((t) =>
    docs.push({ id: `${orgId}:task:${t._id}`, orgId, role: null,
      text: `Task: ${t.title} Status: ${t.status} Priority: ${t.priority ?? "normal"}${t.deadline ? " Deadline: " + new Date(t.deadline).toLocaleDateString() : ""}`,
      source: "task", ref: t._id.toString() })
  );

  // Team members grouped by role
  const users = await db.collection("users").find({ orgId, isActive: true }).project({ name: 1, role: 1, department: 1 }).limit(200).toArray();
  const roleMap = {};
  users.forEach((u) => { (roleMap[u.role] = roleMap[u.role] ?? []).push(u.name); });
  Object.entries(roleMap).forEach(([role, names]) =>
    docs.push({ id: `${orgId}:team:${role}`, orgId, role: null,
      text: `Team ${role}: ${names.slice(0, 15).join(", ")}. Total: ${names.length} member${names.length !== 1 ? "s" : ""}.`,
      source: "team", ref: role })
  );

  // Latest org health snapshot
  const snap = await db.collection("orghealthsnapshots").findOne({ orgId }, { sort: { calculatedAt: -1 } });
  if (snap) {
    docs.push({ id: `${orgId}:health:latest`, orgId, role: null,
      text: `Org Health Score: ${snap.overall}. Delivery: ${snap.subScores?.delivery ?? "N/A"} Capacity: ${snap.subScores?.capacity ?? "N/A"} Risk: ${snap.subScores?.risk ?? "N/A"} Quality: ${snap.subScores?.quality ?? "N/A"}`,
      source: "org-health", ref: snap._id.toString() })
  }

  await addDocs(docs);
  return { indexed: docs.length };
}

export function indexSize(orgId) { return bm25.size(orgId); }
