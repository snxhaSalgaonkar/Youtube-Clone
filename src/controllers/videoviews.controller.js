import mongoose from "mongoose";
import { VideoViews } from "../models/videoViews.model.js";
import { hashIP, deduplicateView } from "../utils/videoViews.utils.js";

/**
 * ============================================================
 * CONTROLLER: recordView
 * ============================================================
 * POST /api/v1/views/:videoId
 *
 * BEGINNER MISTAKE — No input validation on route params:
 * Problem: Passing `req.params.videoId` directly into a Mongoose query
 *          without checking if it's a valid ObjectId.
 * Reason: If someone sends `/api/v1/views/not-an-id`, Mongoose throws a
 *         CastError which crashes your request with a 500 if unhandled.
 * Solution: Always validate ObjectId params with mongoose.isValidObjectId()
 *           before using them in queries.
 *
 * BEGINNER MISTAKE — No asyncHandler / try-catch:
 * Problem: Async errors inside route handlers aren't caught by Express's
 *          default error handler unless you explicitly call next(error).
 * Reason: Express only catches synchronous errors automatically. Async
 *         errors silently swallow and the request hangs forever.
 * Solution: Wrap every async controller in try/catch and call next(err),
 *           or use an asyncHandler wrapper utility.
 */
export async function recordView(req, res, next) {
  try {
    const { videoId } = req.params;

    // Step 1: Validate the videoId is a proper MongoDB ObjectId
    if (!mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Invalid video ID format." });
    }

    // Step 2: Get the real client IP
    // req.ip only works correctly when app.set("trust proxy", 1) is configured.
    // Without it, behind Nginx, you always get 127.0.0.1.
    const rawIP = req.ip || req.socket?.remoteAddress || "unknown";
    const ipHash = hashIP(rawIP);

    const userId = req.user?._id ?? null; // null for guests

    // Step 3: Deduplication check — BEFORE writing anything
    const isDuplicate = await deduplicateView({ videoId, userId, ipHash });

    if (isDuplicate) {
      /**
       * BEGINNER MISTAKE — Returning 200 with a misleading "view recorded" body:
       * Problem: You successfully blocked the duplicate but tell the client
       *          "view recorded." Frontend analytics gets confused.
       * Solution: Return a clear, distinct response. 200 is fine, but make
       *           the body explicit. Some APIs return 204 (No Content) here.
       */
      return res.status(200).json({
        message: "View already recorded within the time window.",
        counted: false,
      });
    }

    // Step 4: Record the new view
    /**
     * BEGINNER MISTAKE — Using `new Model().save()` in high-traffic paths:
     * Problem: `new VideoViews(data).save()` instantiates a full Mongoose
     *          document, runs all middleware/hooks, and then saves.
     * Reason: For simple inserts with no pre-save hooks needed, this is
     *         more overhead than necessary.
     * Solution: Use `Model.create()` for simplicity. For truly high-volume
     *           inserts (millions/day), consider `insertMany()` with batching,
     *           or offload to a queue (Redis/BullMQ) and batch-write to DB.
     */
    await VideoViews.create({
      videoId,
      userId,
      ipHash,
    });

    return res.status(201).json({
      message: "View recorded successfully.",
      counted: true,
    });
  } catch (error) {
    next(error); // Pass to Express global error handler
  }
}

/**
 * ============================================================
 * CONTROLLER: getViewCount
 * ============================================================
 * GET /api/v1/views/:videoId/count
 *
 * BEGINNER MISTAKE — Using .find().length or .find().count():
 * Problem: `.find()` fetches ALL matching documents into memory, then you
 *          count the array. At 1M documents this kills your server.
 * Reason: MongoDB has to load all documents, transfer over the network,
 *         and Node.js has to hold them in memory just to count.
 * Solution: Use `countDocuments()` — this runs entirely in MongoDB and
 *           returns just a number. It uses the index, not full documents.
 *
 * PRODUCTION NOTE:
 * At YouTube scale, you don't query the views collection for counts at all.
 * You maintain a denormalized `viewCount` field on the Video document itself,
 * and increment it atomically using `$inc` when a view is confirmed.
 * The views collection is only used for deduplication and analytics.
 * Querying it for counts on every page load is a beginner pattern that
 * doesn't scale.
 */
