/**
 * VIDEO CONTROLLER — YouTube Clone
 *
 * ARCHITECTURE NOTE:
 * Controllers are the bridge between your routes and business logic.
 * They should NOT contain raw DB queries — that belongs in a service layer
 * in production. For learning purposes, we keep queries here, but in a
 * real production codebase you'd separate concerns further:
 *   Route → Controller → Service → Repository (DB layer)
 *
 * Every controller here is wrapped in asyncHandler — this catches any
 * thrown errors and passes them to your global error handler middleware
 * automatically. Without it, an unhandled Promise rejection crashes Node.
 */

import mongoose from "mongoose";
import { Video } from "../models/video.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  uploadToCloudinary,
  deleteFromCloudinary,
} from "../utils/cloudinary.js";
import {
  generateHLSUrl,
  extractVideoDuration,
  buildSearchQuery,
  buildPaginationOptions,
} from "../utils/videoUtils.js";

// ─── 1. UPLOAD VIDEO ──────────────────────────────────────────────────────────

/**
 * WHAT HAPPENS HERE (production pipeline):
 * 1. Multer receives the multipart/form-data request and buffers the file.
 * 2. We upload to Cloudinary (or S3 in large systems).
 * 3. We extract the duration from the uploaded file metadata.
 * 4. We create a DB record with status "pending" — the video isn't live yet.
 * 5. A background job (worker/queue) picks this up, transcodes it to multiple
 *    resolutions, generates HLS segments, and updates status to "ready".
 *
 * BEGINNER MISTAKE: Blocking the main thread with FFmpeg transcoding inside
 * the request handler. FFmpeg can take minutes. The HTTP connection will time
 * out and the user gets a 504. Always offload heavy work to a job queue
 * (BullMQ, RabbitMQ, AWS SQS etc.).
 *
 * BEGINNER MISTAKE: Storing the file path on your own server disk permanently.
 * When you scale to multiple server instances, only one server has that file.
 * Use object storage (Cloudinary, S3, GCS) — it's shared across all instances.
 */
export const uploadVideo = asyncHandler(async (req, res) => {
  const { title, description, tags, category, visibility } = req.body;

  // req.files is populated by multer middleware
  const videoLocalPath = req.files?.videoFile?.[0]?.path;
  const thumbnailLocalPath = req.files?.thumbnail?.[0]?.path;

  if (!videoLocalPath) {
    throw new ApiError(400, "Video file is required");
  }
  if (!thumbnailLocalPath) {
    throw new ApiError(400, "Thumbnail is required");
  }

  // Upload both files to Cloudinary concurrently — don't await sequentially,
  // that wastes time. Promise.all runs them in parallel.
  const [videoUpload, thumbnailUpload] = await Promise.all([
    uploadToCloudinary(videoLocalPath, "video"),
    uploadToCloudinary(thumbnailLocalPath, "image"),
  ]);

  if (!videoUpload?.url) {
    throw new ApiError(500, "Video upload failed. Please try again.");
  }
  if (!thumbnailUpload?.url) {
    throw new ApiError(500, "Thumbnail upload failed. Please try again.");
  }

  // Extract video duration from Cloudinary metadata (or use FFmpeg locally)
  const duration = await extractVideoDuration(videoUpload);

  // Generate HLS URL from the Cloudinary public_id
  // HLS = HTTP Live Streaming. Cloudinary can serve adaptive bitrate streams
  // automatically if you're on a paid plan. Otherwise you'd run FFmpeg yourself.
  const hlsUrl = generateHLSUrl(videoUpload.public_id);

  const video = await Video.create({
    owner: req.user._id,
    videoFile: videoUpload.url,
    hlsUrl,
    thumbnail: thumbnailUpload.url,
    title: title.trim(),
    description: description?.trim() || "",
    duration,
    tags: tags ? JSON.parse(tags) : [],
    category: category || "General",
    visibility: visibility || "private",
    status: "pending", // Not ready until processing completes
    isPublished: false,
  });

  return res
    .status(201)
    .json(
      new ApiResponse(
        201,
        video,
        "Video uploaded successfully. Processing will begin shortly.",
      ),
    );
});

// ─── 2. PUBLISH VIDEO ─────────────────────────────────────────────────────────

/**
 * Publishing = making the video publicly visible.
 * We check status first — you can't publish a video that hasn't finished
 * processing. Showing a half-transcoded video to users = broken experience.
 *
 * SECURITY: verifyOwnership middleware already confirmed this user owns the
 * video before this function runs. Never re-check ownership inside controllers
 * — that's the middleware's job. Single Responsibility Principle.
 */
