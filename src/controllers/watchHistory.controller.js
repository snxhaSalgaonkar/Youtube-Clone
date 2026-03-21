import mongoose from "mongoose";
import { WatchHistory } from "../models/watchHistory.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";

// ─────────────────────────────────────────────
// FEATURE 1: Save or Update Watch History
// ─────────────────────────────────────────────
// Called every few seconds from the frontend (like YouTube does).
// Uses upsert so re-watching a video updates the record instead of
// throwing a duplicate key error (your unique compound index enforces this).

const saveOrUpdateWatchHistory = asyncHandler(async (req, res) => {
  const { videoId, watchedPercent, lastPositionSeconds } = req.body;
  const userId = req.user._id; // injected by your auth middleware

  // ── Input Validation ──────────────────────────────────────────────────────
  // Beginners often skip this and let garbage data reach the database.
  // Always validate before touching the DB.
  if (!videoId) {
    throw new ApiError(400, "videoId is required");
  }

  // mongoose.isValidObjectId guards against malformed IDs that would
  // cause a CastError deep inside Mongoose — much cleaner error handling.
  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid videoId");
  }

  if (
    watchedPercent === undefined ||
    watchedPercent < 0 ||
    watchedPercent > 100
  ) {
    throw new ApiError(400, "watchedPercent must be between 0 and 100");
  }

  // ── Upsert Logic ──────────────────────────────────────────────────────────
  // findOneAndUpdate with upsert:true means:
  //   - If a record exists for this (userId, videoId) pair → UPDATE it
  //   - If not → CREATE a new one
  // $inc increments rewatchCount only when the document already exists.
  // $setOnInsert sets rewatchCount to 0 only on the very first insert.
  // $set always updates the listed fields.
  const history = await WatchHistory.findOneAndUpdate(
    { userId, videoId },
    {
      $set: {
        watchedPercent,
        lastPositionSeconds: lastPositionSeconds ?? 0,
        watchedAt: new Date(),
      },
      $inc: { rewatchCount: 1 },
    },
    {
      upsert: true,     // create if not found
      new: true,        // return the updated document, not the old one
      runValidators: true, // enforce schema-level min/max rules on update too
    }
  );

  return res
    .status(200)
    .json(new ApiResponse(200, history, "Watch history saved"));
});

// ─────────────────────────────────────────────
// FEATURE 2: Get Watch History (paginated)
// ─────────────────────────────────────────────
// Returns the authenticated user's watch history with full video details.
// Uses aggregation instead of .populate() for better control and performance
// at scale (populate does N+1 queries under the hood for large result sets).

const getWatchHistory = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // ── Pagination ────────────────────────────────────────────────────────────
  // Always paginate list endpoints. Never return the entire collection.
  // Beginners often skip this and crash their server with huge payloads.
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20); // cap at 50
  const skip = (page - 1) * limit;

  const history = await WatchHistory.aggregate([
    {
      // Stage 1: Filter by the logged-in user
      // IMPORTANT: In aggregation, userId is a raw ObjectId — use `new mongoose.Types.ObjectId()`
      // Beginners often pass req.user._id directly which is already an ObjectId,
      // but being explicit prevents subtle type-mismatch bugs.
      $match: { userId: new mongoose.Types.ObjectId(userId) },
    },
    {
      // Stage 2: Sort by most recently watched first
      // Your compound index { userId: 1, watchedAt: -1 } makes this fast.
      $sort: { watchedAt: -1 },
    },
    {
      // Stage 3: Pagination
      $skip: skip,
    },
    {
      $limit: limit,
    },
    {
      // Stage 4: Join with the Video collection
      $lookup: {
        from: "videos",       // MongoDB collection name (lowercase plural)
        localField: "videoId",
        foreignField: "_id",
        as: "video",
        // Pipeline inside lookup lets you project only needed fields
        // instead of pulling the entire video document.
        pipeline: [
          {
            $project: {
              title: 1,
              thumbnail: 1,
              duration: 1,
              owner: 1,
              views: 1,
            },
          },
        ],
      },
    },
    {
      // Stage 5: Unwind flattens the "video" array into a single object.
      // preserveNullAndEmpty ensures entries with deleted videos still appear.
      $unwind: { path: "$video", preserveNullAndEmptyArrays: true },
    },
    {
      // Stage 6: Shape the final output
      $project: {
        _id: 1,
        watchedPercent: 1,
        lastPositionSeconds: 1,
        rewatchCount: 1,
        watchedAt: 1,
        video: 1,
      },
    },
  ]);

  return res
    .status(200)
    .json(
      new ApiResponse(200, { history, page, limit }, "Watch history fetched")
    );
});

// ─────────────────────────────────────────────
// FEATURE 3: Delete a Single Entry
// ─────────────────────────────────────────────
// Deletes one specific video from a user's watch history.
// videoId comes from the URL param (RESTful convention).

const deleteWatchHistoryEntry = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid videoId");
  }

  // findOneAndDelete is preferred over deleteOne when you need to confirm
  // the document existed. If null is returned, the record was not found.
  const deleted = await WatchHistory.findOneAndDelete({ userId, videoId });

  if (!deleted) {
    throw new ApiError(404, "Watch history entry not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Entry removed from watch history"));
});

