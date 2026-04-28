import { WatchHistory } from "../models/watchHistory.model.js";
import {
  buildPaginationOptions,
  buildPaginationMeta,
} from "../utils/playlist/Buildpaginationoptions.js";
import mongoose from "mongoose";

/**
 * ─────────────────────────────────────────────
 * CONTROLLER 1 — Upsert Watch History Entry
 * POST /api/v1/watch-history
 * Auth: Required (verifyJWT)
 * ─────────────────────────────────────────────
 *
 * MISTAKE #8 — Using findOne() + save() instead of findOneAndUpdate() with upsert
 * Problem:  You do findOne(), check if it exists, then either create or update.
 *           Under concurrent requests (same user on two devices), both requests
 *           see "not found", both try to insert → duplicate key error crash.
 * Reason:   This is a classic TOCTOU race condition (Time Of Check, Time Of Use).
 *           Two async operations interleave between your check and your write.
 * Solution: Atomic upsert via findOneAndUpdate with upsert: true. MongoDB performs
 *           the check AND write as a single atomic operation — no race condition possible.
 *
 * MISTAKE #9 — Not using $set and $inc correctly
 * Problem:  Replacing the whole document on update wipes fields you didn't send.
 * Reason:   If you do WatchHistory.updateOne(filter, newData), MongoDB replaces
 *           the document body with newData, deleting any fields not in newData.
 * Solution: Use $set for fields to update, $inc for fields to increment,
 *           $setOnInsert for fields that should only be set on creation.
 *
 * PRODUCTION NOTE — Redis batching:
 * In production, this endpoint is NOT called every 5 seconds.
 * The client sends progress updates to a Redis key (userId:videoId → position).
 * A background worker flushes Redis → MongoDB every 30–60 seconds or on pause/leave.
 * What you see below is the "flush" write — not the per-second update.
 */
