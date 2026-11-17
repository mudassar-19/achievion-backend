// Item 16 (D-552): one person may send at most 20 chat messages in 10 seconds (the same limit the live socket path already had;
// the REST path had none). In memory, per person; a restart forgets it, which only ever lets a burst through once.
export function makeSendLimiter({ max = 20, windowMs = 10_000 } = {}) {
  const sent = new Map();
  return function tooFast(userId, now = Date.now()) {
    const recent = (sent.get(userId) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { sent.set(userId, recent); return true; }
    recent.push(now); sent.set(userId, recent);
    if (sent.size > 5000) for (const [k, v] of sent) if (!v.some((t) => now - t < windowMs)) sent.delete(k); // keep the map small
    return false;
  };
}
