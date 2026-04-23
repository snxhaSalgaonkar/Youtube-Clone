import mongoose from "mongoose";

/**
 * VideoViews Schema
 *
 * BEGINNER MISTAKE — Storing raw IP addresses:
 * Problem: Beginners store req.ip directly in the database.
 * Reason: Raw IPs are PII (Personally Identifiable Information). Under GDPR (Europe),
 *         CCPA (California), and similar laws, storing them without consent can get
 *         your service fined or shut down.
 * Solution: Store only a SHA-256 hash of the IP. You can still deduplicate
 *           (same IP = same hash) without storing any identifying data.
 *
 * BEGINNER MISTAKE — No TTL (Time-To-Live) index:
 * Problem: Beginners let this collection grow forever.
 * Reason: Every view ever recorded stays in the DB. At YouTube scale, that's billions
 *         of documents. Even at small scale, it balloons fast.
 * Solution: Use a TTL index to auto-delete documents after e.g. 30 days.
 *           You only need the raw view log for recent deduplication. Long-term
 *           analytics should be aggregated and stored in a separate stats collection.
 */

const videoViewsSchema = new mongoose.Schema(
  {
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Video",
      required: true,
      index: true, // Always index foreign keys you query against frequently
    },

    // Null when the viewer is a guest (not logged in)
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // SHA-256 hash of the IP address — never store raw IP
    ipHash: {
      type: String,
      required: true,
    },

    watchedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false, // watchedAt already covers this; don't add createdAt/updatedAt overhead
  },
);

/**
 * COMPOUND INDEX — The most critical performance decision in this schema.
 *
 * Problem beginners face: They query `{ videoId, userId }` or `{ videoId, ipHash }`
 * for deduplication but forget to create an index for it.
 *
 * Reason: Without this index, MongoDB does a full collection scan (COLLSCAN) on every
 * view request. At 10,000 documents that's slow. At 1,000,000 it's catastrophic.
 *
 * Solution: A compound index that exactly mirrors your deduplication query shape.
 * MongoDB can only use an index efficiently if it matches the query's field order.
 */
videoViewsSchema.index({ videoId: 1, userId: 1 });
videoViewsSchema.index({ videoId: 1, ipHash: 1 });

/**
 * TTL INDEX — Auto-delete old view documents.
 *
 * expireAfterSeconds: 86400 * 30 = 30 days.
 * MongoDB's background TTL thread deletes expired docs automatically.
 * This keeps the collection small and deduplication queries fast.
 *
 * IMPORTANT: TTL only works on Date fields. watchedAt must be a Date type.
 */
videoViewsSchema.index({ watchedAt: 1 }, { expireAfterSeconds: 86400 * 30 });

export const VideoViews = mongoose.model("VideoViews", videoViewsSchema);
