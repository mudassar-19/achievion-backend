/**
 * Migration: seed-default-departments.mjs
 * Seeds ["Development", "Design", "QA"] into Organization.departments for every org
 * that currently has an empty departments array.
 *
 * Usage:
 *   node server/scripts/seed-default-departments.mjs           # dry run
 *   node server/scripts/seed-default-departments.mjs --apply   # write changes
 */
import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1);
}

const apply = process.argv.includes("--apply");
const DEFAULT = ["Development", "Design", "QA"];

await mongoose.connect(process.env.MONGO_URI);
const Org = mongoose.model("Organization", new mongoose.Schema({}, { strict: false }));

const empty = await Org.find({ $or: [{ departments: { $exists: false } }, { departments: { $size: 0 } }] }, "_id name").lean();
console.log(`Orgs with empty departments: ${empty.length}`);
empty.forEach((o) => console.log(`  ${o._id}  ${o.name}`));

if (apply) {
  if (empty.length) {
    await Org.updateMany(
      { _id: { $in: empty.map((o) => o._id) } },
      { $set: { departments: DEFAULT } }
    );
    console.log(`Seeded departments for ${empty.length} org(s).`);
  } else {
    console.log("Nothing to update.");
  }
} else {
  console.log("Dry run — pass --apply to write changes.");
}

await mongoose.disconnect();
