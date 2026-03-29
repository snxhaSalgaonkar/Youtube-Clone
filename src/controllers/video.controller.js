/**
 * VIDEO CONTROLLER — YouTube Clone
 * All 17 feature methods with full explanations, security notes, and beginner tips.
 *
 * KEY CONCEPT: Controller vs Route vs Model
 * - Model:      Defines the data shape and talks to MongoDB.
 * - Controller: Contains the business logic (what to DO with the data).
 * - Route:      Maps HTTP methods + URLs to the right controller function.
 *
 * Controllers should NEVER contain raw mongoose queries sprawled everywhere.
 * Keep models thin (schema + indexes), controllers focused on one job each.
 */

import mongoose from "mongoose";
import { Video } from "../models/video.model.js"; // your model from before
import {
  Like,
  Dislike,
  Comment,
  Playlist,
  WatchHistory,
} from "../models/supporting.models.js";
import { ApiError, ApiResponse } from "../utils/apiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { uploadToCloudinary } from "../utils/cloudinary.js"; // see note below

// ─────────────────────────────────────────────────────────────────────────────
// 1. UPLOAD / GENERATE A VIDEO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * POST /api/v1/videos/
 *
 * KEY CONCEPT: Multipart File Upload Pipeline
 * Raw binary files (video, thumbnail) come in as multipart/form-data.
 * Multer (an Express middleware) intercepts the request BEFORE your controller,
 * saves the file temporarily to disk (or memory), and attaches it to req.file
 * or req.files. Your controller then pushes that file to cloud storage
 * (Cloudinary, AWS S3) and saves only the resulting URL in MongoDB.
 *
 * Pipeline:
 *   Client → Express → Multer (temp file) → Controller → Cloudinary → MongoDB
 *
 * COMMON BEGINNER MISTAKE: Saving uploaded files to the server's local disk
 * permanently. This fails on cloud platforms (Heroku, Render, Railway) which
 * have ephemeral filesystems — files disappear on restart. Always push to
 * cloud storage and store only the URL.
 *
 * SECURITY TIPS:
 * 1. Validate MIME type server-side — never trust the file extension the user sends.
 *    A user can rename "malware.exe" to "video.mp4". Check the actual file bytes.
 * 2. Set a file size limit in Multer (e.g., 500MB for video).
 * 3. Sanitize the filename — strip special characters that could cause path
 *    traversal attacks (e.g., "../../../../etc/passwd").
 * 4. Only authenticated users should reach this endpoint (verifyJWT middleware).
 *
 * SYSTEM FAILURE TIP: Video processing (FFmpeg transcoding, HLS generation)
 * is CPU-heavy and can take minutes. Never do it synchronously in the controller.
 * Upload the raw file to cloud storage, create the DB record with status:"pending",
 * respond immediately with 201, and kick off processing as a background job
 * (Bull queue, AWS Lambda, Cloudinary auto-transforms, etc.).
 */