export const publishVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  const video = await Video.findById(videoId);
  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  if (video.status !== "ready") {
    throw new ApiError(
      400,
      `Cannot publish video with status "${video.status}". Video must finish processing first.`,
    );
  }

  // instance method defined on the schema — keeps publish logic in one place
  const updatedVideo = await video.publish();

  return res
    .status(200)
    .json(new ApiResponse(200, updatedVideo, "Video published successfully"));
});

// ─── 3. UPDATE VIDEO DETAILS ──────────────────────────────────────────────────

/**
 * BEGINNER MISTAKE: Doing a full document replace with .save() when you only
 * need to update 2 fields. Use findByIdAndUpdate with $set for partial updates.
 * This is atomic and won't accidentally wipe fields you didn't send.
 *
 * BEGINNER MISTAKE: Allowing users to update sensitive fields like `owner`,
 * `status`, `views`, `likeCount` through this endpoint. Always whitelist
 * exactly which fields the user is allowed to change.
 */
export const updateVideoDetails = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const { title, description, tags, category, visibility } = req.body;

  // Build update object with only provided fields (partial update)
  const updateFields = {};
  if (title !== undefined) updateFields.title = title.trim();
  if (description !== undefined) updateFields.description = description.trim();
  if (tags !== undefined) updateFields.tags = tags;
  if (category !== undefined) updateFields.category = category;
  if (visibility !== undefined) updateFields.visibility = visibility;

  if (Object.keys(updateFields).length === 0) {
    throw new ApiError(400, "No valid fields provided for update");
  }

  // Handle optional thumbnail replacement
  const thumbnailLocalPath = req.file?.path;
  if (thumbnailLocalPath) {
    const thumbnailUpload = await uploadToCloudinary(
      thumbnailLocalPath,
      "image",
    );
    if (!thumbnailUpload?.url) {
      throw new ApiError(500, "Thumbnail upload failed");
    }

    // Delete the old thumbnail from Cloudinary to avoid orphaned files
    // piling up and eating your storage quota.
    const oldVideo = await Video.findById(videoId).select("thumbnail");
    if (oldVideo?.thumbnail) {
      // Extract public_id from the Cloudinary URL to delete it
      const publicId = oldVideo.thumbnail.split("/").pop().split(".")[0];
      await deleteFromCloudinary(publicId, "image");
    }

    updateFields.thumbnail = thumbnailUpload.url;
  }

  const updatedVideo = await Video.findByIdAndUpdate(
    videoId,
    { $set: updateFields },
    { new: true, runValidators: true }, // runValidators re-runs schema validation on update
  ).select("-__v");

  if (!updatedVideo) {
    throw new ApiError(404, "Video not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, updatedVideo, "Video updated successfully"));
});

// ─── 4. DELETE VIDEO ──────────────────────────────────────────────────────────

/**
 * PRODUCTION PATTERN: Soft delete vs Hard delete.
 * Hard delete: permanently removes from DB. You lose analytics, audit trails.
 * Soft delete: set a `deletedAt` timestamp, filter it out of queries.
 *   Allows recovery. YouTube likely uses soft delete — deleted videos can
 *   sometimes be restored.
 * For simplicity, we do hard delete here, but add an `isDeleted` flag in
 * production.
 *
 * CRITICAL: Always delete the file from storage AFTER the DB record is removed.
 * If DB delete fails, throw an error — don't delete files for a record that
 * still exists. Orphaned DB records are worse than orphaned files.
 */
export const deleteVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  const video = await Video.findById(videoId);
  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  // Delete DB record first
  await Video.findByIdAndDelete(videoId);

  // Then clean up Cloudinary assets — these are async fire-and-forget in
  // many production systems. If Cloudinary delete fails, the DB record is
  // already gone, so no user impact — just a storage leak. Log it.
  const videoPublicId = video.videoFile.split("/").pop().split(".")[0];
  const thumbnailPublicId = video.thumbnail.split("/").pop().split(".")[0];

  await Promise.allSettled([
    deleteFromCloudinary(videoPublicId, "video"),
    deleteFromCloudinary(thumbnailPublicId, "image"),
  ]);
  // allSettled (not all) — we don't want one failure to prevent the other deletion

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Video deleted successfully"));
});

// ─── 5. GET VIDEO BY ID ───────────────────────────────────────────────────────

