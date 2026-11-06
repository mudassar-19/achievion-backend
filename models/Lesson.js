// Lessons learned (V2 Phase 3 · M-6, UX §11): Manager notes per project, optionally per sprint.
// kind "auto" = the facts note pre-filled once when the project is closed or archived (editable like any note).
import { Schema, model, Types } from "mongoose";

const lessonSchema = new Schema(
  {
    orgId:     { type: String, required: true, index: true },
    projectId: { type: Types.ObjectId, ref: "Project", required: true },
    sprintId:  { type: Types.ObjectId, ref: "Sprint", default: null },
    kind:      { type: String, enum: ["note", "auto"], default: "note" },
    text:      { type: String, required: true, trim: true, maxlength: 2000 },
    createdBy: { type: Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

lessonSchema.index({ projectId: 1, sprintId: 1, createdAt: -1 });
// One pre-filled facts note per project.
lessonSchema.index({ projectId: 1 }, { unique: true, partialFilterExpression: { kind: "auto" } });

export default model("Lesson", lessonSchema);
