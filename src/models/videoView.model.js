// videoViews.model.js
import mongoose, { Schema } from "mongoose";
import crypto from "crypto"; // built-in Node.js module — no install needed

const videoViewSchema = new Schema(
  {
    videoId: {
      type: Schema.Types.ObjectId,
      ref: "Video",
      required: [true, "videoId is required"],
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      /*
       * NOT required — anonymous/guest viewers won't have a userId.
       * We use ipHash as a fallback identifier for guests.
       * This is the standard approach used by YouTube and similar platforms.
       */
    },
    ipHash: {
      type: String,
      required: [true, "ipHash is required"],
      /*
       * WHY HASH THE IP?
       * Storing raw IPs (like "192.168.1.1") is considered Personal
       * Identifiable Information (PII) under GDPR (Europe) and similar laws.
       * By hashing with SHA-256 (a one-way function), you can still
       * deduplicate views (same IP = same hash) without being able to
       * reverse it back to a real IP. This is called "pseudonymization".
       *
       * HOW TO HASH IN YOUR CONTROLLER:
       * const ipHash = crypto
       *   .createHash("sha256")
       *   .update(req.ip + process.env.IP_HASH_SECRET)
       *   .digest("hex");
       *
       * Adding a SECRET (called a "pepper") before hashing prevents
       * rainbow table attacks where someone pre-computes hashes for all
       * known IPs to reverse-engineer them.
       */
    },
    watchedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false, // watchedAt already serves this purpose
  },
);

/*
 * TTL INDEX — "Time To Live"
 * This is a powerful MongoDB feature beginners almost never use.
 *
 * This tells MongoDB to AUTOMATICALLY DELETE view documents after
 * 24 hours (86400 seconds). Why would you want that?
 *
 * YouTube's rule: Rewatching the same video within 24 hours doesn't
 * add a new view count. By letting old view records expire, the next
 * time the same user watches, no deduplication record exists,
 * and the view counts again — exactly like YouTube's behavior.
 *
 * This is far better than running a cron job to clean old records.
 * MongoDB handles it automatically in the background.
 */
videoViewSchema.index({ watchedAt: 1 }, { expireAfterSeconds: 86400 });

/*
 * COMPOUND INDEX for deduplication check:
 * "Has this user (or IP) already watched this video recently?"
 * Your controller will query { videoId, userId } or { videoId, ipHash }
 * before inserting a new view. This index makes that check instant.
 */
videoViewSchema.index({ videoId: 1, userId: 1 });
videoViewSchema.index({ videoId: 1, ipHash: 1 });

export const VideoView = mongoose.model("VideoView", videoViewSchema);