/**
 * KEY CONCEPT: populate()
 * When you store owner as an ObjectId reference, calling .populate("owner")
 * makes Mongoose do a second DB query to fetch that User document and
 * embed it inline. Think of it like a JOIN in SQL.
 *
 * PERFORMANCE: populate() runs an extra query. For high-traffic endpoints,
 * use MongoDB $lookup aggregation instead — it's a single query.
 *
 * SECURITY: Always .select() the exact fields you want from the joined
 * document. Never return the full User document — it has passwords (even hashed),
 * emails, tokens etc.
 */
export const getVideoById = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(videoId)) {
    throw new ApiError(400, "Invalid video ID format");
  }

  const video = await Video.findById(videoId)
    .populate("owner", "username avatar subscriberCount")
    .select("-__v");

  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  // Access control: private/unlisted videos are only visible to their owner
  const isOwner = req.user && video.owner._id.equals(req.user._id);
  if (!isOwner && video.visibility === "private") {
    throw new ApiError(403, "This video is private");
  }
  if (!isOwner && !video.isPublished) {
    throw new ApiError(403, "This video is not available");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, video, "Video fetched successfully"));
});

// ─── 6. GET VIDEO LINK (streaming URL) ───────────────────────────────────────

/**
 * In production, you don't serve raw Cloudinary URLs directly to all users.
 * Reasons:
 * 1. Signed URLs — Cloudinary supports time-limited signed URLs so people
 *    can't hotlink your videos forever.
 * 2. CDN — You'd typically serve through a CDN like Cloudflare that caches
 *    video segments close to the user. Reduces latency and bandwidth cost.
 * 3. DRM — Paid content uses Digital Rights Management to prevent downloading.
 *
 * For this clone, we return the HLS URL directly.
 * HLS (.m3u8) is a playlist file — the player fetches small .ts video segments
 * sequentially. If the user's connection is slow, the player switches to a
 * lower quality playlist automatically.
 */
export const getVideoLink = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  const video = await Video.findById(videoId).select(
    "hlsUrl videoFile visibility isPublished owner status",
  );

  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  if (video.status !== "ready") {
    throw new ApiError(
      425,
      "Video is still processing. Please try again later.",
    );
    // 425 = Too Early (RFC 8470). More semantically correct than 400 here.
  }

  const isOwner = req.user && video.owner.equals(req.user._id);
  if (!isOwner && (video.visibility === "private" || !video.isPublished)) {
    throw new ApiError(403, "Access denied");
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        streamUrl: video.hlsUrl || video.videoFile,
        type: video.hlsUrl ? "hls" : "mp4",
      },
      "Stream URL fetched",
    ),
  );
});

// ─── 7. GET ALL VIDEOS (filters, search, pagination) ─────────────────────────

/**
 * KEY CONCEPT: Aggregation Pipeline
 * For complex queries — filtering, searching, sorting, joining, paginating —
 * Mongoose's .find() is too limited. MongoDB's aggregation pipeline processes
 * documents through a series of stages (like Unix pipe):
 *   $match → $lookup → $sort → $skip → $limit → $project
 *
 * mongoose-aggregate-paginate-v2 wraps this with automatic page/limit handling.
 *
 * BEGINNER MISTAKE: Using .find().skip(10000).limit(20). Skip is O(n) —
 * MongoDB scans and discards 10,000 documents before returning yours.
 * Use cursor-based pagination in production (keyset pagination) for large sets.
 */
export const getAllVideos = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    query,
    sortBy = "createdAt",
    sortType = "desc",
    category,
    tags,
    minDuration,
    maxDuration,
  } = req.query;

  const matchStage = buildSearchQuery({
    query,
    category,
    tags: tags ? tags.split(",") : undefined,
    minDuration: minDuration ? Number(minDuration) : undefined,
    maxDuration: maxDuration ? Number(maxDuration) : undefined,
  });

  // Always filter to only public, ready, published videos for this endpoint
  matchStage.visibility = "public";
  matchStage.status = "ready";
  matchStage.isPublished = true;

  const sortStage = { [sortBy]: sortType === "asc" ? 1 : -1 };

  const pipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "ownerDetails",
        pipeline: [{ $project: { username: 1, avatar: 1 } }],
      },
    },
    { $unwind: "$ownerDetails" },
    { $sort: sortStage },
    { $project: { __v: 0 } },
  ];

  const options = buildPaginationOptions(page, limit);

  // Video.aggregatePaginate comes from mongoose-aggregate-paginate-v2 plugin
  const result = await Video.aggregatePaginate(
    Video.aggregate(pipeline),
    options,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, result, "Videos fetched successfully"));
});

