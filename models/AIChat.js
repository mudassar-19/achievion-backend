// Manager AI Assistant chat history (V2 Phase 3 · M-7, D-105). One document per chat; read-only Q&A.
import { Schema, model, Types } from "mongoose";

const messageSchema = new Schema({
  role:    { type: String, enum: ["user", "ai"], required: true },
  text:    { type: String, maxlength: 2000, required: true },
  sources: [{ _id: false, key: String, label: String, to: String }],
  context: { type: String, maxlength: 120 }, // chip label at the time of the question
}, { timestamps: { createdAt: true, updatedAt: false } });

const aiChatSchema = new Schema({
  orgId:    { type: String, required: true },
  userId:   { type: Types.ObjectId, ref: "User", required: true },
  title:    { type: String, maxlength: 80, default: "New chat" },
  messages: { type: [messageSchema], default: [] },
}, { timestamps: true });

aiChatSchema.index({ userId: 1, updatedAt: -1 });

export default model("AIChat", aiChatSchema);
