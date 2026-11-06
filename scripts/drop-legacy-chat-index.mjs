// One-off (D-074): drop the stale unique index chatchannels {orgId:1, name:1}.
// The schema now uses {communityId:1, name:1}; the old index blocks a 2nd community per org
// because every community has a group named "announcements". Idempotent.
// Usage: cd server && node scripts/drop-legacy-chat-index.mjs   (uses MONGO_URI from env / server/.env)
import "dotenv/config";
import mongoose from "mongoose";

await mongoose.connect(process.env.MONGO_URI);
const col = mongoose.connection.db.collection("chatchannels");
const found = (await col.indexes()).some((i) => i.name === "orgId_1_name_1");
if (found) await col.dropIndex("orgId_1_name_1");
console.log(found ? "Dropped chatchannels.orgId_1_name_1" : "Index not present; nothing to do");
await mongoose.disconnect();