export async function getViewCount(req, res, next) {
  try {
    const { videoId } = req.params;

    if (!mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Invalid video ID." });
    }

    const count = await VideoViews.countDocuments({ videoId });

    return res.status(200).json({ videoId, viewCount: count });
  } catch (error) {
    next(error);
  }
}

/**
 * ============================================================
 * CONTROLLER: getUniqueViewers
 * ============================================================
 * GET /api/v1/views/:videoId/unique-viewers
 *
 * BEGINNER MISTAKE — Fetching all documents and deduplicating in JavaScript:
 * Problem: `await VideoViews.find({ videoId })` returns ALL view docs.
 *          Then you manually filter for unique userIds in a Set.
 * Reason: You're doing in application memory what the database is optimized
 *         to do. Terrible for memory, terrible for latency.
 * Solution: Use MongoDB Aggregation Pipeline with $group to deduplicate
 *           at the database level. Only the result (a number) travels
 *           over the network.
 *
 * HOW AGGREGATION PIPELINE WORKS:
 * Think of it as a series of transformation stages. Each stage receives
 * documents, transforms them, and passes the result to the next stage.
 * $match → $group → $count is the most common pattern for analytics.
 */
export async function getUniqueViewers(req, res, next) {
  try {
    const { videoId } = req.params;

    if (!mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Invalid video ID." });
    }

    const result = await VideoViews.aggregate([
      // Stage 1: Filter only documents for this video
      { $match: { videoId: new mongoose.Types.ObjectId(videoId) } },

      // Stage 2: Group by userId. Documents where userId is null
      // (guests) each get their own group keyed by ipHash.
      // This gives us unique authenticated viewers + unique guest IPs.
      {
        $group: {
          _id: {
            $cond: {
              if: { $ne: ["$userId", null] },
              then: "$userId",
              else: "$ipHash", // Use ipHash as the unique key for guests
            },
          },
        },
      },

      // Stage 3: Count the number of unique groups
      { $count: "uniqueViewers" },
    ]);

    const uniqueViewers = result[0]?.uniqueViewers ?? 0;
    return res.status(200).json({ videoId, uniqueViewers });
  } catch (error) {
    next(error);
  }
}

/**
 * ============================================================
 * CONTROLLER: getViewAnalytics
 * ============================================================
 * GET /api/v1/views/:videoId/analytics?days=30
 *
 * Returns view counts grouped by day — what you'd show on a creator dashboard.
 *
 * BEGINNER MISTAKE — Not validating query parameters:
 * Problem: `req.query.days` is always a string (e.g., "30"), not a number.
 *          Using it directly in date math gives NaN silently.
 *          Also, users can send `days=99999` to make your DB scan decades of data.
 * Solution: Parse and clamp: parseInt() with a sensible max (e.g., 90 days).
 *
 * BEGINNER MISTAKE — Using JavaScript Date math for grouping by day:
 * Problem: Fetching all docs and grouping by day in JS is memory-intensive.
 * Solution: Use MongoDB's $dateToString in an aggregation to group by date
 *           at the DB level. Only the grouped summary travels over the network.
 */
export async function getViewAnalytics(req, res, next) {
  try {
    const { videoId } = req.params;

    if (!mongoose.isValidObjectId(videoId)) {
      return res.status(400).json({ message: "Invalid video ID." });
    }

    // Clamp days to prevent abuse (someone requesting 10 years of data)
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const analytics = await VideoViews.aggregate([
      {
        $match: {
          videoId: new mongoose.Types.ObjectId(videoId),
          watchedAt: { $gte: since },
        },
      },
      {
        $group: {
          // Group all views that occurred on the same calendar day (UTC)
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$watchedAt" },
          },
          views: { $sum: 1 },
        },
      },
      // Sort chronologically
      { $sort: { _id: 1 } },
      // Rename _id to "date" for clean API response
      {
        $project: {
          _id: 0,
          date: "$_id",
          views: 1,
        },
      },
    ]);

    return res.status(200).json({ videoId, days, analytics });
  } catch (error) {
    next(error);
  }
}
