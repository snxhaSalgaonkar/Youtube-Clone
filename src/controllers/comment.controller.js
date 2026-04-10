import mongoose from "mongoose";
import { Comment } from "../models/comment.model.js";
import { Video } from "../models/video.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  sanitizeContent,
  buildPaginationOptions,
  isValidObjectId,
} from "../utils/commentUtils.js";

/**
 * MAX NESTING DEPTH = 2
 *
 * Level 0: Top-level comment      (parentComment = null)
 * Level 1: Reply to comment       (parentComment = commentId)
 *
 * We do NOT allow reply-to-reply. If someone tries to reply to a reply,
 * we reject it with a 400. This is enforced in addComment below.
 *
 * WHY: Without this, your getReplies query becomes recursive — you'd need
 * to chase parentComment chains indefinitely. At scale (or with a malicious
 * user), this times out or crashes. YouTube itself flattens all replies under
 * the original comment regardless of who replied to whom.
 */
const MAX_COMMENT_DEPTH = 1;

// =============================================================================
// 1. addComment
// =============================================================================
/**
 * POST /api/v1/comments/video/:videoId
 *
 * Adds a top-level comment OR a reply (if parentComment is sent in body).
 *
 * FLOW:
 * 1. Validate IDs
 * 2. Check video exists and is published
 * 3. If parentComment provided, check depth — reject if already at max depth
 * 4. Sanitize content
 * 5. Save
 */
export const addComment = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const { content, parentComment } = req.body;

  // --- Input validation ---
  if (!isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  if (!content || content.trim().length === 0) {
    throw new ApiError(400, "Comment content is required");
  }

  // --- Sanitize before any DB interaction ---
  const safeContent = sanitizeContent(content);

  if (safeContent.length === 0) {
    throw new ApiError(400, "Comment content is empty after sanitization");
  }

  // --- Check video exists and is published ---
  /**
   * BEGINNER MISTAKE: Skipping this check.
   * Without it, someone can comment on a deleted or private video by hitting
   * the API directly. Always verify the target resource exists and is in
   * a valid state before attaching data to it.
   */
  const video = await Video.findById(videoId).select("status isPublished");
  if (!video) {
    throw new ApiError(404, "Video not found");
  }
  // Adjust field name to match your Video model
  if (!video.isPublished) {
    throw new ApiError(403, "Cannot comment on an unpublished video");
  }

  // --- Depth check for replies ---
  let parentCommentDoc = null;
  if (parentComment) {
    if (!isValidObjectId(parentComment)) {
      throw new ApiError(400, "Invalid parent comment ID");
    }

    parentCommentDoc = await Comment.findById(parentComment).select(
      "parentComment isDeleted",
    );

    if (!parentCommentDoc) {
      throw new ApiError(404, "Parent comment not found");
    }

    if (parentCommentDoc.isDeleted) {
      throw new ApiError(410, "Cannot reply to a deleted comment");
    }

    /**
     * DEPTH ENFORCEMENT:
     * If the parent comment itself has a parentComment, it's already a reply
     * (depth = 1). Allowing a reply to it would create depth = 2, which we
     * block. We redirect the reply to attach to the ROOT comment instead,
     * which is exactly how YouTube handles it.
     */
    if (parentCommentDoc.parentComment !== null) {
      throw new ApiError(
        400,
        "Cannot reply to a reply. Replies are only allowed on top-level comments.",
      );
    }
  }

  // --- Create comment ---
  const comment = await Comment.create({
    video: videoId,
    owner: req.user._id,
    content: safeContent,
    parentComment: parentComment || null,
  });

  /**
   * .populate() here fetches the owner's username and avatar immediately
   * so the frontend can render the comment without a follow-up request.
   * In a high-traffic system you'd return just the comment and let the
   * frontend use cached user data — but for learning, this is fine.
   */
  const populated = await comment.populate("owner", "username avatar");

  return res
    .status(201)
    .json(new ApiResponse(201, populated, "Comment added successfully"));
});

// =============================================================================
// 2. updateComment
// =============================================================================
/**
 * PATCH /api/v1/comments/:commentId
 * Protected by: verifyJWT → verifyCommentOwnership
 *
 * Only updates content. Never let users update owner, video, likeCount,
 * or parentComment — those are set at creation and are immutable.
 *
 * PRODUCTION NOTE: In real systems, edited comments show an "edited" badge.
 * You'd add an `isEdited: Boolean` field to your schema and set it here.
 */
export const updateComment = asyncHandler(async (req, res) => {
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    throw new ApiError(400, "Updated content is required");
  }

  const safeContent = sanitizeContent(content);

  if (safeContent.length === 0) {
    throw new ApiError(400, "Content is empty after sanitization");
  }

  /**
   * req.comment is already attached by verifyCommentOwnership middleware.
   * No need to fetch it again from DB.
   *
   * { new: true } — returns the updated document, not the old one.
   * { runValidators: true } — runs schema validators (minLength, maxLength)
   * on update. Without this, validators are SKIPPED on .findByIdAndUpdate().
   *
   * BEGINNER MISTAKE: Not passing runValidators: true.
   * Your schema says maxLength: 1000. Without this option, you can update
   * a comment to 100,000 characters and Mongoose won't complain.
   */
  const updated = await Comment.findByIdAndUpdate(
    req.comment._id,
    {
      $set: {
        content: safeContent,
        isEdited: true, // Add this field to your schema if you want an "edited" badge
      },
    },
    { new: true, runValidators: true },
  ).populate("owner", "username avatar");

  return res
    .status(200)
    .json(new ApiResponse(200, updated, "Comment updated successfully"));
});

