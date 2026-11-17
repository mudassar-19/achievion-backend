// Item 33: how the sessions list is shown. Pure. Tests: server/tests/sessionRules.test.mjs.
// A raw user-agent string and an IP address are not shown to the user: a device name and the last-seen time are enough.
export const ACTIVE_MS = 15 * 60_000;

export function deviceName(ua) {
  const s = String(ua ?? "");
  if (!s.trim()) return "Unknown device";
  if (/^curl\//i.test(s)) return "curl (command line)";
  if (/^(node|undici)\b/i.test(s)) return "Test script"; // QA3 B-19: scripted logins (smoke and tests) say so instead of "Unknown device"
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows"
    : /Mac OS X|Macintosh/.test(s) ? "macOS" : /CrOS/.test(s) ? "ChromeOS" : /Linux/.test(s) ? "Linux" : null;
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox"
    : /Chrome\/|CriOS/.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : null;
  if (!browser && !os) return "Unknown device";
  return `${browser ?? "Browser"}${os ? ` on ${os}` : ""}`;
}

// rows: Session documents (lean). One entry per device name (the most recently seen), current device first, then Active
// (seen in the last 15 minutes), then Inactive, each newest first.
export function listView(rows, currentHash, now = new Date()) {
  const byDevice = new Map();
  for (const r of rows) {
    const name = deviceName(r.device);
    const isCurrent = r.tokenHash === currentHash;
    const prev = byDevice.get(name);
    if (!prev || isCurrent || (!prev.isCurrent && +new Date(r.lastSeenAt) > +new Date(prev.lastSeenAt)))
      byDevice.set(name, { id: r._id, device: name, lastSeenAt: r.lastSeenAt, createdAt: r.createdAt, isCurrent: isCurrent || prev?.isCurrent === true });
  }
  const rank = (s) => (s.isCurrent ? 0 : +now - +new Date(s.lastSeenAt) <= ACTIVE_MS ? 1 : 2);
  return [...byDevice.values()]
    .map((s) => ({ ...s, status: s.isCurrent ? "current" : rank(s) === 1 ? "active" : "inactive" }))
    .sort((a, b) => rank(a) - rank(b) || +new Date(b.lastSeenAt) - +new Date(a.lastSeenAt));
}