// ─────────────────────────────────────────────
// FEATURE 4: Clear Entire History
// ─────────────────────────────────────────────
// Deletes ALL watch history for the authenticated user.
// Scoped strictly to req.user._id — never accept userId from the body/params
// for destructive operations (a major security mistake beginners make).

const clearWatchHistory = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const result = await WatchHistory.deleteMany({ userId });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { deletedCount: result.deletedCount },
        "Watch history cleared"
      )
    );
});

// ─────────────────────────────────────────────
// FEATURE 5: Resume Playback ("Continue Watching")
// ─────────────────────────────────────────────
// Returns videos the user has started but not finished.
// The threshold of 95% treats near-complete videos as "done" —
// avoids showing a video as "in progress" when 2 seconds remain.

const getContinueWatching = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const limit = Math.min(20, parseInt(req.query.limit) || 10);

  const history = await WatchHistory.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        watchedPercent: { $gt: 1, $lt: 95 }, // started but not finished
      },
    },
    { $sort: { watchedAt: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: "videos",
        localField: "videoId",
        foreignField: "_id",
        as: "video",
        pipeline: [
          { $project: { title: 1, thumbnail: 1, duration: 1 } },
        ],
      },
    },
    { $unwind: { path: "$video", preserveNullAndEmptyArrays: true } },
    // Filter out history entries where the video has been deleted
    { $match: { video: { $ne: null } } },
    {
      $project: {
        lastPositionSeconds: 1,
        watchedPercent: 1,
        watchedAt: 1,
        video: 1,
      },
    },
  ]);

  return res
    .status(200)
    .json(new ApiResponse(200, history, "Continue watching list fetched"));
});

// ─────────────────────────────────────────────
// FEATURE 6: Check if a Video Was Already Watched
// ─────────────────────────────────────────────
// Lightweight check — used to decide whether to show "Resume" or "Watch"
// on the frontend. Uses lean() for a plain JS object (faster, less memory).

const checkVideoWatched = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid videoId");
  }

  // .lean() returns a plain JS object instead of a Mongoose Document.
  // Use it on read-only queries — it skips hydration and is ~2x faster.
  const entry = await WatchHistory.findOne({ userId, videoId })
    .select("watchedPercent lastPositionSeconds rewatchCount")
    .lean();

  if (!entry) {
    return res
      .status(200)
      .json(new ApiResponse(200, { watched: false }, "Video not watched"));
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        watched: true,
        watchedPercent: entry.watchedPercent,
        lastPositionSeconds: entry.lastPositionSeconds,
        rewatchCount: entry.rewatchCount,
      },
      "Video watch status fetched"
    )
  );
});

// ─────────────────────────────────────────────
// FEATURE 7: Analytics
// ─────────────────────────────────────────────
// Two sub-features:
//   a) Personal analytics for the logged-in user
//   b) Admin analytics — top watched videos globally (admin only)

// 7a — Personal Analytics
const getUserAnalytics = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const analytics = await WatchHistory.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: "$userId",
        totalVideosWatched: { $sum: 1 },
        avgWatchedPercent: { $avg: "$watchedPercent" },
        totalRewatches: { $sum: "$rewatchCount" },
        mostRecentWatch: { $max: "$watchedAt" },
      },
    },
    {
      $project: {
        _id: 0,
        totalVideosWatched: 1,
        avgWatchedPercent: { $round: ["$avgWatchedPercent", 2] },
        totalRewatches: 1,
        mostRecentWatch: 1,
      },
    },
  ]);

  const result = analytics[0] || {
    totalVideosWatched: 0,
    avgWatchedPercent: 0,
    totalRewatches: 0,
    mostRecentWatch: null,
  };

  return res
    .status(200)
    .json(new ApiResponse(200, result, "User analytics fetched"));
});

// 7b — Admin: Top Watched Videos Globally
// Protected by your admin middleware (see notes below)
const getTopWatchedVideos = asyncHandler(async (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit) || 10);

  const topVideos = await WatchHistory.aggregate([
    {
      // Group by videoId and count how many users watched each
      $group: {
        _id: "$videoId",
        totalWatchers: { $sum: 1 },
        avgWatchedPercent: { $avg: "$watchedPercent" },
        totalRewatches: { $sum: "$rewatchCount" },
      },
    },
    { $sort: { totalWatchers: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: "videos",
        localField: "_id",
        foreignField: "_id",
        as: "video",
        pipeline: [{ $project: { title: 1, thumbnail: 1, duration: 1 } }],
      },
    },
    { $unwind: { path: "$video", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        videoId: "$_id",
        video: 1,
        totalWatchers: 1,
        avgWatchedPercent: { $round: ["$avgWatchedPercent", 2] },
        totalRewatches: 1,
      },
    },
  ]);

  return res
    .status(200)
    .json(new ApiResponse(200, topVideos, "Top watched videos fetched"));
});

export {
  saveOrUpdateWatchHistory,
  getWatchHistory,
  deleteWatchHistoryEntry,
  clearWatchHistory,
  getContinueWatching,
  checkVideoWatched,
  getUserAnalytics,
  getTopWatchedVideos,
};