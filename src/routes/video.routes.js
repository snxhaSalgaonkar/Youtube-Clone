/**
 * ROUTES — video.routes.js
 *
 * KEY CONCEPT: Express Router
 * Instead of defining all routes in app.js, we use express.Router() to create
 * a mini-application with its own routes. app.js then mounts it at a prefix:
 *   app.use('/api/v1/videos', videoRouter)
 *   app.use('/api/v1/playlists', playlistRouter)
 *
 * KEY CONCEPT: Route-level Middleware
 * router.use(verifyJWT) applies the middleware to ALL routes defined AFTER it.
 * Routes defined BEFORE it (like the public search/play routes) are unprotected.
 * This is "public routes first, then auth wall, then protected routes" pattern.
 *
 * KEY CONCEPT: Multer (file upload middleware)
 * multer() processes multipart/form-data BEFORE the controller runs.
 * upload.fields([...]) lets you specify multiple named file fields.
 * The files end up in req.files (for .fields()) or req.file (for .single()).
 *
 * SECURITY TIP: Configure multer with strict limits:
 * - fileSize: cap how large a file can be (500MB for video is generous)
 * - fileFilter: check MIME type — only accept video/* and image/*
 * Without these, anyone can upload any file of any size.
 *
 * COMMON BEGINNER MISTAKE: Not setting limits on multer. A user could upload
 * a 100GB file and freeze your server or fill your disk.
 */

import { Router } from "express";
import multer from "multer";
import path from "path";
import os from "os";

import { verifyJWT, optionalAuth } from "../middlewares/auth.middleware.js";
import {
  uploadVideo,
  publishVideo,
  searchVideos,
  likeVideo,
  dislikeVideo,
  addComment,
  updateVideo,
  playVideo,
  saveToWatchHistory,
  savePlaybackProgress,
  seekVideo,
  addVideoToPlaylist,
  createPlaylist,
  getLikeCount,
  getComments,
  getVideoCount,
  getVideoLink,
} from "../controllers/video.controller.js";

/**
 * KEY CONCEPT: Importing from a second controller file
 * As your app grows, one controller file becomes too large to maintain.
 * Split by feature group and import from each file separately.
 * The router doesn't care which file the function came from — it just
 * needs a reference to the function.
 */
import {
  deleteVideo,
  getVideoById,
  getUserVideos,
} from "../controllers/video.controller.extended.js";

// ─── MULTER CONFIGURATION ─────────────────────────────────────────────────────

/**
 * KEY CONCEPT: Multer storage strategies
 * diskStorage: saves file to disk. Good for large files. Remember to clean up
 *   temp files after uploading to Cloudinary.
 * memoryStorage: saves file in RAM as a Buffer. Good for small images but
 *   dangerous for large videos — will OOM your server.
 *
 * We use diskStorage with the OS temp directory.
 * SECURITY: Use a random filename (Date.now + random suffix) so two simultaneous
 * uploads don't overwrite each other (race condition).
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, os.tmpdir()); // OS temp dir, cleaned up by the OS eventually
  },
  filename: (req, file, cb) => {
    // Sanitize filename: remove anything that isn't alphanumeric, dot, or dash
    const safeExt = path.extname(file.originalname).replace(/[^a-z0-9.]/gi, "");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
  },
});

// MIME type whitelist
const fileFilter = (req, file, cb) => {
  const allowedVideoTypes = ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"];
  const allowedImageTypes = ["image/jpeg", "image/png", "image/webp"];
  const allowed = [...allowedVideoTypes, ...allowedImageTypes];

  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB hard limit
    files: 2, // max 2 files per request (video + thumbnail)
  },
});

// ─── VIDEO ROUTES ──────────────────────────────────────────────────────────────

const videoRouter = Router();

// ── PUBLIC ROUTES (no auth required) ──
videoRouter.get("/search", searchVideos);
videoRouter.get("/count", optionalAuth, getVideoCount);

/**
 * ROUTE ORDER WARNING — specific routes MUST come before wildcard routes.
 *
 * Express matches routes top-to-bottom and stops at the first match.
 * If "/:videoId" came before "/search", then GET /search would be caught
 * by /:videoId with videoId = "search" — and the search controller
 * would never run. Always register specific string routes BEFORE
 * parameterized (/:param) ones on the same HTTP method.
 *
 * Safe order for GET routes on this router:
 *   GET /search          ← specific, registered first ✅
 *   GET /count           ← specific, registered first ✅
 *   GET /user/:userId    ← different param name, no conflict ✅
 *   GET /:videoId        ← wildcard, registered last ✅
 *   GET /:videoId/play   ← sub-route of wildcard, fine after parent ✅
 */
videoRouter.get("/user/:userId", optionalAuth, getUserVideos);  // channel page
videoRouter.get("/:videoId", optionalAuth, getVideoById);       // single video metadata
videoRouter.get("/:videoId/play", optionalAuth, playVideo);
videoRouter.get("/:videoId/link", optionalAuth, getVideoLink);
videoRouter.get("/:videoId/likes/count", optionalAuth, getLikeCount);
videoRouter.get("/:videoId/comments", optionalAuth, getComments);

// ── AUTH WALL — all routes below require a valid JWT ──
videoRouter.use(verifyJWT);

// ── PROTECTED ROUTES ──
videoRouter.post(
  "/",
  upload.fields([
    { name: "videoFile", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
  ]),
  uploadVideo
);
videoRouter.patch("/:videoId", upload.single("thumbnail"), updateVideo);
videoRouter.delete("/:videoId", deleteVideo);                   // ← NEW: delete video
videoRouter.patch("/:videoId/publish", publishVideo);
videoRouter.post("/:videoId/like", likeVideo);
videoRouter.post("/:videoId/dislike", dislikeVideo);
videoRouter.post("/:videoId/comments", addComment);
videoRouter.post("/:videoId/history", saveToWatchHistory);
videoRouter.patch("/:videoId/progress", savePlaybackProgress);
videoRouter.patch("/:videoId/seek", seekVideo);

export { videoRouter };

// ─── PLAYLIST ROUTES ───────────────────────────────────────────────────────────

const playlistRouter = Router();

playlistRouter.use(verifyJWT); // all playlist routes require auth

playlistRouter.post("/", createPlaylist);
playlistRouter.patch("/:playlistId/videos/:videoId", addVideoToPlaylist);

export { playlistRouter };