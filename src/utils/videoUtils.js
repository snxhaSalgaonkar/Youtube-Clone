/**
 * VIDEO UTILS
 *
 * Utility functions are pure helpers with no side effects (ideally).
 * They don't talk to Express (no req/res), don't touch the DB directly,
 * and can be unit-tested in isolation — which is exactly what you want.
 *
 * Separation of concerns: keep utilities OUT of controllers. Controllers
 * should orchestrate, not compute.
 */

import { v2 as cloudinary } from "cloudinary";

// ─── generateHLSUrl ───────────────────────────────────────────────────────────

/**
 * Cloudinary can serve a video as an HLS stream by changing the URL format.
 * Given a Cloudinary public_id, this returns an m3u8 playlist URL.
 *
 * HLS Explained:
 * - Instead of one big MP4, HLS splits video into 2-10 second .ts segments.
 * - A .m3u8 "master playlist" lists multiple quality variants (360p, 720p...).
 * - The video player picks the right quality based on available bandwidth.
 * - If your connection drops, it falls back to lower quality seamlessly.
 *
 * Cloudinary's HLS transformation syntax:
 *   /sp_auto/ = "streaming profile auto" — generates multi-bitrate HLS
 * This requires Cloudinary's "Adaptive Streaming" add-on (paid feature).
 * On free plans, just return the original video URL.
 */
export const generateHLSUrl = (publicId) => {
  if (!publicId) return null;

  try {
    // Generate HLS URL using Cloudinary's streaming profile
    return cloudinary.url(publicId, {
      resource_type: "video",
      format: "m3u8",
      streaming_profile: "auto", // auto = Cloudinary picks bitrate variants
      // transformation: [{ quality: "auto" }],
    });
  } catch (error) {
    console.error("HLS URL generation failed:", error.message);
    return null;
  }
};

// ─── extractVideoDuration ─────────────────────────────────────────────────────

/**
 * Cloudinary returns duration in the upload response metadata.
 * If you're processing locally with FFmpeg first, you'd use:
 *   ffprobe -v quiet -print_format json -show_format -show_streams input.mp4
 * and parse the "duration" field from the JSON output.
 *
 * fluent-ffmpeg wraps ffprobe in a Promise-friendly API.
 * Duration is in seconds as a float (e.g., 245.32 = 4:05).
 *
 * BEGINNER MISTAKE: Trusting the client to send duration. Never trust the
 * client for any derived or computed data. Always compute server-side.
 */
export const extractVideoDuration = async (cloudinaryUploadResult) => {
  // Cloudinary includes duration in the upload result for videos
  if (cloudinaryUploadResult?.duration) {
    return Math.round(cloudinaryUploadResult.duration);
  }

  // Fallback: use FFprobe locally if Cloudinary didn't return it
  // This would require fluent-ffmpeg and ffprobe installed on the system
  // Example (uncomment if using local FFmpeg processing):
  /*
  const ffmpeg = require("fluent-ffmpeg");
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(localFilePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(Math.round(metadata.format.duration));
    });
  });
  */

  return 0; // Fallback — will be updated when processing completes
};

// ─── buildSearchQuery ─────────────────────────────────────────────────────────

/**
 * Builds a MongoDB $match stage object dynamically based on provided filters.
 *
 * KEY CONCEPT: Dynamic query building
 * Don't hardcode every possible combination of filters. Build the query
 * object by only adding conditions when those fields are actually provided.
 * This keeps queries lean and indexes effective.
 *
 * MongoDB's $text operator requires a text index on the collection.
 * We defined: videoSchema.index({ title: "text", description: "text" })
 */
export const buildSearchQuery = ({
  query, // Full-text search string
  category,
  tags, // Array of tag strings
  minDuration, // In seconds
  maxDuration,
  ownerId,
} = {}) => {
  const matchStage = {};

  // Full-text search — uses the text index we created on title + description
  if (query && query.trim()) {
    matchStage.$text = { $search: query.trim() };
  }

  if (category) {
    matchStage.category = category;
  }

  // $in matches documents where the field equals any value in the given array
  if (tags && tags.length > 0) {
    matchStage.tags = { $in: tags.map((t) => t.toLowerCase().trim()) };
  }

  // Duration range filter
  if (minDuration !== undefined || maxDuration !== undefined) {
    matchStage.duration = {};
    if (minDuration !== undefined) matchStage.duration.$gte = minDuration;
    if (maxDuration !== undefined) matchStage.duration.$lte = maxDuration;
  }

  if (ownerId) {
    matchStage.owner = ownerId;
  }

  return matchStage;
};

// ─── buildPaginationOptions ───────────────────────────────────────────────────

/**
 * mongoose-aggregate-paginate-v2 expects an options object with page and limit.
 * We centralize this so every paginated endpoint uses the same safe defaults
 * and limits. Never let users set limit=99999 — that's a DoS attack.
 *
 * KEY CONCEPT: Input sanitization
 * Always parse user-provided numbers and clamp them to sane ranges.
 * A user sending page="abc" would produce NaN — default to 1.
 * A user sending limit=100000 would load too many docs — cap at 50.
 */
export const buildPaginationOptions = (page = 1, limit = 20) => {
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  // MAX limit is 50. Never return more than 50 docs in one page.

  return {
    page: parsedPage,
    limit: parsedLimit,
    customLabels: {
      // Rename default keys to cleaner API response keys
      docs: "videos",
      totalDocs: "totalVideos",
      totalPages: "totalPages",
      page: "currentPage",
      limit: "perPage",
    },
  };
};

// ─── extractPublicIdFromUrl ───────────────────────────────────────────────────

/**
 * When deleting from Cloudinary, you need the public_id, not the full URL.
 * Example URL: https://res.cloudinary.com/demo/video/upload/v123456/my-video.mp4
 * Public ID:   my-video
 *
 * This is fragile — Cloudinary URLs can have folder paths in them.
 * Better practice: store the public_id alongside the URL in your DB schema.
 * We don't do that in this schema, so we parse it from the URL.
 * Production tip: always store public_id explicitly to avoid this parsing.
 */
export const extractPublicIdFromUrl = (cloudinaryUrl) => {
  if (!cloudinaryUrl) return null;

  try {
    // Remove everything up to and including "/upload/"
    const afterUpload = cloudinaryUrl.split("/upload/")[1];
    if (!afterUpload) return null;

    // Remove version prefix (v1234567/) if present
    const withoutVersion = afterUpload.replace(/^v\d+\//, "");

    // Remove file extension
    const publicId = withoutVersion.replace(/\.[^/.]+$/, "");

    return publicId;
  } catch {
    return null;
  }
};