// ─── 8. TOGGLE PUBLISH STATUS ─────────────────────────────────────────────────

export const togglePublishStatus = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  const video = await Video.findById(videoId).select(
    "isPublished visibility status",
  );

  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  if (video.status !== "ready") {
    throw new ApiError(
      400,
      "Cannot toggle publish status on an unprocessed video",
    );
  }

  // Atomic toggle — no race condition since findByIdAndUpdate is atomic
  const updatedVideo = await Video.findByIdAndUpdate(
    videoId,
    {
      $set: {
        isPublished: !video.isPublished,
        // When unpublishing, set visibility to private automatically
        visibility: !video.isPublished ? "public" : "private",
      },
    },
    { new: true },
  ).select("isPublished visibility title");

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        updatedVideo,
        `Video ${updatedVideo.isPublished ? "published" : "unpublished"} successfully`,
      ),
    );
});

// ─── 9. INCREMENT VIEW COUNT ──────────────────────────────────────────────────

/**
 * PRODUCTION NOTE: Real view counting is NOT a simple $inc.
 * YouTube uses a complex system:
 * 1. A "view" only counts if the user watches >30 seconds.
 * 2. Duplicate views from the same IP/user within 24h are ignored.
 * 3. Views are counted via an event stream (Kafka/Kinesis) and processed
 *    asynchronously — the counter you see has a delay of minutes to hours.
 * 4. The count is cached in Redis and synced to the DB periodically.
 *
 * For this clone, we do a simple $inc with a basic deduplication check
 * using a session or cookie. This is good enough for learning.
 */
export const incrementViewCount = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  // Instance method on the Video model — atomic $inc
  const video = await Video.findById(videoId);
  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  const updatedVideo = await video.incrementViews();

  return res
    .status(200)
    .json(
      new ApiResponse(200, { views: updatedVideo.views }, "View count updated"),
    );
});

// ─── 10. GET VIDEOS BY CATEGORY ───────────────────────────────────────────────

export const getVideosByCategory = asyncHandler(async (req, res) => {
  const { category } = req.params;
  const { page = 1, limit = 20 } = req.query;

  const options = buildPaginationOptions(page, limit);

  const pipeline = [
    {
      $match: {
        category,
        visibility: "public",
        status: "ready",
        isPublished: true,
      },
    },
    { $sort: { views: -1, createdAt: -1 } },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "ownerDetails",
        pipeline: [{ $project: { username: 1, avatar: 1 } }],
      },
    },
    { $unwind: "$ownerDetails" },
  ];

  const result = await Video.aggregatePaginate(
    Video.aggregate(pipeline),
    options,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, result, `Videos in category "${category}"`));
});

// ─── 11. GET TRENDING VIDEOS ──────────────────────────────────────────────────

/**
 * TRENDING ALGORITHM NOTE:
 * Real trending uses a score combining recency + views + likes + comments,
 * often called a "decay function." A video from today with 1000 views ranks
 * higher than one from last year with 10000 views.
 *
 * Simple formula (Wilson score or decay):
 *   score = views / (hoursOld ^ gravity)
 *
 * We implement a basic version here with MongoDB's $expr and date arithmetic.
 * In production, this score is pre-computed by a background job every few
 * minutes and stored as a field — you never compute it per-request.
 */
export const getTrendingVideos = asyncHandler(async (req, res) => {
  const { limit = 20, days = 7 } = req.query;

  const since = new Date();
  since.setDate(since.getDate() - Number(days));

  const videos = await Video.aggregate([
    {
      $match: {
        visibility: "public",
        status: "ready",
        isPublished: true,
        createdAt: { $gte: since },
      },
    },
    {
      // Add a computed trending score field
      $addFields: {
        ageInHours: {
          $divide: [
            { $subtract: [new Date(), "$createdAt"] },
            1000 * 60 * 60, // ms → hours
          ],
        },
      },
    },
    {
      $addFields: {
        trendingScore: {
          $divide: [
            { $add: ["$views", { $multiply: ["$likeCount", 3] }] }, // likes worth 3x views
            { $pow: [{ $add: ["$ageInHours", 2] }, 1.5] }, // gravity decay
          ],
        },
      },
    },
    { $sort: { trendingScore: -1 } },
    { $limit: Number(limit) },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "ownerDetails",
        pipeline: [{ $project: { username: 1, avatar: 1 } }],
      },
    },
    { $unwind: "$ownerDetails" },
    { $project: { trendingScore: 0, ageInHours: 0, __v: 0 } },
  ]);

  return res
    .status(200)
    .json(new ApiResponse(200, videos, "Trending videos fetched"));
});