// =============================================================================
// 3. deleteComment (owner)
// =============================================================================
/**
 * DELETE /api/v1/comments/:commentId
 * Protected by: verifyJWT → verifyCommentOwnership
 *
 * SOFT DELETE — sets isDeleted: true instead of removing the document.
 *
 * WHY SOFT DELETE:
 * If this comment has replies, hard-deleting it leaves orphaned reply
 * documents in your DB pointing to a non-existent parent. The replies
 * lose all context. With soft delete, you render "[Comment deleted]"
 * and replies remain intact.
 *
 * The document stays in the DB. Your aggregation pipeline in getVideoComments
 * must filter isDeleted: false (or handle deleted comments intentionally).
 */
export const deleteComment = asyncHandler(async (req, res) => {
  await Comment.findByIdAndUpdate(req.comment._id, {
    $set: {
      isDeleted: true,
      content: "[Comment deleted]", // Overwrite content for privacy
    },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Comment deleted successfully"));
});

// =============================================================================
// 4. getVideoComments (paginated)
// =============================================================================
/**
 * GET /api/v1/comments/video/:videoId?page=1&limit=10
 *
 * Returns paginated top-level comments for a video with owner info attached.
 *
 * AGGREGATION PIPELINE STAGES:
 * $match  → filter to this video, top-level only, not deleted
 * $lookup → join with users collection to get owner details
 * $addFields → reshape owner from array to single object (after $lookup)
 * $project → pick only the fields the frontend needs (never expose _v, raw refs)
 * $sort   → newest first
 *
 * WHY NOT .find().populate():
 * populate fires a separate DB query per document. 20 comments = 21 queries.
 * Aggregation with $lookup does it in 1 query regardless of document count.
 */
export const getVideoComments = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const videoObjectId = new mongoose.Types.ObjectId(videoId);

  const pipeline = Comment.aggregate([
    {
      $match: {
        video: videoObjectId,
        parentComment: null, // Top-level only
        isDeleted: false,
      },
    },
    {
      // JOIN: pull owner's username and avatar from users collection
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "owner",
        pipeline: [
          { $project: { username: 1, avatar: 1 } }, // Only fetch what you need
        ],
      },
    },
    {
      // $lookup always returns an array — unwrap it to a single object
      $unwind: "$owner",
    },
    {
      $sort: { createdAt: -1 }, // Newest first
    },
    {
      $project: {
        content: 1,
        likeCount: 1,
        createdAt: 1,
        updatedAt: 1,
        "owner._id": 1,
        "owner.username": 1,
        "owner.avatar": 1,
      },
    },
  ]);

  const options = buildPaginationOptions(req.query);
  const result = await Comment.aggregatePaginate(pipeline, options);

  return res
    .status(200)
    .json(new ApiResponse(200, result, "Comments fetched successfully"));
});

// =============================================================================
// 5. getReplies (paginated)
// =============================================================================
/**
 * GET /api/v1/comments/:commentId/replies?page=1&limit=10
 *
 * Returns paginated replies for a specific comment.
 * Same aggregation pattern as getVideoComments, filtered by parentComment.
 */
export const getReplies = asyncHandler(async (req, res) => {
  const { commentId } = req.params;

  if (!isValidObjectId(commentId)) {
    throw new ApiError(400, "Invalid comment ID");
  }

  const parentObjectId = new mongoose.Types.ObjectId(commentId);

  // Verify parent comment exists
  const parent = await Comment.findById(commentId).select("isDeleted");
  if (!parent) {
    throw new ApiError(404, "Comment not found");
  }

  const pipeline = Comment.aggregate([
    {
      $match: {
        parentComment: parentObjectId,
        isDeleted: false,
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "owner",
        pipeline: [{ $project: { username: 1, avatar: 1 } }],
      },
    },
    { $unwind: "$owner" },
    { $sort: { createdAt: 1 } }, // Oldest first for replies (chronological)
    {
      $project: {
        content: 1,
        likeCount: 1,
        createdAt: 1,
        "owner._id": 1,
        "owner.username": 1,
        "owner.avatar": 1,
      },
    },
  ]);

  const options = buildPaginationOptions(req.query);
  const result = await Comment.aggregatePaginate(pipeline, options);

  return res
    .status(200)
    .json(new ApiResponse(200, result, "Replies fetched successfully"));
});

// =============================================================================
// 6. getCommentById
// =============================================================================
/**
 * GET /api/v1/comments/:commentId
 *
 * Returns a single comment with owner info.
 * Used when navigating to a specific comment via URL (e.g., linked comment).
 */
