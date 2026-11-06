import { Schema, model, Types } from "mongoose";

const submissionSchema = new Schema(
  {
    task: {
      type:     Types.ObjectId,
      ref:      "Task",
      required: [true, "Submission must reference a task"],
    },

    submitter: {
      type:     Types.ObjectId,
      ref:      "User",
      required: [true, "Submission must reference a user"],
    },

    // URL of the deliverable: PR link, live deployment, design file, etc.
    url: {
      type:     String,
      required: [true, "Submission URL is required"],
      trim:     true,
    },

    notes: {
      type:    String,
      trim:    true,
      default: "",
    },

    // 0–100 score written by the AI evaluation pipeline.
    aiScore: {
      type: Number,
      min:  0,
      max:  100,
    },

    status: {
      type:    String,
      enum:    ["Pending", "Approved", "Rejected"],
      default: "Pending",
    },
  },
  { timestamps: true }
);

// Directors query by status; submitters query by their own submissions.
submissionSchema.index({ status: 1, createdAt: -1 });
submissionSchema.index({ submitter: 1, status: 1 });
submissionSchema.index({ task: 1 }, { unique: true }); // one active submission per task

export default model("Submission", submissionSchema);