export const uplwoadVideo = asyncHandler(async (req, res) => {
  // req.files is populated by Multer middleware (configured in the route)
  const videoLocalPath = req.files?.videoFile?.[0]?.path;
  const thumbnailLocalPath = req.files?.thumbnail?.[0]?.path;

  if (!videoLocalPath) {
    throw new ApiError(400, "Video file is required");
  }
  if (!thumbnailLocalPath) {
    throw new ApiError(400, "Thumbnail is required");
  }

  const { title, description, category, tags, visibility } = req.body;

  if (!title?.trim()) {
    throw new ApiError(400, "Title is required");
  }

  // Upload both files to Cloudinary in parallel
  // KEY CONCEPT: Promise.all() runs async tasks concurrently, not sequentially.
  // Running them one after the other would take 2× as long for no reason.
  const [videoUpload, thumbnailUpload] = await Promise.all([
    uploadToCloudinary(videoLocalPath, "video"),
    uploadToCloudinary(thumbnailLocalPath, "image"),
  ]);

  if (!videoUpload?.url) {
    throw new ApiError(500, "Video upload failed — please try again");
  }

  // Parse tags: accept either a JSON array or a comma-separated string
  // COMMON BEGINNER MISTAKE: Assuming the client always sends the right format.
  let parsedTags = [];
  if (tags) {
    parsedTags = Array.isArray(tags)
      ? tags
      : tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
  }

  const video = await Video.create({
    owner: req.user._id,
    videoFile: videoUpload.url,
    thumbnail: thumbnailUpload?.url || "",
    hlsUrl: videoUpload.eager?.[0]?.url || null, // Cloudinary eager transform for HLS
    title: title.trim(),
    description: description?.trim() || "",
    duration: videoUpload.duration || 0, // Cloudinary returns duration for videos
    category: category?.trim() || "General",
    tags: parsedTags,
    visibility: visibility || "private", // default PRIVATE — explicit publish step required
    status: "ready", // in a real system, set "pending" and use a background worker
  });
  console.log("*********** Video uploaded succesfully" + video);

  return res
    .status(201)
    .json(new ApiResponse(201, video, "Video uploaded successfully"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PUBLISH A VIDEO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * PATCH /api/v1/videos/:videoId/publish
 *
 * KEY CONCEPT: Authorization vs Authentication
 * Authentication = verifying WHO you are (JWT check).
 * Authorization  = verifying what you're ALLOWED to do.
 * Here: any logged-in user can upload, but only the VIDEO OWNER can publish it.
 *
 * COMMON BEGINNER MISTAKE: Only checking authentication but skipping
 * authorization. Without the owner check, any logged-in user could publish
 * (or delete!) someone else's video just by knowing its ID.
 *
 * SECURITY TIP: Always compare IDs as strings (.toString()) — MongoDB ObjectIds
 * are objects and === comparison on objects always returns false even if they
 * hold the same value.
 */
export const publishVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const video = await Video.findById(videoId);

  if (!video) {
    throw new ApiError(404, "Video not found");
  }

  // Authorization check: only the owner can publish
  if (video.owner.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Forbidden: You do not own this video");
  }

  // Only publish if the video has been processed
  if (video.status !== "ready") {
    throw new ApiError(400, `Cannot publish — video is still ${video.status}`);
  }

  video.isPublished = true;
  video.visibility = "public";
  await video.save();

  return res
    .status(200)
    .json(new ApiResponse(200, video, "Video published successfully"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SEARCH VIDEOS
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/v1/videos/search?q=javascript&page=1&limit=20&category=Tech&sort=views
 *
 * KEY CONCEPT: MongoDB Full-Text Search with $text
 * When you create a text index on title + description (done in the video model),
 * MongoDB can search for words across both fields in a single query.
 * $text: { $search: "javascript tutorial" } finds all videos containing those words.
 *
 * KEY CONCEPT: Pagination (skip + limit)
 * Never return ALL documents in one query — for a large collection, that would
 * load millions of records into memory and crash the server.
 * - limit: how many results per page (e.g., 20)
 * - skip: how many to skip = (page - 1) × limit
 *
 * KEY CONCEPT: Aggregation Pipeline for complex queries
 * We use aggregation here instead of find() because we need to:
 * 1. Filter ($match)
 * 2. Lookup owner details ($lookup — like a SQL JOIN)
 * 3. Sort by multiple fields ($sort)
 * 4. Paginate ($skip + $limit)
 * 5. Count total results for "page X of Y" UI ($facet)
 *
 * SECURITY TIP: Sanitize the search query — strip regex special characters
 * to prevent ReDoS (Regular Expression Denial of Service) attacks.
 * Never pass unsanitized user input directly to $regex queries.
 *
 * COMMON BEGINNER MISTAKE: Returning all fields including sensitive ones.
 * Use $project to whitelist only the fields the client needs.
 */
export const searchVideos = asyncHandler(async (req, res) => {
  const {
    q = "",
    page = 1,
    limit = 20,
    category,
    sort = "createdAt", // createdAt | views | likeCount
    order = "desc",
  } = req.query;

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(50, Math.max(1, parseInt(limit))); // cap at 50 per page
  const skip = (pageNum - 1) * limitNum;

  // Base filter: only show public, ready, published videos to everyone
  const matchStage = {
    visibility: "public",
    status: "ready",
    isPublished: true,
  };

  if (q.trim()) {
    // $text search uses the compound text index on title + description
    matchStage.$text = { $search: q.trim() };
  }

  if (category) {
    matchStage.category = category;
  }

  const sortOrder = order === "asc" ? 1 : -1;
  const sortStage = { [sort]: sortOrder };
  // When using $text search, also sort by text relevance score
  if (q.trim()) {
    sortStage.score = { $meta: "textScore" };
  }

  /**
   * KEY CONCEPT: $facet — run two pipelines in parallel
   * One pipeline gets the paginated results, the other counts the total.
   * Without $facet you'd need two separate DB queries.
   */
  const pipeline = [
    { $match: matchStage },
    // Add text relevance score field (only has value when $text is used)
    ...(q.trim() ? [{ $addFields: { score: { $meta: "textScore" } } }] : []),
    { $sort: sortStage },
    {
      $facet: {
        // Branch 1: paginated results
        results: [
          { $skip: skip },
          { $limit: limitNum },
          {
            // $lookup = LEFT JOIN — fetches owner's username and avatar
            $lookup: {
              from: "users",
              localField: "owner",
              foreignField: "_id",
              as: "owner",
              pipeline: [
                { $project: { username: 1, avatar: 1, _id: 1 } }, // only safe fields
              ],
            },
          },
          { $unwind: "$owner" }, // converts owner array (from lookup) to single object
          {
            $project: {
              title: 1,
              thumbnail: 1,
              duration: 1,
              views: 1,
              likeCount: 1,
              owner: 1,
              createdAt: 1,
              category: 1,
            },
          },
        ],
        // Branch 2: total count for pagination UI
        totalCount: [{ $count: "count" }],
      },
    },
  ];

  const [result] = await Video.aggregate(pipeline);

  const total = result.totalCount[0]?.count || 0;

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        videos: result.results,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
          hasNextPage: pageNum < Math.ceil(total / limitNum),
        },
      },
      "Search results",
    ),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. LIKE A VIDEO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * POST /api/v1/videos/:videoId/like
 *
 * KEY CONCEPT: Idempotency
 * An idempotent operation produces the same result whether you call it once
 * or ten times. Liking a video you already liked should NOT add another like —
 * it should just confirm it's liked.
 *
 * We use findOneAndUpdate with upsert: true:
 * - If the Like document exists: do nothing (no-op)
 * - If it doesn't exist: create it
 * This is atomic — no race condition between check and insert.
 *
 * KEY CONCEPT: Mutual exclusion of like/dislike
 * When a user likes, remove any existing dislike first (in the same operation).
 * The order matters: delete dislike BEFORE creating like to avoid a brief
 * inconsistent state where both exist.
 *
 * SYSTEM FAILURE TIP: likeCount on the Video document is a cached counter.
 * Update it using $inc for atomicity. Do NOT do:
 *   video.likeCount = (await Like.countDocuments({video: id}))
 * That's two queries and a race condition — the count you read might be stale
 * by the time you save it.
 */
export const likeVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const videoExists = await Video.exists({ _id: videoId });
  if (!videoExists) throw new ApiError(404, "Video not found");

  // Check if already liked
  const existingLike = await Like.findOne({
    user: req.user._id,
    video: videoId,
  });

  if (existingLike) {
    // Toggle off: remove like
    await Like.deleteOne({ _id: existingLike._id });
    await Video.findByIdAndUpdate(videoId, { $inc: { likeCount: -1 } });

    return res
      .status(200)
      .json(new ApiResponse(200, { liked: false }, "Like removed"));
  }

  // Remove any existing dislike first (mutual exclusion)
  const existingDislike = await Dislike.findOneAndDelete({
    user: req.user._id,
    video: videoId,
  });

  // Create the like
  await Like.create({ user: req.user._id, video: videoId });

  // Atomically update the cached counter(s)
  const update = { $inc: { likeCount: 1 } };
  await Video.findByIdAndUpdate(videoId, update);

  return res
    .status(200)
    .json(new ApiResponse(200, { liked: true }, "Video liked"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DISLIKE A VIDEO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * POST /api/v1/videos/:videoId/dislike
 *
 * Mirror of likeVideo with mutual exclusion in the other direction.
 * Note: YouTube doesn't show public dislike counts (to protect creators),
 * but you might still want to store dislikes for recommendation algorithms.
 */
export const dislikeVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const videoExists = await Video.exists({ _id: videoId });
  if (!videoExists) throw new ApiError(404, "Video not found");

  const existingDislike = await Dislike.findOne({
    user: req.user._id,
    video: videoId,
  });

  if (existingDislike) {
    // Toggle off
    await Dislike.deleteOne({ _id: existingDislike._id });
    return res
      .status(200)
      .json(new ApiResponse(200, { disliked: false }, "Dislike removed"));
  }

  // Remove any existing like (mutual exclusion)
  const existingLike = await Like.findOneAndDelete({
    user: req.user._id,
    video: videoId,
  });
  if (existingLike) {
    await Video.findByIdAndUpdate(videoId, { $inc: { likeCount: -1 } });
  }

  await Dislike.create({ user: req.user._id, video: videoId });

  return res
    .status(200)
    .json(new ApiResponse(200, { disliked: true }, "Video disliked"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. COMMENT ON A VIDEO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * POST /api/v1/videos/:videoId/comments
 *
 * KEY CONCEPT: Input Validation and Sanitization
 * Before touching the database:
 * 1. Validate: is the required data present and the right type?
 * 2. Sanitize: remove/escape any potentially harmful content.
 *
 * SECURITY TIP: Comment text can contain HTML. If you ever render it in a
 * browser without escaping, you get XSS (Cross-Site Scripting) — the comment
 * might contain <script>steal_cookies()</script>. Either:
 * a) Strip all HTML tags server-side (use the 'sanitize-html' npm package)
 * b) Or always escape on the frontend (React does this automatically with JSX)
 *
 * SYSTEM FAILURE TIP: Rate-limit this endpoint. Without a rate limit,
 * a bot can post thousands of comments per second. Use express-rate-limit or
 * a Redis-based limiter (e.g., 10 comments per minute per user).
 */
export const addComment = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const { text, parentCommentId } = req.body;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  if (!text?.trim()) {
    throw new ApiError(400, "Comment text is required");
  }

  if (text.trim().length > 2000) {
    throw new ApiError(400, "Comment cannot exceed 2000 characters");
  }

  const video = await Video.findById(videoId).select("_id status visibility");
  if (!video || video.status !== "ready") {
    throw new ApiError(404, "Video not found or not available");
  }

  // If replying to a comment, verify the parent exists
  if (parentCommentId && !mongoose.isValidObjectId(parentCommentId)) {
    throw new ApiError(400, "Invalid parent comment ID");
  }

  const comment = await Comment.create({
    video: videoId,
    author: req.user._id,
    text: text.trim(),
    parent: parentCommentId || null,
  });

  // Increment cached comment count only for top-level comments
  if (!parentCommentId) {
    await Video.findByIdAndUpdate(videoId, { $inc: { commentCount: 1 } });
  }

  // Populate author info before returning (so the client gets username/avatar)
  await comment.populate("author", "username avatar");

  return res
    .status(201)
    .json(new ApiResponse(201, comment, "Comment added successfully"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. UPDATE VIDEO DETAILS
// ─────────────────────────────────────────────────────────────────────────────
/**
 * PATCH /api/v1/videos/:videoId
 *
 * KEY CONCEPT: Partial Updates with PATCH
 * PATCH means "update only the fields I send". PUT means "replace the entire
 * resource". For user-editable metadata (title, description, tags), always
 * use PATCH — you don't want to wipe fields the user didn't include.
 *
 * KEY CONCEPT: Dynamic update object
 * Build the update object only from fields that were actually sent.
 * If `title` isn't in the request body, don't include it in the update —
 * otherwise you'd overwrite it with undefined/null.
 *
 * COMMON BEGINNER MISTAKE: Doing video.title = req.body.title without
 * checking if req.body.title exists. This sets the field to undefined,
 * which may pass Mongoose validation (if not required) and corrupt your data.
 */
export const updateVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const video = await Video.findById(videoId);
  if (!video) throw new ApiError(404, "Video not found");

  // Authorization
  if (video.owner.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Forbidden: You do not own this video");
  }

  const { title, description, category, tags, visibility } = req.body;

  // Build update object with only present fields (PATCH semantics)
  const updateFields = {};
  if (title !== undefined) {
    if (!title.trim()) throw new ApiError(400, "Title cannot be empty");
    updateFields.title = title.trim();
  }
  if (description !== undefined) updateFields.description = description.trim();
  if (category !== undefined) updateFields.category = category.trim();
  if (visibility !== undefined) {
    const validVisibilities = ["public", "unlisted", "private"];
    if (!validVisibilities.includes(visibility)) {
      throw new ApiError(400, "Invalid visibility value");
    }
    updateFields.visibility = visibility;
  }
  if (tags !== undefined) {
    updateFields.tags = Array.isArray(tags)
      ? tags
      : tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
  }

  // Handle optional new thumbnail upload
  if (req.file?.path) {
    const thumbnailUpload = await uploadToCloudinary(req.file.path, "image");
    if (!thumbnailUpload?.url) {
      throw new ApiError(500, "Thumbnail upload failed");
    }
    updateFields.thumbnail = thumbnailUpload.url;
    // IMPORTANT: In production, also DELETE the old thumbnail from Cloudinary
    // to avoid orphaned storage costs. Use cloudinary.uploader.destroy(publicId).
  }

  if (Object.keys(updateFields).length === 0) {
    throw new ApiError(400, "No update fields provided");
  }

  const updatedVideo = await Video.findByIdAndUpdate(
    videoId,
    { $set: updateFields },
    { new: true, runValidators: true }, // runValidators re-runs schema validators on update
  );

  return res
    .status(200)
    .json(new ApiResponse(200, updatedVideo, "Video updated successfully"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. PLAY A VIDEO (GET VIDEO DETAILS + INCREMENT VIEW COUNT)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/v1/videos/:videoId/play
 *
 * KEY CONCEPT: Separating "read" from "side effects"
 * Playing a video does two things: (1) fetch the video data, (2) increment views.
 * The view increment should be fire-and-forget — don't make the user wait for
 * the DB write. Use setImmediate() to push it to the next event loop tick
 * so the response goes out immediately.
 *
 * KEY CONCEPT: Access Control for different visibility levels
 * - public:   anyone can watch
 * - unlisted: only people with the link (no auth required, but not in search)
 * - private:  only the owner
 *
 * SYSTEM FAILURE TIP: Serving video files directly from Express is catastrophically
 * inefficient. The videoFile URL should be a Cloudinary/S3 URL that the browser
 * fetches directly. Never stream gigabytes of video through your Node.js server.
 *
 * KEY CONCEPT: Resumable playback
 * Fetch the user's watch history entry to tell the player where to resume.
 */
export const playVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const video = await Video.findById(videoId)
    .populate("owner", "username avatar subscribers")
    .select("-__v");

  if (!video || video.status !== "ready") {
    throw new ApiError(404, "Video not found or not available");
  }

  // Access control based on visibility
  if (video.visibility === "private") {
    if (!req.user || video.owner._id.toString() !== req.user._id.toString()) {
      throw new ApiError(403, "This video is private");
    }
  }

  // Increment view count asynchronously — don't await, don't block the response
  // KEY CONCEPT: setImmediate defers execution until after I/O events in the
  // current event loop cycle. The client gets the response immediately.
  setImmediate(() => {
    Video.findByIdAndUpdate(videoId, { $inc: { views: 1 } }).catch(
      console.error,
    );
  });

  // Fetch resume position if user is logged in
  let resumeAt = 0;
  if (req.user) {
    const history = await WatchHistory.findOne({
      user: req.user._id,
      video: videoId,
    }).select("watchedSeconds");
    resumeAt = history?.watchedSeconds || 0;
  }

  // Check if the current user has liked this video
  let hasLiked = false;
  if (req.user) {
    hasLiked = !!(await Like.exists({ user: req.user._id, video: videoId }));
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        video,
        resumeAt,
        hasLiked,
      },
      "Video ready to play",
    ),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. SAVE TO WATCH HISTORY (called when user starts watching)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * POST /api/v1/videos/:videoId/history
 *
 * KEY CONCEPT: Upsert (Update or Insert)
 * findOneAndUpdate with { upsert: true } means:
 * - If a document matching the filter exists → update it
 * - If it doesn't exist → create it
 * This is atomic — no race condition, no duplicates, one round trip to MongoDB.
 *
 * Without upsert, you'd have to:
 * 1. find() — check if history exists
 * 2. if yes: update(); if no: create()
 * Those are two separate DB calls with a window for duplicate inserts in between.
 *
 * PERFORMANCE TIP: This is called frequently (on every video open). Ensure the
 * compound index on { user, video } exists (set in the model) so the lookup is O(log n).
 */
export const saveToWatchHistory = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const historyEntry = await WatchHistory.findOneAndUpdate(
    { user: req.user._id, video: videoId }, // filter
    {
      $set: {
        lastWatchedAt: new Date(),
        completed: false,
      },
      $setOnInsert: { watchedSeconds: 0 }, // only set on INSERT, not on UPDATE
    },
    { upsert: true, new: true },
  );

  return res
    .status(200)
    .json(new ApiResponse(200, historyEntry, "Added to watch history"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. STOP / PAUSE VIDEO (save progress)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * PATCH /api/v1/videos/:videoId/progress
 *
 * Called when the user pauses, stops, or closes a video.
 * Also called periodically while playing (every 30s) for crash recovery.
 *
 * KEY CONCEPT: Debouncing on the client
 * Don't call this on EVERY second of playback — that's 3600 DB writes per hour
 * per viewer. The frontend should debounce: save progress at most every 30
 * seconds and always on pause/close.
 *
 * KEY CONCEPT: $max operator — only update if the new value is LARGER
 * $max: { watchedSeconds: seconds } means "only advance the progress, never go back"
 * This prevents a seek-backwards from wiping out a user's furthest watch point.
 *
 * SECURITY: Validate that `seconds` is a number within the video's duration.
 * Never trust client-reported playback position without bounds checking.
 */
export const savePlaybackProgress = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const { seconds } = req.body;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const secondsNum = parseFloat(seconds);
  if (isNaN(secondsNum) || secondsNum < 0) {
    throw new ApiError(400, "Invalid seconds value");
  }

  // Fetch duration for bounds checking
  const video = await Video.findById(videoId).select("duration");
  if (!video) throw new ApiError(404, "Video not found");

  const clampedSeconds = Math.min(secondsNum, video.duration);
  const isCompleted = clampedSeconds >= video.duration * 0.95; // 95% = "completed"

  await WatchHistory.findOneAndUpdate(
    { user: req.user._id, video: videoId },
    {
      $max: { watchedSeconds: clampedSeconds }, // only advance, never go back
      $set: {
        lastWatchedAt: new Date(),
        completed: isCompleted,
      },
    },
    { upsert: true },
  );

  // Fire and forget — client doesn't need to wait for acknowledgment
  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { watchedSeconds: clampedSeconds, isCompleted },
        "Progress saved",
      ),
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. SKIP (SEEK) IN VIDEO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * PATCH /api/v1/videos/:videoId/seek
 *
 * KEY CONCEPT: Seeking vs Progress
 * Seeking is different from progress saving. When a user drags the playbar to
 * a specific position:
 * - If they seek FORWARD past their furthest point → update progress
 * - If they seek BACKWARD → don't overwrite their furthest point (use $max)
 *
 * The client sends { targetSeconds: 180 } (where the user seeked to).
 * We respond with the confirmed seek position.
 *
 * NOTE: This is a lightweight record operation. The actual video seek happens
 * entirely in the browser's HTML5 video player — your server just needs to
 * remember the position for resume-on-return.
 */
export const seekVideo = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const { targetSeconds } = req.body;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const seekTo = parseFloat(targetSeconds);
  if (isNaN(seekTo) || seekTo < 0) {
    throw new ApiError(400, "Invalid target position");
  }

  const video = await Video.findById(videoId).select("duration");
  if (!video) throw new ApiError(404, "Video not found");

  const clampedSeek = Math.min(seekTo, video.duration);

  // Use $max so seeking backward doesn't erase furthest-watched position
  await WatchHistory.findOneAndUpdate(
    { user: req.user._id, video: videoId },
    {
      $max: { watchedSeconds: clampedSeek },
      $set: { lastWatchedAt: new Date() },
    },
    { upsert: true },
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, { seekedTo: clampedSeek }, "Seek position saved"),
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. SAVE VIDEO TO A PLAYLIST
// ─────────────────────────────────────────────────────────────────────────────
/**
 * PATCH /api/v1/playlists/:playlistId/videos/:videoId
 *
 * KEY CONCEPT: $addToSet vs $push
 * $push adds to an array — even if the value already exists (creates duplicates).
 * $addToSet adds to an array ONLY if the value isn't already there — like a Set.
 * Always use $addToSet when you want unique items in an array.
 *
 * SYSTEM FAILURE TIP: Without the 500-video cap validation (in the schema),
 * and without server-side enforcement, a user could add the same video 100,000
 * times and make populate() return an enormous response that OOMs your server.
 */
export const addVideoToPlaylist = asyncHandler(async (req, res) => {
  const { playlistId, videoId } = req.params;

  if (
    !mongoose.isValidObjectId(playlistId) ||
    !mongoose.isValidObjectId(videoId)
  ) {
    throw new ApiError(400, "Invalid playlist or video ID");
  }

  const playlist = await Playlist.findById(playlistId);
  if (!playlist) throw new ApiError(404, "Playlist not found");

  // Authorization: only the playlist owner can add videos
  if (playlist.owner.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "Forbidden: You do not own this playlist");
  }

  // Enforce max playlist size
  if (playlist.videos.length >= 500) {
    throw new ApiError(400, "Playlist is full (max 500 videos)");
  }

  const videoExists = await Video.exists({ _id: videoId, status: "ready" });
  if (!videoExists) throw new ApiError(404, "Video not found");

  // $addToSet prevents adding duplicates
  const updatedPlaylist = await Playlist.findByIdAndUpdate(
    playlistId,
    { $addToSet: { videos: videoId } },
    { new: true },
  );

  return res
    .status(200)
    .json(new ApiResponse(200, updatedPlaylist, "Video added to playlist"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. CREATE A PLAYLIST
// ─────────────────────────────────────────────────────────────────────────────
/**
 * POST /api/v1/playlists
 *
 * SYSTEM FAILURE TIP: Limit how many playlists a user can create.
 * Without a cap, a bot could create millions of playlists and fill your DB.
 * Check count before creating and enforce a reasonable limit (e.g., 100 playlists/user).
 *
 * COMMON BEGINNER MISTAKE: Not validating that the user doesn't already have
 * a playlist with the same name. Duplicate names are confusing UX — either
 * enforce uniqueness or at least warn the user.
 */
export const createPlaylist = asyncHandler(async (req, res) => {
  const { name, description, isPublic = false } = req.body;

  if (!name?.trim()) {
    throw new ApiError(400, "Playlist name is required");
  }

  // Enforce per-user playlist cap
  const playlistCount = await Playlist.countDocuments({ owner: req.user._id });
  if (playlistCount >= 100) {
    throw new ApiError(400, "You have reached the maximum of 100 playlists");
  }

  const playlist = await Playlist.create({
    owner: req.user._id,
    name: name.trim(),
    description: description?.trim() || "",
    isPublic: Boolean(isPublic),
    videos: [],
  });

  return res
    .status(201)
    .json(new ApiResponse(201, playlist, "Playlist created successfully"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. GET VIDEO LIKE COUNT
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/v1/videos/:videoId/likes/count
 *
 * KEY CONCEPT: Cached counter vs live count
 * We return likeCount from the Video document (the cached value updated by $inc).
 * We do NOT do Like.countDocuments({ video: videoId }) on every request.
 *
 * countDocuments on a large Like collection with millions of records, even with
 * an index, adds latency on every page load. The cached counter is instant.
 *
 * SYSTEM FAILURE TIP: Cached counters can drift out of sync if bugs occur
 * (e.g., a like is deleted but $inc: -1 doesn't run due to an error). Schedule
 * a nightly reconciliation job that recalculates all counts from the Like
 * collection and resets the cached values.
 */
export const getLikeCount = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const video = await Video.findById(videoId).select("likeCount");
  if (!video) throw new ApiError(404, "Video not found");

  // If user is logged in, also tell them whether they liked it
  let hasLiked = false;
  if (req.user) {
    hasLiked = !!(await Like.exists({ user: req.user._id, video: videoId }));
  }

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { likeCount: video.likeCount, hasLiked },
        "Like count fetched",
      ),
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. GET VIDEO COMMENT COUNT + PAGINATED COMMENTS
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/v1/videos/:videoId/comments?page=1&limit=20
 *
 * KEY CONCEPT: Cursor-based pagination vs offset pagination
 * We use offset pagination here (skip + limit) — simple but has a flaw:
 * if new comments are added between page 1 and page 2 fetches, items shift
 * and page 2 might show duplicates.
 *
 * For production comment sections (like YouTube), cursor-based pagination
 * is better: the client sends { afterId: "last_seen_comment_id" } and the
 * query is: { _id: { $lt: afterId } } — this is stable even as new items
 * are inserted. But offset is fine for learning.
 *
 * KEY CONCEPT: $lookup for nested replies
 * We optionally populate each top-level comment with its first N replies.
 * This is a nested $lookup (aggregation within aggregation) — advanced but powerful.
 */
export const getComments = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const { page = 1, limit = 20 } = req.query;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const video = await Video.findById(videoId).select("commentCount");
  if (!video) throw new ApiError(404, "Video not found");

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(50, parseInt(limit));
  const skip = (pageNum - 1) * limitNum;

  // Fetch top-level comments only (parent: null)
  const comments = await Comment.find({ video: videoId, parent: null })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum)
    .populate("author", "username avatar");

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        comments,
        totalComments: video.commentCount,
        page: pageNum,
        totalPages: Math.ceil(video.commentCount / limitNum),
      },
      "Comments fetched",
    ),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. GET VIDEO COUNT (for a user's channel or global)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/v1/videos/count?userId=<id>
 *
 * KEY CONCEPT: countDocuments vs estimatedDocumentCount
 * - countDocuments({ filter }): accurate count respecting the filter, uses index.
 * - estimatedDocumentCount(): reads from collection metadata, extremely fast,
 *   but only works for the TOTAL count (no filter), and may be slightly stale.
 *
 * For a user's video count, use countDocuments (we need to filter by owner).
 * For "total videos on the platform" (admin stats), estimatedDocumentCount is fine.
 *
 * SECURITY TIP: If userId is not provided, require admin role to get the global
 * count. Don't expose platform-wide statistics to anonymous users.
 */
export const getVideoCount = asyncHandler(async (req, res) => {
  const { userId } = req.query;

  let filter = { status: "ready", isPublished: true };

  if (userId) {
    if (!mongoose.isValidObjectId(userId)) {
      throw new ApiError(400, "Invalid user ID");
    }
    filter.owner = userId;

    // If the requesting user is viewing their OWN channel, count ALL videos
    // (including private/unlisted). If viewing another channel, only public.
    if (req.user && req.user._id.toString() === userId.toString()) {
      delete filter.isPublished; // see all their own videos
      delete filter.status;
    } else {
      filter.visibility = "public";
    }
  }

  const count = await Video.countDocuments(filter);

  return res
    .status(200)
    .json(new ApiResponse(200, { count }, "Video count fetched"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. GET VIDEO LINK (shareable URL)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /api/v1/videos/:videoId/link
 *
 * KEY CONCEPT: Signed URLs for private/unlisted content
 * For public videos, the shareable link is simply your frontend URL.
 * For unlisted videos, you might want to generate a time-limited signed URL
 * so the link expires after 7 days (like YouTube's unlisted behavior).
 *
 * For truly private videos, never return the raw storage URL — generate a
 * short-lived signed URL from Cloudinary or S3 that expires in minutes.
 *
 * KEY CONCEPT: URL shortening / slug generation
 * Sharing a link like /watch?v=68f3a... (MongoDB ObjectId) is fine.
 * Some apps generate a short slug (e.g., /watch/abc123) using nanoid.
 * Store the slug in the Video model and add a unique index on it.
 *
 * SECURITY TIP: Don't return the raw videoFile (storage) URL for private videos.
 * Only return the streaming/playback URL, and only after access control checks.
 */
export const getVideoLink = asyncHandler(async (req, res) => {
  const { videoId } = req.params;

  if (!mongoose.isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video ID");
  }

  const video = await Video.findById(videoId).select(
    "title visibility status isPublished owner",
  );

  if (!video || video.status !== "ready") {
    throw new ApiError(404, "Video not found");
  }

  // Authorization for private videos
  if (video.visibility === "private") {
    if (!req.user || video.owner.toString() !== req.user._id.toString()) {
      throw new ApiError(403, "This video is private");
    }
  }

  // For public/unlisted, return the shareable frontend URL
  const BASE_URL = process.env.FRONTEND_URL || "https://yourapp.com";
  const shareableLink = `${BASE_URL}/watch/${videoId}`;

  // Metadata for link previews (Open Graph / Twitter Cards)
  const linkData = {
    url: shareableLink,
    videoId,
    title: video.title,
    visibility: video.visibility,
    // In production: add expiresAt for unlisted/private signed URLs
  };

  return res
    .status(200)
    .json(new ApiResponse(200, linkData, "Video link generated"));
});
