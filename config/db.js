import mongoose from "mongoose";

export async function connectDB() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error("MONGO_URI is not defined in environment variables.");
  }

  mongoose.connection.on("connected", () =>
    console.log(`[MongoDB] Connected to ${mongoose.connection.name}`)
  );
  mongoose.connection.on("error", (err) =>
    console.error("[MongoDB] Connection error:", err.message)
  );
  mongoose.connection.on("disconnected", () =>
    console.warn("[MongoDB] Disconnected")
  );

  await mongoose.connect(uri, {
    // Mongoose 9+ no longer requires these options, but they're harmless to
    // leave out; keeping the call minimal lets the driver pick sensible defaults.
  });
}
