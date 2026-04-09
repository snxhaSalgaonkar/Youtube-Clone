import { Comment } from "../models/comment.model.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// =============================================================================
// verifyCommentOwnership
// =============================================================================
/**
 * Middleware: checks that req.user owns the comment being modified.
 *
 * PATTERN: This mirrors your existing verifyVideoOwnership middleware.
 * Keep authorization checks in middleware, not inside controllers.
 * Controllers should only handle business logic, not "is this person allowed?"
 *
 * WHY req.comment = comment:
 * The controller after this middleware will need the comment document anyway
 * (to update or delete it). By attaching it to req, we avoid fetching it
 * twice — one DB call total instead of two.
 *
 * IMPORTANT: This middleware is only for comment owners (edit/delete own comment).
 * Admin delete has its own route protected by verifyAdmin — see controller.
 */
export const verifyCommentOwnership = asyncHandler(async (req, _, next) => {
  const { commentId } = req.params;

  if (!commentId) {
    throw new ApiError(400, "Comment ID is required");
  }

  const comment = await Comment.findById(commentId).select("owner isDeleted");

  if (!comment) {
    throw new ApiError(404, "Comment not found");
  }

  if (comment.isDeleted) {
    throw new ApiError(410, "This comment has been deleted");
  }

  /**
   * .equals() — not ==
   * comment.owner is a Mongoose ObjectId object, req.user._id is also an ObjectId.
   * Using == or === does reference comparison (always false for objects).
   * .equals() compares the actual hex string values.
   *
   * BEGINNER MISTAKE: comment.owner === req.user._id  → always false.
   */
  if (!comment.owner.equals(req.user._id)) {
    throw new ApiError(
      403,
      "You do not have permission to modify this comment",
    );
  }

  req.comment = comment;
  next();
});

// =============================================================================
// verifyAdmin
// =============================================================================
/**
 * Middleware: checks that req.user has admin role.
 *
 * This assumes your User model has a `role` field with values like
 * "user" | "admin". Adjust the field name to match your User schema.
 *
 * PRODUCTION NOTE: In real systems, roles are more granular (RBAC —
 * Role-Based Access Control). An "admin" might be split into
 * "moderator" (can delete comments) vs "superadmin" (can delete users).
 * For a learning project, a simple role string is fine.
 */
export const verifyAdmin = asyncHandler(async (req, _, next) => {
  if (!req.user || req.user.role !== "admin") {
    throw new ApiError(403, "Admin access required");
  }
  next();
});