export const upsertWatchHistory = async (req, res) => {
  const { videoId, watchedPercent, lastPositionSeconds } = req.body;
  const userId = req.user._id; // set by verifyJWT middleware

  // MISTAKE #10 — Not validating input types/ranges before hitting the DB
  // Problem:  mongoose validation runs, throws a cryptic error, your global
  //           error handler sends a 500 instead of a clean 400.
  // Reason:   Mongoose schema validators only run on save/create, not on
  //           findOneAndUpdate unless you set runValidators: true.
  // Solution: Validate manually here AND set runValidators on the query.
  if (
    typeof watchedPercent !== "number" ||
    watchedPercent < 0 ||
    watchedPercent > 100
  ) {
    return res.status(400).json({
      success: false,
      message: "watchedPercent must be a number between 0 and 100",
    });
  }

  if (typeof lastPositionSeconds !== "number" || lastPositionSeconds < 0) {
    return res.status(400).json({
      success: false,
      message: "lastPositionSeconds must be a non-negative number",
    });
  }

  // Determine if user just completed the video (crossed 95% threshold)
  // We'll increment rewatchCount only when they complete it.
  const isCompleted = watchedPercent >= 95;

  try {
    const entry = await WatchHistory.findOneAndUpdate(
      // Filter — the unique key we're upserting on
      { userId, videoId },

      [
        // Stage 1 — $set with conditional logic using aggregation pipeline update
        // This syntax (array of stages) allows using $cond inside an update,
        // which the simple { $set: {} } syntax does not support.
        {
          $set: {
            watchedPercent,
            lastPositionSeconds,
            watchedAt: new Date(),
            // Only increment rewatchCount if video is completed
            // and previously wasn't completed (watchedPercent was < 95).
            // Using $cond: if new completion AND previous wasn't completed → inc
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
        upsert: true, // Insert if not found, update if found
        new: true, // Return the updated document, not the old one
        runValidators: true, // Run schema validators on update operations too
        // setDefaultsOnInsert: true is implicit with upsert in recent Mongoose
      },
    );

    return res.status(200).json({
      success: true,
      message: isCompleted
        ? "Video marked as completed"
        : "Watch progress saved",
      data: entry,
    });
  } catch (error) {
    // MISTAKE #11 — Swallowing errors or sending stack traces to client
    // Problem:  res.json(error) sends your full stack trace to the user.
    //           This reveals file paths, library versions, internal logic.
    // Reason:   Unhandled errors expose attack surface.
    // Solution: Log the full error server-side (use winston/pino in production),
    //           send only a safe message to the client.
    console.error("upsertWatchHistory error:", error);

    // Handle duplicate key error from race condition (shouldn't happen with
    // atomic upsert, but defensive programming is good practice)
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ success: false, message: "Duplicate entry conflict. Retry." });
    }

    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

/**
 * ─────────────────────────────────────────────
 * CONTROLLER 2 — Get Watch History (Paginated)
 * GET /api/v1/watch-history?page=1&limit=10
 * Auth: Required (verifyJWT)
 * ─────────────────────────────────────────────
 *
 * MISTAKE #12 — Using .populate() instead of aggregation $lookup
 * Problem:  .populate() runs N+1 queries: 1 query for history, then 1 query
 *           PER document to fetch the video. 20 history entries = 21 queries.
 * Reason:   populate() is a Mongoose convenience that hides its cost.
 *           In production with 50 history entries on one page, that's 51 DB round trips.
 * Solution: Use $lookup in an aggregation pipeline. MongoDB fetches everything
 *           in a single query with a join at the database level.
 *
 * MISTAKE #13 — Not getting the total count for pagination metadata
 * Problem:  You fetch page 1 fine, but the client doesn't know if page 2 exists.
 * Reason:   Beginners forget to count total matching documents.
 * Solution: Use $facet in aggregation to get both data AND count in one query.
 *           Without $facet, you'd need 2 separate queries (wasteful).
 */
export const getWatchHistory = async (req, res) => {
  const userId = req.user._id;
  const { page, limit, skip } = buildPaginationOptions(req.query);

  try {
    // TECHNIQUE: Aggregation pipeline with $facet
    // $facet runs multiple sub-pipelines on the same input documents simultaneously.
    // One pipeline gets the paginated data, another counts the total.
    // Result: One DB round trip instead of two.
    const result = await WatchHistory.aggregate([
      // Stage 1: Filter to current user's history only
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },

      // Stage 2: Sort by most recently watched first
      { $sort: { watchedAt: -1 } },

      // Stage 3: $facet — run two pipelines simultaneously
      {
        $facet: {
          // Pipeline A: Get paginated documents with video details
          data: [
            { $skip: skip },
            { $limit: limit },

            // $lookup = SQL JOIN. Fetches matching video document from "videos" collection.
            {
              $lookup: {
                from: "videos", // MongoDB collection name (lowercase, plural)
                localField: "videoId", // Field in WatchHistory
                foreignField: "_id", // Field in Video to match against
                as: "video", // Name of the array field added to each document
                // TECHNIQUE: pipeline inside $lookup lets you project only needed fields.
                // Without this, MongoDB fetches the ENTIRE video document (could be large).
                pipeline: [
                  {
                    $project: {
                      title: 1,
                      thumbnail: 1,
                      duration: 1,
                      channelId: 1,
                    },
                  },
                ],
              },
            },

            // $lookup returns an array. $unwind flattens it to a single object.
            // preserveNullAndEmptyArrays: true keeps history entries even if
            // the video was deleted (instead of silently dropping those records).
            {
              $unwind: {
                path: "$video",
                preserveNullAndEmptyArrays: true,
              },
            },

            // Project final shape — only send what the client needs
            {
              $project: {
                _id: 1,
                watchedPercent: 1,
                lastPositionSeconds: 1,
                rewatchCount: 1,
                watchedAt: 1,
                video: 1, // includes title, thumbnail, duration from lookup
              },
            },
          ],

          // Pipeline B: Count total matching documents
          totalCount: [{ $count: "count" }],
        },
      },
    ]);

    const docs = result[0]?.data || [];
    const totalDocs = result[0]?.totalCount[0]?.count || 0;

    return res.status(200).json({
      success: true,
      data: docs,
      pagination: buildPaginationMeta(totalDocs, page, limit),
    });
  } catch (error) {
    console.error("getWatchHistory error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

/**
 * ─────────────────────────────────────────────
 * CONTROLLER 3 — Get Continue Watching List
 * GET /api/v1/watch-history/continue-watching
 * Auth: Required (verifyJWT)
 * ─────────────────────────────────────────────
 *
 * "Continue watching" = videos the user started (>5%) but hasn't finished (<95%).
 * This is one of YouTube's most used features and needs to be FAST.
 *
 * PRODUCTION NOTE: In a real system, this is cached in Redis with a short TTL
 * (30–60 seconds). The query runs once, result is cached, subsequent requests
 * read from Redis. Only when Redis TTL expires or the user watches something
 * new does it re-query MongoDB. This prevents hammering MongoDB on every
 * page load of the homepage.
 */
export const getContinueWatching = async (req, res) => {
  const userId = req.user._id;
  const { page, limit, skip } = buildPaginationOptions(req.query);

  try {
    const result = await WatchHistory.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          watchedPercent: { $gte: 5, $lte: 95 }, // The "in progress" range
        },
      },
      { $sort: { watchedAt: -1 } }, // Most recently watched first
      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: limit },
            {
              $lookup: {
                from: "videos",
                localField: "videoId",
                foreignField: "_id",
                as: "video",
                pipeline: [
                  {
                    $project: {
                      title: 1,
                      thumbnail: 1,
                      duration: 1,
                    },
                  },
                ],
              },
            },
            { $unwind: { path: "$video", preserveNullAndEmptyArrays: true } },
            {
              $project: {
                lastPositionSeconds: 1,
                watchedPercent: 1,
                watchedAt: 1,
                video: 1,
              },
            },
          ],
          totalCount: [{ $count: "count" }],
        },
      },
    ]);

    const docs = result[0]?.data || [];
    const totalDocs = result[0]?.totalCount[0]?.count || 0;

    return res.status(200).json({
      success: true,
      data: docs,
      pagination: buildPaginationMeta(totalDocs, page, limit),
    });
  } catch (error) {
    console.error("getContinueWatching error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

/**
 * ─────────────────────────────────────────────
 * CONTROLLER 4 — Delete Single Watch History Entry
 * DELETE /api/v1/watch-history/:entryId
 * Auth: Required (verifyJWT)
 * ─────────────────────────────────────────────
 *
 * MISTAKE #14 — Not verifying ownership before deleting
 * Problem:  User A sends DELETE /watch-history/someEntryId.
 *           If you only filter by _id, you delete ANY user's entry.
 * Reason:   MongoDB findByIdAndDelete(id) deletes by _id alone.
 *           An attacker who knows an entry's ObjectId can delete it.
 * Solution: Always include userId in the filter. The compound filter
 *           { _id: entryId, userId: currentUser._id } ensures a user
 *           can only delete their OWN entries. This is called
 *           "ownership check" or "authorization at data level."
 *
 * MISTAKE #15 — Not validating ObjectId format before querying
 * Problem:  findOneAndDelete({ _id: "notAnObjectId" }) throws a
 *           CastError. If unhandled, it returns a 500 to the user.
 * Reason:   MongoDB's ObjectId has a specific 24-char hex format.
 *           An invalid format throws before even hitting the DB.
 * Solution: Validate with mongoose.Types.ObjectId.isValid() first.
 */
export const deleteWatchHistoryEntry = async (req, res) => {
  const { entryId } = req.params;
  const userId = req.user._id;

  // Validate ObjectId format first
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid entry ID format" });
  }

  try {
    const deleted = await WatchHistory.findOneAndDelete({
      _id: entryId,
      userId, // Ownership check — critical
    });

    if (!deleted) {
      // Either doesn't exist OR belongs to another user.
      // Return 404 in both cases — do NOT reveal "it exists but isn't yours."
      // Revealing ownership to unauthorized users is an information leak.
      return res
        .status(404)
        .json({ success: false, message: "Watch history entry not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Watch history entry deleted",
    });
  } catch (error) {
    console.error("deleteWatchHistoryEntry error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

/**
 * ─────────────────────────────────────────────
 * CONTROLLER 5 — Clear All Watch History
 * DELETE /api/v1/watch-history
 * Auth: Required (verifyJWT)
 * ─────────────────────────────────────────────
 *
 * MISTAKE #16 — Using deleteMany without scoping to userId
 * Problem:  WatchHistory.deleteMany({}) deletes EVERYTHING in the collection.
 * Reason:   Empty filter = no filter = match all documents.
 *           One missing userId in the filter and you've wiped the entire table.
 * Solution: Always explicitly scope to { userId }.
 *
 * PRODUCTION NOTE: For very large collections, deleteMany() can lock
 * the collection for a long time. In production, this is done in batches
 * (delete 1000 at a time with a loop and small delays) to avoid blocking
 * other reads/writes. For a beginner's clone, deleteMany is fine.
 */
export const clearAllWatchHistory = async (req, res) => {
  const userId = req.user._id;

  try {
    const result = await WatchHistory.deleteMany({ userId });

    return res.status(200).json({
      success: true,
      message: `Cleared ${result.deletedCount} watch history entries`,
    });
  } catch (error) {
    console.error("clearAllWatchHistory error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

/**
 * ─────────────────────────────────────────────
 * CONTROLLER 6 — Update Watch Progress Only
 * PATCH /api/v1/watch-history/progress
 * Auth: Required (verifyJWT)
 * ─────────────────────────────────────────────
 *
 * This is the "lightweight" version of upsertWatchHistory.
 * Only updates lastPositionSeconds and watchedPercent.
 * Does NOT deal with rewatchCount logic.
 *
 * WHEN TO USE THIS vs. upsertWatchHistory:
 * - upsertWatchHistory: called when user starts/resumes a video (full upsert)
 * - updateWatchProgress: called when flushing Redis progress to MongoDB
 *                        (frequent writes batched into one update)
 *
 * MISTAKE #17 — Using findOne() + entry.save() for frequent updates
 * Problem:  Two DB calls per update: one read, one write.
 *           At 1000 concurrent viewers updating every 30 seconds,
 *           that's 2000 DB operations per 30 seconds from this alone.
 * Reason:   save() triggers a full document validation + full document write.
 * Solution: updateOne() with $set is a partial update — only touches the
 *           specified fields. Faster, less network overhead, no full-doc read needed.
 */
export const updateWatchProgress = async (req, res) => {
  const { videoId, lastPositionSeconds, watchedPercent } = req.body;
  const userId = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(videoId)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid video ID format" });
  }

  if (
    typeof watchedPercent !== "number" ||
    watchedPercent < 0 ||
    watchedPercent > 100 ||
    typeof lastPositionSeconds !== "number" ||
    lastPositionSeconds < 0
  ) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid progress values" });
  }

  try {
    const result = await WatchHistory.updateOne(
      { userId, videoId },
      {
        $set: {
          lastPositionSeconds,
          watchedPercent,
          watchedAt: new Date(),
        },
      },
      { runValidators: true },
    );

    // TECHNIQUE: Check modifiedCount, not matchedCount.
    // matchedCount > 0 means found, but the document might already have
    // the same values so nothing actually changed (modifiedCount = 0).
    // For progress updates this distinction usually doesn't matter,
    // but it's a good habit to understand the difference.
    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "No watch history entry found. Start watching first.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Watch progress updated",
    });
  } catch (error) {
    console.error("updateWatchProgress error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

/**
 * ─────────────────────────────────────────────
 * CONTROLLER 7 — Check if User Watched a Video (RECOMMENDED ADDITION)
 * GET /api/v1/watch-history/check/:videoId
 * Auth: Required (verifyJWT)
 * ─────────────────────────────────────────────
 *
 * Why this controller? The video player needs to know where to resume playback.
 * Without this, the player always starts at 0:00.
 *
 * MISTAKE #18 — Using findOne() when you only need existence + one field
 * Problem:  findOne() fetches the entire document. You only need
 *           lastPositionSeconds and watchedPercent.
 * Reason:   Fetching unnecessary fields wastes network bandwidth and
 *           memory, especially if the document has many fields.
 * Solution: Use .select() to project only needed fields.
 *           In aggregation, use $project. Never fetch what you won't use.
 */
export const checkVideoWatchStatus = async (req, res) => {
  const { videoId } = req.params;
  const userId = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(videoId)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid video ID format" });
  }

  try {
    const entry = await WatchHistory.findOne(
      { userId, videoId },
      // Projection: only fetch these fields (1 = include, 0 = exclude)
      // _id is included by default; explicitly exclude if not needed
      { lastPositionSeconds: 1, watchedPercent: 1, rewatchCount: 1, _id: 0 },
    ).lean(); // .lean() returns a plain JS object instead of a Mongoose Document.
    // Mongoose Documents have methods/getters attached which add overhead.
    // Use .lean() for read-only operations where you don't need to call .save()

    if (!entry) {
      return res.status(200).json({
        success: true,
        watched: false,
        resumeAt: 0,
      });
    }

    return res.status(200).json({
      success: true,
      watched: true,
      resumeAt: entry.lastPositionSeconds,
      watchedPercent: entry.watchedPercent,
      rewatchCount: entry.rewatchCount,
    });
  } catch (error) {
    console.error("checkVideoWatchStatus error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};