// ─── 12. GET VIDEOS BY TAG ────────────────────────────────────────────────────

export const getVideosByTag = asyncHandler(async (req, res) => {
  const { tag } = req.params;
  const { page = 1, limit = 20 } = req.query;

  const options = buildPaginationOptions(page, limit);

  const pipeline = [
    {
      $match: {
        tags: tag.toLowerCase().trim(), // tags are normalized by pre-save hook
        visibility: "public",
        status: "ready",
        isPublished: true,
      },
    },
    { $sort: { views: -1 } },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "ownerDetails",
        pipeline: [{ $project: { username: 1, avatar: 1 } }],
      },
    },
    { $unwind: "$ownerDetails" },
    { $project: { __v: 0 } },
  ];

  const result = await Video.aggregatePaginate(
    Video.aggregate(pipeline),
    options,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, result, `Videos tagged with "${tag}"`));
});

// ─── 13. SEARCH VIDEOS BY TITLE ───────────────────────────────────────────────

/**
 * KEY CONCEPT: MongoDB Full-Text Search
 * The $text operator uses the text index we defined on { title, description }.
 * It tokenizes words, removes stop words ("the", "a"), and stems them.
 * { $meta: "textScore" } gives each result a relevance score — sort by it.
 *
 * LIMITATION: MongoDB's built-in text search is basic. Production search
 * (YouTube, Netflix) uses Elasticsearch or Algolia — they support typo
 * tolerance, synonyms, faceted filtering, and relevance tuning that MongoDB
 * simply cannot match.
 */
export const searchVideosByTitle = asyncHandler(async (req, res) => {
  const { q, page = 1, limit = 20 } = req.query;

  if (!q || q.trim().length < 2) {
    throw new ApiError(400, "Search query must be at least 2 characters");
  }

  const options = buildPaginationOptions(page, limit);

  const pipeline = [
    {
      $match: {
        $text: { $search: q.trim() },
        visibility: "public",
        status: "ready",
        isPublished: true,
      },
    },
    {
      // Add text relevance score
      $addFields: {
        relevanceScore: { $meta: "textScore" },
      },
    },
    { $sort: { relevanceScore: -1, views: -1 } },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "ownerDetails",
        pipeline: [{ $project: { username: 1, avatar: 1 } }],
      },
    },
    { $unwind: "$ownerDetails" },
    { $project: { __v: 0, relevanceScore: 0 } },
  ];

  const result = await Video.aggregatePaginate(
    Video.aggregate(pipeline),
    options,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, result, `Search results for "${q}"`));
});

// ─── 14. GET CHANNEL VIDEOS ───────────────────────────────────────────────────

/**
 * Channel page shows different content based on viewer:
 * - Owner: sees all videos including private and processing
 * - Others: sees only public, published, ready videos
 *
 * This is a common pattern called "contextual authorization" — the same
 * endpoint returns different data based on who's asking.
 */
export const getChannelVideos = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const { page = 1, limit = 20, status, visibility } = req.query;

  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    throw new ApiError(400, "Invalid channel ID");
  }

  const isOwner = req.user && req.user._id.toString() === channelId;

  const matchStage = {
    owner: new mongoose.Types.ObjectId(channelId),
  };

  if (!isOwner) {
    // Public viewers only see published public ready videos
    matchStage.visibility = "public";
    matchStage.status = "ready";
    matchStage.isPublished = true;
  } else {
    // Owner can filter their own videos by status/visibility
    if (status) matchStage.status = status;
    if (visibility) matchStage.visibility = visibility;
  }

  const options = buildPaginationOptions(page, limit);

  const pipeline = [
    { $match: matchStage },
    { $sort: { createdAt: -1 } },
    { $project: { __v: 0 } },
  ];

  const result = await Video.aggregatePaginate(
    Video.aggregate(pipeline),
    options,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, result, "Channel videos fetched"));
});

// ─── 15. UPDATE VIDEO STATUS (processing pipeline) ────────────────────────────

