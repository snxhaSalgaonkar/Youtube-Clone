import mongoose, { Schema } from "mongoose";

/**
 * MISTAKE #1 — No compound index on (userId + videoId)
 * Problem: Every upsert query does a full collection scan to find
 *          the matching document.
 * Reason:  MongoDB does not know how to quickly find "this user's
 *          record for this video" without an index. With 10M records,
 *          this becomes a multi-second query.
 * Solution: Compound index below. The order matters — userId first
 *           because most queries filter by userId first.
 *
 * MISTAKE #2 — No TTL index for old history
 * Problem: Watch history grows forever. A single active user can
 *          accumulate thousands of records over months.
 * Reason:  Beginners never think about data lifecycle. MongoDB has
 *          no automatic cleanup unless you set one up.
 * Solution: TTL index on watchedAt. 90 days is a reasonable
 *           production default (YouTube purges after ~1 year).
 *           Uncomment the TTL index below when you're ready.
 */

const watchHistorySchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true, // single-field index for queries like "get all history for user"
    },

    videoId: {
      type: Schema.Types.ObjectId,
      ref: "Video",
      required: true,
    },

    /**
     * MISTAKE #3 — Storing watchedPercent as a string ("45%")
     * Problem: You can't do numeric range queries on strings.
     * Reason:  "$gte: 5, $lte: 95" only works on Numbers.
     *          "45%" > "5%" is a string comparison, not numeric.
     * Solution: Always store as a Number (0–100). Validate the range.
     */
    watchedPercent: {
      type: Number,
      default: 0,
      min: [0, "watchedPercent cannot be negative"],
      max: [100, "watchedPercent cannot exceed 100"],
    },

    // The exact second the user stopped watching.
    // Critical for "continue watching" resume functionality.
    lastPositionSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },

    // How many times this user has fully watched this video.
    // "Fully" = watchedPercent crossed 95% threshold.
    rewatchCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Last time this entry was touched. Used for sorting "recently watched".
    watchedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true, // adds createdAt + updatedAt automatically
  },
);

/**
 * COMPOUND INDEX — The most important performance decision in this file.
 *
 * unique: true enforces one record per (user, video) pair at the DB level.
 * This makes upserts safe — no duplicate history entries can exist even
 * under concurrent requests (race conditions).
 *
 * In production: MongoDB uses this index for O(log n) lookups instead
 * of O(n) collection scans.
 */
watchHistorySchema.index({ userId: 1, videoId: 1 }, { unique: true });

/**
 * OPTIONAL TTL INDEX — Uncomment when ready.
 * Automatically deletes documents 90 days after watchedAt.
 * MongoDB's background TTL thread runs every 60 seconds.
 *
 * watchHistorySchema.index(
 *   { watchedAt: 1 },
 *   { expireAfterSeconds: 60 * 60 * 24 * 90 }
 * );
 */

/**
 * MISTAKE #4 — No sparse or partial indexes for "continue watching"
 * Problem: Querying "videos where watchedPercent between 5 and 95"
 *          scans all documents even for completed videos.
 * Reason:  MongoDB evaluates the filter AFTER fetching — unless you
 *          have a partial index that pre-filters at index level.
 * Solution (advanced): Partial index shown below. Skip for now,
 *          but know this exists for when your collection grows large.
 *
 * watchHistorySchema.index(
 *   { userId: 1, watchedAt: -1 },
 *   {
 *     partialFilterExpression: {
 *       watchedPercent: { $gte: 5, $lte: 95 }
 *     }
 *   }
 * );
 */

export const WatchHistory = mongoose.model("WatchHistory", watchHistorySchema);
