import "dotenv/config"; import mongoose from "mongoose";
await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;
const rows = await db.collection("notifications").aggregate([{ $group: { _id: { t: "$type" }, n: { $sum: 1 }, dl: { $addToSet: "$deepLink" }, mk: { $addToSet: { $objectToArray: { $ifNull: ["$meta", {}] } } } } }, { $sort: { n: -1 } }]).toArray();
for (const r of rows) console.log(r._id.t, r.n, "| deepLinks:", r.dl.filter(Boolean).slice(0, 2).join(" ; "), "| meta:", [...new Set(r.mk.flat().map((x) => x.k))].join(","));
await mongoose.disconnect();
