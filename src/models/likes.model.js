import mongoose, { Schema } from "mongoose";

const likeSchema = new Schema(
  {
    likedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "targetType",
    },
    targetType: {
      type: String,
      enum: ["Video", "Comment", "Tweet"],
      required: true,
    },
  },
  { timestamps: true },
);

// Prevents the same user from liking the same target twice at DB level
likeSchema.index({ likedBy: 1, targetId: 1, targetType: 1 }, { unique: true });

// For queries like "get total likes on this video"
likeSchema.index({ targetId: 1, targetType: 1 });

// For queries like "get all content liked by this user"
likeSchema.index({ likedBy: 1 });

export const Like = mongoose.model("Like", likeSchema);
