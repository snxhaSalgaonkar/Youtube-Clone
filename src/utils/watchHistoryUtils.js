import { WatchHistory } from "../models/watchHistory.model.js";

/**
 * Add or update watch history entry when a video view is recorded
 * @param {string} userId - User ID (null for guests)
 * @param {string} videoId - Video ID
 * @param {number} watchedPercent - Optional: percentage watched (default 0)
 * @param {number} lastPositionSeconds - Optional: position in video (default 0)
 */
export const addToWatchHistory = async (
  userId,
  videoId,
  watchedPercent = 0,
  lastPositionSeconds = 0,
) => {
  // Don't add watch history for guest users (no userId)
  if (!userId) {
    return null;
  }

  try {
    const entry = await WatchHistory.findOneAndUpdate(
      { userId, videoId },
      [
        {
          $set: {
            watchedPercent,
            lastPositionSeconds,
            watchedAt: new Date(),
            rewatchCount: {
              $cond: {
                if: {
                  $and: [
                    { $gte: [watchedPercent, 95] },
                    { $lt: [{ $ifNull: ["$watchedPercent", 0] }, 95] },
                  ],
                },
                then: { $add: [{ $ifNull: ["$rewatchCount", 0] }, 1] },
                else: { $ifNull: ["$rewatchCount", 0] },
              },
            },
          },
        },
      ],
      {
        upsert: true,
        new: true,
        runValidators: true,
      },
    );

    return entry;
  } catch (error) {
    console.error("Error adding to watch history:", error);
    // Don't throw — let view recording succeed even if history fails
    return null;
  }
};