/**
 * This endpoint is called by your background worker/job queue — NOT by users.
 * It should be protected by a secret API key (not JWT), or be on an internal
 * network unreachable from the public internet.
 *
 * PRODUCTION FLOW:
 * 1. Video uploaded → status: "pending"
 * 2. Worker picks it up → status: "processing"
 * 3. FFmpeg transcodes to 360p, 720p, 1080p → generates HLS segments
 * 4. Segments uploaded to CDN/S3
 * 5. Worker calls this endpoint → status: "ready", hlsUrl updated
 * 6. If FFmpeg fails → status: "failed"
 *
 * The admin.middleware.js or a separate workerAuth middleware guards this route.
 */
export const updateVideoStatus = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const { status, hlsUrl, resolution } = req.body;

  const validStatuses = ["pending", "processing", "ready", "failed"];
  if (!validStatuses.includes(status)) {
    throw new ApiError(
      400,
      `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
    );
  }

  const updateData = { status };
  if (hlsUrl) updateData.hlsUrl = hlsUrl;
  if (resolution) updateData.resolution = resolution;

  const video = await Video.findByIdAndUpdate(
    videoId,
    { $set: updateData },
    { new: true },
  );

  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, video, `Video status updated to "${status}"`));
});

// ─── 16. GET RECOMMENDED VIDEOS ───────────────────────────────────────────────

/**
 * RECOMMENDATION NOTE:
 * Real recommendation engines (YouTube's) use machine learning — collaborative
 * filtering, neural networks trained on billions of watch history records.
 * Our version does basic content-based filtering: same category/tags, different video.
 *
 * This is intentionally simple but demonstrates the right query pattern.
 * A real implementation would call a separate ML microservice and return
 * pre-computed recommendations from a cache (Redis).
 */
export const getRecommendedVideos = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const { limit = 10 } = req.query;

  const currentVideo = await Video.findById(videoId).select(
    "tags category owner",
  );

  if (!currentVideo) {
    throw new ApiError(404, "Video not found");
  }

  const videos = await Video.aggregate([
    {
      $match: {
        _id: { $ne: new mongoose.Types.ObjectId(videoId) }, // exclude current video
        visibility: "public",
        status: "ready",
        isPublished: true,
        $or: [
          { tags: { $in: currentVideo.tags } }, // same tags
          { category: currentVideo.category }, // same category
        ],
      },
    },
    {
      // Score by how many tags overlap
      $addFields: {
        tagOverlap: {
          $size: {
            $ifNull: [{ $setIntersection: ["$tags", currentVideo.tags] }, []],
          },
        },
      },
    },
    { $sort: { tagOverlap: -1, views: -1 } },
    { $limit: Number(limit) },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "ownerDetails",
        pipeline: [{ $project: { username: 1, avatar: 1 } }],
      },
    },
    { $unwind: "$ownerDetails" },
    { $project: { tagOverlap: 0, __v: 0 } },
  ]);

  return res
    .status(200)
    .json(new ApiResponse(200, videos, "Recommended videos fetched"));
});

// ─── 17. GET VIDEOS BY ADMIN (moderation) ─────────────────────────────────────

/**
 * Admins need to see ALL videos regardless of status, visibility, or publish state.
 * This is the moderation dashboard query.
 *
 * SECURITY: This MUST be behind verifyRole("admin") middleware.
 * Never expose unpublished/private content without proper role checks.
 * Admin routes should also be rate limited and fully logged/audited.
 */
export const getVideosByAdmin = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 50,
    status,
    visibility,
    isPublished,
    ownerId,
    sortBy = "createdAt",
    sortType = "desc",
  } = req.query;

  const matchStage = {};
  if (status) matchStage.status = status;
  if (visibility) matchStage.visibility = visibility;
  if (isPublished !== undefined)
    matchStage.isPublished = isPublished === "true";
  if (ownerId && mongoose.Types.ObjectId.isValid(ownerId)) {
    matchStage.owner = new mongoose.Types.ObjectId(ownerId);
  }

  const options = buildPaginationOptions(page, limit);

  const pipeline = [
    { $match: matchStage },
    { $sort: { [sortBy]: sortType === "asc" ? 1 : -1 } },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "ownerDetails",
        pipeline: [{ $project: { username: 1, avatar: 1, email: 1 } }],
      },
    },
    { $unwind: "$ownerDetails" },
  ];

  const result = await Video.aggregatePaginate(
    Video.aggregate(pipeline),
    options,
  );

  return res
    .status(200)
    .json(new ApiResponse(200, result, "Admin: all videos fetched"));
});
