/**
 * VERIFY OWNERSHIP MIDDLEWARE
 *
 * WHAT IS MIDDLEWARE?
 * In Express, middleware = a function that runs between the incoming request
 * and your controller. It has access to (req, res, next).
 * Calling next() passes control to the next middleware or controller.
 * Throwing an error (or calling next(error)) skips to your error handler.
 *
 * Chain: Request → verifyJWT → verifyOwnership → controller
 *
 * WHY SEPARATE THIS FROM THE CONTROLLER?
 * Single Responsibility Principle. Your controller should focus on what
 * to do with a valid, authorized request — not on checking who's asking.
 * Keep authorization logic in middleware where it's reusable across routes.
 *
 * BEGINNER MISTAKE: Checking ownership inside every controller function.
 * You will forget to add the check in one place and create a security hole.
 * Centralize it in middleware so it's impossible to forget.
 */

import { Video } from "../models/video.model.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * verifyVideoOwnership
 *
 * Assumes verifyJWT has already run and attached req.user.
 * Fetches the video from DB and confirms the requesting user is the owner.
 * Attaches the video to req.video so the controller doesn't need to re-fetch it.
 *
 * Usage in routes:
 *   router.patch("/:videoId", verifyJWT, verifyVideoOwnership, updateVideoDetails);
 */
export const verifyVideoOwnership = asyncHandler(async (req, res, next) => {
  const { videoId } = req.params;

  if (!videoId) {
    throw new ApiError(400, "Video ID is required");
  }

  const video = await Video.findById(videoId).select("owner status");

  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  if (!video.owner.equals(req.user._id)) {
    throw new ApiError(403, "You do not have permission to modify this video");
  }
  req.video = video;

  next();
});
