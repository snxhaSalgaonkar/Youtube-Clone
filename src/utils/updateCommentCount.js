import { Video } from "../models/video.model.js";
import { Comment } from "../models/comment.model.js";

/**
 * Recalculates and updates the commentCount for a video
 * Uses actual DB count to stay accurate (avoids race conditions with inc/dec)
 */
export const syncCommentCount = async (videoId) => {
  const count = await Comment.countDocuments({
    video: videoId,
    isDeleted: { $ne: true }, // exclude soft-deleted comments if you use that
  });

  await Video.findByIdAndUpdate(videoId, { commentCount: count });
};