export const getCommentById = asyncHandler(async (req, res) => {
  const { commentId } = req.params;

  if (!isValidObjectId(commentId)) {
    throw new ApiError(400, "Invalid comment ID");
  }

  const comment = await Comment.findOne({
    _id: commentId,
    isDeleted: false,
  }).populate("owner", "username avatar");

  if (!comment) {
    throw new ApiError(404, "Comment not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, comment, "Comment fetched successfully"));
});

// =============================================================================
// 7. likeComment (stub — Like model comes later)
// =============================================================================
/**
 * POST /api/v1/comments/:commentId/like
 * Protected by: verifyJWT
 *
 * STUB: Full implementation depends on your Like model.
 *
 * WHAT THIS WILL DO (once Like model exists):
 * 1. Check if a Like document already exists for (user, comment) pair
 * 2. If yes → unlike: delete the Like doc, $inc likeCount: -1
 * 3. If no  → like:   create the Like doc, $inc likeCount: 1
 *
 * This is called a TOGGLE pattern. One endpoint handles both like and unlike.
 * The $inc operation is atomic — safe under concurrent requests.
 *
 * WHY NOT just likeCount++ in JS:
 * If 100 users like a comment simultaneously, a read-then-write pattern
 * causes a race condition — multiple requests read the same count, all
 * increment it, and most increments are lost. $inc in MongoDB is atomic
 * at the document level — it always produces the correct result.
 */
export const likeComment = asyncHandler(async (req, res) => {
  // TODO: Implement after Like model is built
  // const { commentId } = req.params;
  // const userId = req.user._id;
  // Toggle like via Like model, then $inc likeCount on Comment

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Like functionality coming soon"));
});

// =============================================================================
// 8. getUserComments (profile page)
// =============================================================================
/**
 * GET /api/v1/comments/user/:userId?page=1&limit=10
 * Protected by: verifyJWT
 *
 * Returns all non-deleted comments made by a user.
 * Used on the user's profile page ("Comments" tab).
 *
 * INCLUDES: video title and thumbnail from a $lookup on the videos collection
 * so the frontend can render "commented on [video title]" without extra calls.
 */
export const getUserComments = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  if (!isValidObjectId(userId)) {
    throw new ApiError(400, "Invalid user ID");
  }

  const userObjectId = new mongoose.Types.ObjectId(userId);

  const pipeline = Comment.aggregate([
    {
      $match: {
        owner: userObjectId,
        isDeleted: false,
      },
    },
    {
      // Join with videos to show which video was commented on
      $lookup: {
        from: "videos",
        localField: "video",
        foreignField: "_id",
        as: "video",
        pipeline: [{ $project: { title: 1, thumbnail: 1, isPublished: 1 } }],
      },
    },
    { $unwind: "$video" },
    {
      // Only show comments on published videos
      $match: { "video.isPublished": true },
    },
    { $sort: { createdAt: -1 } },
    {
      $project: {
        content: 1,
        likeCount: 1,
        createdAt: 1,
        parentComment: 1,
        "video._id": 1,
        "video.title": 1,
        "video.thumbnail": 1,
      },
    },
  ]);

  const options = buildPaginationOptions(req.query);
  const result = await Comment.aggregatePaginate(pipeline, options);

  return res
    .status(200)
    .json(new ApiResponse(200, result, "User comments fetched successfully"));
});

// =============================================================================
// 9. deleteCommentByAdmin
// =============================================================================
/**
 * DELETE /api/v1/comments/admin/:commentId
 * Protected by: verifyJWT → verifyAdmin
 *
 * Admin can delete any comment regardless of ownership.
 * Also hard-deletes all replies to prevent orphaned documents.
 *
 * HARD DELETE vs SOFT DELETE:
 * Admin deletion is intentional moderation action. Use hard delete here
 * to actually remove content that violates policy — not just hide it.
 * If a comment is moderated (rule violation), you don't want it lurking
 * in your DB with isDeleted: true, still accessible to internal tools.
 *
 * CLEANUP: Deleting a comment without deleting its replies leaves documents
 * in your DB with a parentComment pointing to nothing. Always clean up.
 * This is called referential integrity — MongoDB does NOT enforce it
 * automatically (unlike SQL). You are responsible for it.
 *
 * PRODUCTION TECHNIQUE: In high-scale systems, this cleanup runs as a
 * background job (queue), not inline in the request, so the admin
 * response isn't delayed by deleting 500 replies.
 */
export const deleteCommentByAdmin = asyncHandler(async (req, res) => {
  const { commentId } = req.params;

  if (!isValidObjectId(commentId)) {
    throw new ApiError(400, "Invalid comment ID");
  }

  const comment = await Comment.findById(commentId);
  if (!comment) {
    throw new ApiError(404, "Comment not found");
  }

  // Hard delete the comment
  await Comment.findByIdAndDelete(commentId);

  // Hard delete all replies to this comment
  const { deletedCount } = await Comment.deleteMany({
    parentComment: commentId,
  });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { deletedReplies: deletedCount },
        "Comment and its replies deleted by admin",
      ),
    );
});
