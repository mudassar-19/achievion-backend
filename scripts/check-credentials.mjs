/**
 * check-credentials.mjs — fail if plaintext passwords or keys are found in source.
 * Run: node server/scripts/check-credentials.mjs
 * Skips: node_modules, .env files, this script itself, known-safe patterns.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Patterns that signal a hardcoded credential (not env var, not placeholder)
// ponytail: simple regex scan; add patterns when new secret shapes appear
const SECRET_RE = [
  // Quoted password strings with 8+ alphanum chars (not env reads or generic words)
  /password\s*[:=]\s*["'](?!process\.env|CHANGE_ME|wrong|invalid|\$2b\$10\$invalidhash|example|x{3,}|[^"']{0,7}["'])([A-Za-z0-9!@#$%^&*_\-]{8,})["']/i,
  // Bearer token literals
  /Bearer\s+[A-Za-z0-9\-_\.]{30,}/,
  // AWS-style key patterns
  /AKIA[0-9A-Z]{16}/,
  // Generic secret/apikey assignment with long value
  /(secret|api[_-]?key|apiKey)\s*[:=]\s*["'][A-Za-z0-9!@#$%^&*_\-]{16,}["']/i,
];

const SKIP_DIRS  = new Set(["node_modules", ".git", "dist", "build", ".claude", "docs", "audit-runner"]);
const SKIP_EXTS  = new Set([".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".map", ".min.js", ".md"]);
const SKIP_FILES = new Set([
  "check-credentials.mjs",   // this script
  ".env.test.example",        // placeholder file
  "check-seed-passwords.mjs", // seed password checker (intentional)
]);

let hits = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) { walk(full); continue; }
    if (SKIP_EXTS.has(path.extname(entry))) continue;
    if (SKIP_FILES.has(entry)) continue;
    const rel = path.relative(ROOT, full);
    // Skip .env files themselves (they're supposed to have secrets)
    if (/^\.env(\.|$)/.test(entry)) continue;

    let src;
    try { src = readFileSync(full, "utf8"); } catch { continue; }

    const lines = src.split("\n");
    lines.forEach((line, i) => {
      // Skip lines that read from env
      if (/process\.env\b/.test(line) || /_env\[/.test(line)) return;
      for (const re of SECRET_RE) {
        if (re.test(line)) {
          console.error(`FAIL ${rel}:${i + 1}  →  ${line.trim().slice(0, 120)}`);
          hits++;
        }
      }
    });
  }
}

walk(ROOT);

if (hits > 0) {
  console.error(`\n${hits} potential credential(s) found. Move them to .env.test and read via process.env.*`);
  process.exit(1);
} else {
  console.log("check-credentials: no plaintext secrets found.");
}
