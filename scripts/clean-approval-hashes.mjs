// ISS-022 migration: remove bcrypt hashes from stored approval payloads.
// SAFE: only removes hashes from DECIDED rows (APPROVED/REJECTED/EXPIRED).
// PENDING CREATE_EMPLOYEE rows keep payload.password — it's needed to create
// the user account when the Director approves the request.
//
// Dry-run by default; pass --apply to write.
//
// Usage:
//   node server/scripts/clean-approval-hashes.mjs            # dry-run (counts only)
//   node server/scripts/clean-approval-hashes.mjs --apply    # unsets payload.password from DECIDED rows
import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1);
}

const APPLY = process.argv.includes("--apply");

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;

const coll = db.collection("approvals");

const DECIDED = ["APPROVED", "REJECTED", "EXPIRED"];

// Count PENDING rows with payload.password (these must NOT be touched)
const pendingCount = await coll.countDocuments({
  "payload.password": { $exists: true },
  status: { $nin: DECIDED },
});

// Count DECIDED rows with payload.password (safe to clean)
const decidedCount = await coll.countDocuments({
  "payload.password": { $exists: true },
  status: { $in: DECIDED },
});

console.log(`[clean-approval-hashes] PENDING rows with payload.password (DO NOT TOUCH): ${pendingCount}`);
console.log(`[clean-approval-hashes] DECIDED rows with payload.password (safe to clean): ${decidedCount}`);

if (!APPLY) {
  console.log("[clean-approval-hashes] dry-run — pass --apply to remove hashes from DECIDED rows only");
} else {
  if (decidedCount === 0) {
    console.log("[clean-approval-hashes] nothing to do");
  } else {
    const result = await coll.updateMany(
      { "payload.password": { $exists: true }, status: { $in: DECIDED } },
      { $unset: { "payload.password": "" } }
    );
    console.log(`[clean-approval-hashes] updated ${result.modifiedCount} DECIDED rows; PENDING rows untouched`);
  }
}

await mongoose.disconnect();
