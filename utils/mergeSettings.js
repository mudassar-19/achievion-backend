// Merge a partial settings save into the stored object: plain objects merge key by key, anything else (numbers, strings, arrays) replaces.
// A key is never deleted. Prototype keys are skipped so a request body cannot reach Object.prototype.
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function mergeSettings(base, patch) {
  if (!isPlain(patch)) return patch;
  const out = { ...(isPlain(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = isPlain(v) ? mergeSettings(out[k], v) : v;
  }
  return out;
}
