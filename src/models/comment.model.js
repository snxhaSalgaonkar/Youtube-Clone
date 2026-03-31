// comments.model.js
import mongoose, { Schema } from "mongoose";

const commentSchema = new Schema(
  {
    video: {
      type: Schema.Types.ObjectId,
      ref: "Video",
      required: [true, "video reference is required"],
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "comment owner is required"],
    },
    content: {
      type: String,
      required: [true, "comment content is required"],
      trim: true,
      maxlength: [2000, "Comment cannot exceed 2000 characters"],
      /*
       * maxlength at schema level is your safety net.
       * Even if your frontend allows only 500 chars, a direct API
       * call could send 50,000 characters, bloating your DB.
       * Always validate on the SERVER, not just the client.
       */
    },
    parentComment: {
      type: Schema.Types.ObjectId,
      ref: "Comment",
      default: null,
      /*
       * SELF-REFERENCING FOREIGN KEY — This is the nested/threaded
       * comments pattern. If parentComment is null, it's a top-level
       * comment. If it points to another Comment's _id, it's a reply.
       *
       * WARNING FOR BEGINNERS: Don't try to build infinite nesting
       * (replies to replies to replies...) at the DB level for a
       * first project. YouTube itself only allows 1 level of replies.
       * Limit depth in your controller logic.
       */
    },
    likeCount: {
      type: Number,
      default: 0,
      min: [0, "likeCount cannot be negative"],
      /*
       * DENORMALIZATION — storing likeCount here instead of always
       * counting Like documents is a deliberate performance trade-off.
       *
       * Counting likes by query: db.likes.countDocuments({targetId})
       * On a video with 50,000 comments each with thousands of likes,
       * this is extremely expensive.
       *
       * By caching likeCount here, displaying comments is a single
       * fast query. The trade-off: you must keep this in sync using
       * $inc in your like/unlike controller — NEVER fetch-add-save.
       */
    },
  },
  {
    timestamps: true,
  },
);

/*
 * INDEX for fetching all comments on a video (most common query).
 * Sorted by newest first — the `-1` means descending order.
 * In production this query runs millions of times per day.
 */
commentSchema.index({ video: 1, createdAt: -1 });

/*
 * INDEX for fetching all replies to a specific comment.
 */
commentSchema.index({ parentComment: 1 });

/*
 * INDEX for fetching all comments by a specific user
 * (used in user profile / comment history pages).
 */
commentSchema.index({ owner: 1, createdAt: -1 });

export const Comment = mongoose.model("Comment", commentSchema);
