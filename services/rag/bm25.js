/**
 * BM25 — pure JS, no dependencies.
 * k1=1.5, b=0.75 (standard parameters).
 */

const k1 = 1.5;
const b  = 0.75;

function tokenize(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export class BM25Index {
  constructor() {
    this.docs      = [];   // { id, orgId, role, text, tokens }
    this.df        = {};   // term → document frequency
    this.avgLen    = 0;
  }

  add(doc) {
    const tokens = tokenize(doc.text);
    this.docs.push({ ...doc, tokens });
    for (const t of new Set(tokens)) {
      this.df[t] = (this.df[t] ?? 0) + 1;
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.tokens.length, 0) / this.docs.length;
  }

  addBatch(docs) { docs.forEach((d) => this.add(d)); }

  score(query, doc) {
    const N   = this.docs.length;
    const qToks = tokenize(query);
    let s = 0;
    const tf = {};
    for (const t of doc.tokens) tf[t] = (tf[t] ?? 0) + 1;
    for (const t of qToks) {
      const f   = tf[t] ?? 0;
      if (!f) continue;
      const df  = this.df[t] ?? 0;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      const num = f * (k1 + 1);
      const den = f + k1 * (1 - b + b * (doc.tokens.length / this.avgLen));
      s += idf * (num / den);
    }
    return s;
  }

  search(query, { orgId, role, topK = 5 } = {}) {
    if (!this.docs.length) return [];
    const candidates = this.docs.filter((d) => {
      if (orgId && d.orgId !== orgId) return false;
      if (role  && d.role && d.role !== role) return false;
      return true;
    });
    const scored = candidates
      .map((d) => ({ ...d, score: this.score(query, d) }))
      .sort((a, b) => b.score - a.score);
    // Return top K; keep zero-score docs too so context is never empty
    return scored.slice(0, topK);
  }

  clear(orgId) {
    if (orgId) this.docs = this.docs.filter((d) => d.orgId !== orgId);
    else { this.docs = []; this.df = {}; this.avgLen = 0; }
  }

  size(orgId) {
    return orgId ? this.docs.filter((d) => d.orgId === orgId).length : this.docs.length;
  }
}
