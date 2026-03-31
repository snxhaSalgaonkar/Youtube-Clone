// likes.model.js
import mongoose, { Schema } from "mongoose";

const likeSchema = new Schema(
  {
    likedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "likedBy (user) is required"],
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: [true, "targetId is required"],
      // No 'ref' here because target can be Video, Comment, or Tweet
      // This is a polymorphic association pattern
    },
    targetType: {
      type: String,
      enum: {
        values: ["Video", "Comment", "Tweet"],
        message: "{VALUE} is not a supported target type",
      },
      required: [true, "targetType is required"],
    },
  },
  {
    timestamps: true, // auto-manages createdAt and updatedAt
  },
);

/*
 * COMPOUND UNIQUE INDEX
 * This is the most critical line in this file.
 *
 * A compound index on these 3 fields serves TWO purposes:
 * 1. PERFORMANCE: MongoDB uses this index to instantly answer
 *    "did user X like target Y of type Z?" without scanning the collection.
 * 2. DATA INTEGRITY: The `unique: true` makes it impossible at the
 *    DATABASE level for the same user to like the same target twice.
 *    This is your last line of defense — even if your controller logic
 *    has a bug, the DB will reject the duplicate with an E11000 error.
 *
 * In production, always handle this error gracefully in your controller.
 */
likeSchema.index({ likedBy: 1, targetId: 1, targetType: 1 }, { unique: true });

/*
 * ADDITIONAL INDEX for reverse lookups:
 * "Fetch all likes on a specific video/comment/tweet"
 * This is needed for like count pages or analytics dashboards.
 */
likeSchema.index({ targetId: 1, targetType: 1 });

export const Like = mongoose.model("Like", likeSchema);
