/**
 * VIDEO CONTROLLER — Extended (video.controller.extended.js)
 *
 * Contains 3 additional controllers that belong in the video domain:
 *   1. deleteVideo    — owner permanently removes a video
 *   2. getVideoById   — fetch a single video's full metadata page
 *   3. getUserVideos  — list all videos on a channel/profile with pagination
 *
 * These are kept in a separate file so the original video.controller.js
 * doesn't become too large to read. In production you'd merge them or
 * split by feature (upload, playback, management, analytics...).
 *
 * KEY CONCEPT: Single Responsibility
 * Each controller does exactly ONE thing. A controller that deletes a video
 * AND updates a playlist AND sends an email is hard to test, hard to debug,
 * and breaks in surprising ways. Keep them focused.
 */

import mongoose from "mongoose";
import { Video } from "../models/video.model.js";
// import {
//   Like,
//   Dislike,
//   Comment,
//   Playlist,
//   WatchHistory,
// } from "../models/supporting.models.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { deleteFromCloudinary } from "../utils/cloudinary.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. DELETE A VIDEO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * DELETE /api/v1/videos/:videoId
 *
 * KEY CONCEPT: Cascading Deletes
 * MongoDB does NOT have foreign keys like SQL, so it has no built-in
 * "ON DELETE CASCADE". When you delete a video you must manually clean up
 * every related document in every other collection — otherwise you get
 * "orphaned" documents (likes, comments, history entries pointing to a
 * video that no longer exists). These silently waste storage and cause bugs.
 *
 * Collections to clean up when a video is deleted:
 *   - likes          (Like collection)
 *   - dislikes       (Dislike collection)
 *   - comments       (Comment collection — including replies)
 *   - watch history  (WatchHistory collection)
 *   - playlists      ($pull the videoId from every playlist's videos array)
 *   - Cloudinary     (delete the actual video file and thumbnail — costs money!)
 *
 * KEY CONCEPT: deleteMany vs deleteOne
 * deleteOne removes the first matching document.
 * deleteMany removes ALL matching documents — use this for cascade deletes
 * where multiple documents reference the deleted video.
 *
 * KEY CONCEPT: Promise.allSettled() vs Promise.all()
 * Promise.all() fails fast — if ANY cleanup step throws, the whole thing
 * rejects and the remaining steps are skipped. The video might be deleted
 * from MongoDB but its Cloudinary files are left behind (orphaned storage cost).
 *
 * Promise.allSettled() runs ALL steps regardless of individual failures.
 * We can then log which ones failed and alert/retry, without leaving the
 * system in a half-cleaned state.
 *
 * COMMON BEGINNER MISTAKE: Only deleting the Video document and forgetting
 * all related data. Over time, orphaned likes/comments/history pile up and
 * inflate your database size with useless data.
 *
 * SECURITY TIPS:
 * 1. Always verify ownership before deleting (authorization check).
 * 2. Use soft delete in production systems — add a `deletedAt` timestamp
 *    instead of removing the document. This lets you recover from mistakes
 *    and keeps analytics data intact.
 * 3. Never expose Cloudinary public IDs to the client — keep them
 *    server-side only and extract them from the stored URL internally.
 *
 * SYSTEM FAILURE TIP: Cloudinary deletion should happen AFTER the DB
 * record is removed. If DB removal fails, no harm done — file still exists.
 * If you delete the file FIRST and then the DB fails, the URL in your DB
 * points to a file that no longer exists — broken thumbnails everywhere.
 */
export const deleteVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  // Step 1 — Validate the ID format before hitting the DB
  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  // Step 2 — Fetch the video (we need owner + file URLs for cleanup)
  const video = await Video.findById(videoId);

  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  // Step 3 — Authorization: only the owner can delete
  if (video.owner.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Forbidden: You do not own this video");
  }

  // Step 4 — Delete the Video document from MongoDB FIRST
  // (before any cleanup, so subsequent requests immediately get a 404)
  await Video.findByIdAndDelete(videoId);

  /**
   * Step 5 — Cascade: clean up all related data
   *
   * KEY CONCEPT: Extracting Cloudinary public_id from URL
   * Cloudinary URLs look like:
   *   https://res.cloudinary.com/<cloud>/video/upload/v123/<public_id>.mp4
   * The public_id is everything after the last "/" and before the extension.
   * We extract it to call cloudinary.uploader.destroy(public_id).
   *
   * Store the public_id separately in your Video schema if you want
   * to avoid this string parsing — it's cleaner and more reliable.
   */
  const extractPublicId = (url) => {
    if (!url) return null;
    try {
      const parts = url.split("/");
      const fileWithExt = parts[parts.length - 1];
      return fileWithExt.split(".")[0]; // strip extension
    } catch {
      return null;
    }
  };

  const videoPublicId = extractPublicId(video.videoFile);
  const thumbnailPublicId = extractPublicId(video.thumbnail);

  // Run all cleanup steps concurrently — use allSettled so none block others
  const cleanupResults = await Promise.allSettled([
    // Remove all likes for this video
    Like.deleteMany({ video: videoId }),

    // Remove all dislikes for this video
    Dislike.deleteMany({ video: videoId }),

    // Remove all comments (including replies) for this video
    // KEY CONCEPT: This deletes BOTH top-level comments AND replies in one shot
    // because all comments (parent or child) have the same `video` field.
    Comment.deleteMany({ video: videoId }),

    // Remove all watch history entries for this video
    WatchHistory.deleteMany({ video: videoId }),

    // Pull this video out of every playlist it was added to
    // KEY CONCEPT: $pull removes a specific value from an array field.
    // This updates EVERY playlist document that contains this videoId.
    Playlist.updateMany({ videos: videoId }, { $pull: { videos: videoId } }),

    // Delete actual files from Cloudinary
    // Only attempt if we successfully extracted a public ID
    videoPublicId
      ? deleteFromCloudinary(videoPublicId, "video")
      : Promise.resolve(null),

    thumbnailPublicId
      ? deleteFromCloudinary(thumbnailPublicId, "image")
      : Promise.resolve(null),
  ]);

  // Log any cleanup failures (don't throw — the video is already deleted)
  cleanupResults.forEach((result, index) => {
    if (result.status === "rejected") {
      const labels = [
        "likes",
        "dislikes",
        "comments",
        "watchHistory",
        "playlists",
        "cloudinary video",
        "cloudinary thumbnail",
      ];
      // In production: send this to your logging/alerting service (Sentry, Datadog)
      console.error(
        `[deleteVideo] Cleanup failed for ${labels[index]}:`,
        result.reason,
      );
    }
  });

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Video deleted successfully"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET VIDEO BY ID (single video detail/metadata page)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/v1/videos/:videoId
 *
 * KEY CONCEPT: getVideoById vs playVideo — what's the difference?
 *
 * playVideo (built earlier):
 *   - Triggers playback — increments view count, saves to watch history,
 *     fetches resume position. Called when the user actually PLAYS the video.
 *
 * getVideoById (this one):
 *   - Fetches full metadata for the video detail page — owner info, stats,
 *     related data — WITHOUT incrementing views or touching history.
 *   - Called when the page first loads (before the user hits play).
 *   - Think of it as: "show me everything ABOUT this video."
 *
 * KEY CONCEPT: MongoDB Aggregation Pipeline with $lookup
 * We use aggregation here (instead of find + populate) because we need to:
 * 1. Join the owner's user data ($lookup on users collection)
 * 2. Check if the requesting user has liked/subscribed ($lookup on likes)
 * 3. Add computed fields ($addFields)
 * All in a single DB round-trip — much faster than 3 separate queries.
 *
 * KEY CONCEPT: $lookup with pipeline (advanced lookup)
 * A standard $lookup joins two collections by matching a field.
 * A $lookup with a nested pipeline lets you filter/project WITHIN the join —
 * so you don't pull the entire user document just to get username + avatar.
 *
 * COMMON BEGINNER MISTAKE: Using populate() for every relation, even when
 * you only need 2 fields from the related document. populate() fetches the
 * entire document and discards the rest — wasteful on large documents.
 * Use $lookup with $project for precise field selection.
 *
 * SECURITY TIP: Never return the owner's password, email, refresh token,
 * or any private field. Use $project to whitelist only safe fields.
 */
export const getVideoById = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  /**
   * KEY CONCEPT: Aggregation pipeline stages explained
   *
   * $match   — filter to the one video we want (like find())
   * $lookup  — join another collection (like SQL JOIN)
   * $unwind  — convert a single-item array from $lookup into an object
   * $addFields — add computed fields to the document
   * $project — whitelist which fields to return (and exclude the rest)
   */
  const pipeline = [
    // Stage 1: get the specific video
    {
      $match: { _id: new mongoose.Types.ObjectId(videoId) },
    },

    // Stage 2: join the owner's user data
    {
      $lookup: {
        from: "users", // MongoDB collection name (lowercase, plural)
        localField: "owner", // field in Video document
        foreignField: "_id", // field in User document
        as: "owner", // output field name
        pipeline: [
          {
            // Only fetch safe, public fields from the user
            $project: {
              username: 1,
              fullName: 1,
              avatar: 1,
              subscribersCount: 1, // if you have this field on User
            },
          },
        ],
      },
    },

    // Stage 3: $lookup returns an array — unwrap it to a single object
    // COMMON BEGINNER MISTAKE: Forgetting $unwind after $lookup.
    // Without it, owner is an array: [{ username: "..." }] instead of { username: "..." }
    { $unwind: "$owner" },

    // Stage 4: check if the requesting user has liked this video
    // This produces an array of matching Like documents (0 or 1 items)
    {
      $lookup: {
        from: "likes",
        localField: "_id",
        foreignField: "video",
        as: "likesData",
        pipeline: [
          // Only look for the requesting user's like — don't fetch all likes
          ...(req.user
            ? [{ $match: { user: new mongoose.Types.ObjectId(req.user._id) } }]
            : []),
          { $project: { _id: 1 } }, // we only need to know IF it exists
        ],
      },
    },

    // Stage 5: add computed/derived fields
    {
      $addFields: {
        // Convert the likesData array into a boolean
        // $gt: [{ $size: "$likesData" }, 0] → true if array has at least 1 item
        isLikedByUser: { $gt: [{ $size: "$likesData" }, 0] },
      },
    },

    // Stage 6: select exactly what the client needs — nothing more
    {
      $project: {
        videoFile: 1,
        hlsUrl: 1,
        thumbnail: 1,
        title: 1,
        description: 1,
        duration: 1,
        views: 1,
        likeCount: 1,
        commentCount: 1,
        status: 1,
        visibility: 1,
        tags: 1,
        category: 1,
        isPublished: 1,
        createdAt: 1,
        updatedAt: 1,
        owner: 1, // safe projected fields from Stage 2
        isLikedByUser: 1, // computed in Stage 5
        // likesData is intentionally excluded — internal use only
      },
    },
  ];

  const [video] = await Video.aggregate(pipeline);
  // aggregate() always returns an array — destructure the first (and only) item

  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  // Access control — check after fetching so we can give a proper 403 vs 404
  // SECURITY TIP: For private videos, returning 404 instead of 403 is actually
  // better security — it doesn't reveal that the video EXISTS to unauthorized users.
  if (video.visibility === "private") {
    if (!req.user || video.owner._id.toString() !== req.user._id.toString()) {
      throw new ApiError(404, "Video not found");
    }
  }

  if (video.status !== "ready") {
    // Only the owner should see a non-ready video (e.g., still processing)
    if (!req.user || video.owner._id.toString() !== req.user._id.toString()) {
      throw new ApiError(404, "Video not found");
    }
  }

  return res
    .status(200)
    .json(new ApiResponse(200, video, "Video fetched successfully"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET USER'S VIDEOS (channel/profile page video list)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/v1/videos/user/:userId?page=1&limit=12&sort=newest&visibility=public
 *
 * KEY CONCEPT: Two different use cases for one endpoint
 *
 * Case A — Viewing ANOTHER user's channel:
 *   Only show public + published + ready videos.
 *   The `visibility` query param is ignored (forced to "public").
 *
 * Case B — Viewing YOUR OWN channel dashboard:
 *   Show ALL your videos including private, unlisted, pending, failed.
 *   The `visibility` query param is respected (can filter by private/unlisted).
 *
 * We detect which case we're in by comparing userId to req.user._id.
 * This single endpoint serves both the public channel page and the
 * private creator dashboard — with different data for each.
 *
 * KEY CONCEPT: Lean queries with .select() and .lean()
 * By default Mongoose returns full Model instances with all methods attached.
 * .lean() returns plain JavaScript objects — ~2-3× faster, less memory.
 * Use .lean() when you're only READING data (no .save() needed after).
 *
 * KEY CONCEPT: Compound sort for stable pagination
 * Sorting by only `createdAt` can produce unstable results if two videos
 * were created at the exact same millisecond (unlikely but possible).
 * Adding `_id` as a secondary sort guarantees a stable order because
 * ObjectIds are always unique.
 *
 * COMMON BEGINNER MISTAKE: Fetching ALL of a user's videos and filtering
 * them in JavaScript (application-level filtering). Always filter in the
 * database query — MongoDB only sends what you ask for.
 *
 * SECURITY TIP: Never use req.query values directly as MongoDB field names
 * or values without validation. A user could pass sort=__proto__ or
 * visibility={"$ne": "private"} (NoSQL injection). Always validate against
 * an explicit allowlist of values.
 */
export const getUserVideos = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const {
    page = 1,
    limit = 12,
    sort = "newest", // newest | oldest | popular | mostLiked
    visibility, // public | private | unlisted (only honored if own channel)
  } = req.query;

  // Step 1 — Validate userId
  if (!mongoose.isValidObjectId(userId)) {
    throw new ApiError(400, "Invalid user ID");
  }

  // Step 2 — Pagination bounds
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(50, Math.max(1, parseInt(limit))); // cap at 50
  const skip = (pageNum - 1) * limitNum;

  // Step 3 — Determine if viewer is the owner (decides what they can see)
  const isOwnChannel =
    req.user && req.user._id.toString() === userId.toString();

  // Step 4 — Build the filter
  const filter = { owner: new mongoose.Types.ObjectId(userId) };

  if (isOwnChannel) {
    /**
     * Owner viewing their own dashboard — respect optional visibility filter.
     * SECURITY: Validate against allowlist — never pass raw query value to MongoDB.
     */
    const allowedVisibilities = ["public", "private", "unlisted"];
    if (visibility && allowedVisibilities.includes(visibility)) {
      filter.visibility = visibility;
    }
    // No status filter — owner can see pending/failed videos too
  } else {
    // Public viewer — force public + ready + published only
    filter.visibility = "public";
    filter.status = "ready";
    filter.isPublished = true;
  }

  // Step 5 — Build sort object
  // SECURITY: Validate sort param against allowlist
  const sortOptions = {
    newest: { createdAt: -1, _id: -1 }, // -1 = descending (newest first)
    oldest: { createdAt: 1, _id: 1 }, // 1 = ascending (oldest first)
    popular: { views: -1, createdAt: -1 },
    mostLiked: { likeCount: -1, createdAt: -1 },
  };
  const sortStage = sortOptions[sort] || sortOptions.newest;

  // Step 6 — Run the query + count in parallel
  /**
   * KEY CONCEPT: Running queries in parallel with Promise.all
   * Instead of:
   *   const videos = await Video.find(...)  // wait...
   *   const total  = await Video.countDocuments(...) // then wait again
   *
   * We fire both at the same time:
   *   const [videos, total] = await Promise.all([find, count])
   * Total time = max(find time, count time) instead of find + count.
   */
  const [videos, total] = await Promise.all([
    Video.find(filter)
      .sort(sortStage)
      .skip(skip)
      .limit(limitNum)
      .select(
        // Select only what the video card UI needs — not the full document
        "title thumbnail duration views likeCount commentCount " +
          "visibility status isPublished createdAt category",
      )
      .lean(), // plain objects — faster, less memory

    Video.countDocuments(filter),
  ]);

  // Step 7 — Build pagination metadata for the frontend
  const totalPages = Math.ceil(total / limitNum);
  const hasNextPage = pageNum < totalPages;
  const hasPrevPage = pageNum > 1;

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        videos,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages,
          hasNextPage,
          hasPrevPage,
        },
        // Tell the client whether this is the owner's own channel
        // so it can conditionally show edit/delete buttons
        isOwnChannel,
      },
      "Videos fetched successfully",
    ),
  );
});
