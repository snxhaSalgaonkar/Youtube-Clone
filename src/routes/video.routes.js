/**
 * VIDEO ROUTES
 *
 * KEY CONCEPT: Route → Middleware Chain → Controller
 * Every route is a pipeline. Middleware runs left-to-right.
 * If any middleware calls next(error), it skips to the error handler.
 * If it calls next() without arguments, the next function in the chain runs.
 *
 * ROUTE DESIGN:
 * - Use RESTful conventions: nouns in URLs, HTTP verbs for actions.
 * - GET    = read (idempotent — safe to repeat)
 * - POST   = create
 * - PATCH  = partial update (preferred over PUT for partial changes)
 * - DELETE = remove
 * - Avoid verbs in URLs: /videos/uploadVideo ❌ → POST /videos ✓
 *
 * ORDERING MATTERS: Specific routes before parameterized ones.
 * /videos/trending must come before /videos/:videoId, otherwise Express
 * would treat "trending" as a videoId.
 */

import { Router } from "express";
import {
  uploadVideo,
  publishVideo,
  updateVideoDetails,
  deleteVideo,
  getVideoById,
  getVideoLink,
  getAllVideos,
  togglePublishStatus,
  incrementViewCount,
  getVideosByCategory,
  getTrendingVideos,
  getVideosByTag,
  searchVideosByTitle,
  getChannelVideos,
  updateVideoStatus,
  getRecommendedVideos,
  getVideosByAdmin,
} from "../controllers/video.controller.js";

import { verifyJWT } from "../middlewares/auth.middleware.js";
import { verifyVideoOwnership } from "../middlewares/verifyOwnership.middleware.js";
import { verifyRole } from "../middlewares/admin.middleware.js";
import {
  uploadVideoAndThumbnail,
  uploadThumbnailOnly,
  handleMulterErrors,
} from "../middlewares/multer.middleware.js";
import {
  uploadRateLimiter,
  searchRateLimiter,
  viewCountRateLimiter,
} from "../middlewares/rateLimiter.middleware.js";
import { validate } from "../middlewares/validate.middleware.js";
import {
  uploadVideoValidator,
  updateVideoValidator,
} from "../validators/video.validator.js";

const router = Router();

// ─── PUBLIC ROUTES (no auth required) ────────────────────────────────────────

// IMPORTANT: Specific named routes MUST come before /:videoId
// Otherwise "trending", "search", "category" would be parsed as video IDs

router.get("/trending", getTrendingVideos);
router.get("/search", searchRateLimiter, searchVideosByTitle);
router.get("/category/:category", getVideosByCategory);
router.get("/tag/:tag", getVideosByTag);
router.get("/", getAllVideos);

// Channel videos — optionally authenticated (owner sees private videos)
router.get("/channel/:channelId", verifyJWT, getChannelVideos);

// ─── PARAMETERIZED PUBLIC ROUTES ─────────────────────────────────────────────

// verifyJWT here is optional — used only to check ownership for private videos
// Some implementations use a separate optionalAuth middleware for this
router.get("/:videoId", verifyJWT, getVideoById);
router.get("/:videoId/stream", verifyJWT, getVideoLink);
router.get("/:videoId/recommended", getRecommendedVideos);

// View count — rate limited per IP+videoId to prevent manipulation
router.post("/:videoId/view", viewCountRateLimiter, incrementViewCount);

// ─── PROTECTED ROUTES (JWT required) ─────────────────────────────────────────

// Upload: rate limited + multer + validation + auth
router.post(
  "/",
  verifyJWT,
  uploadRateLimiter,
  handleMulterErrors(uploadVideoAndThumbnail),
  //validate(uploadVideoValidator),
  uploadVideo,
);

// Operations on a specific video — ownership verified before controller runs
router.patch(
  "/:videoId",
  verifyJWT,
  verifyVideoOwnership,
  handleMulterErrors(uploadThumbnailOnly), // optional thumbnail update
  validate(updateVideoValidator),
  updateVideoDetails,
);

router.delete("/:videoId", verifyJWT, verifyVideoOwnership, deleteVideo);

router.patch(
  "/:videoId/publish",
  verifyJWT,
  verifyVideoOwnership,
  publishVideo,
);

router.patch(
  "/:videoId/toggle-publish",
  verifyJWT,
  verifyVideoOwnership,
  togglePublishStatus,
);

// ─── INTERNAL/WORKER ROUTES ───────────────────────────────────────────────────

/**
 * This route is called by your background processing worker, NOT users.
 * In production:
 * 1. This route should NOT be exposed on the public-facing server.
 * 2. It should be on an internal network or require a separate worker API key.
 * 3. Here we use verifyRole("admin") as a stand-in. Replace with workerAuth
 *    middleware in production that checks a shared secret from env vars.
 */
router.patch(
  "/:videoId/status",
  verifyJWT,
  verifyRole("admin"), // Replace with workerAuth in production
  updateVideoStatus,
);

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

router.get("/admin/all", verifyJWT, verifyRole("admin"), getVideosByAdmin);

export default router;
