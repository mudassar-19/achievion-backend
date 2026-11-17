import "dotenv/config";
import mongoose from "mongoose";
await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
const db = mongoose.connection.db;
const org = await db.collection("organizations").findOne({ orgCode: "SIM-4663" }, { projection: { _id: 1 } }) || await db.collection("organizations").findOne({ code: "SIM-4663" }, { projection: { _id: 1 } });
const oid = org?._id;
const comms = await db.collection("chatcommunities").find({ orgId: oid }).toArray();
for (const c of comms) {
  const chans = await db.collection("chatchannels").find({ communityId: c._id }).toArray();
  console.log(c.name, "| community members:", c.memberIds?.length, "| groups:", chans.map(x => `${x.name}(${x.type}):${x.memberIds?.length}`).join(", "));
}
await mongoose.disconnect();
