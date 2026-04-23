import { Router } from "express";
import {
  recordView,
  getViewCount,
  getUniqueViewers,
  getViewAnalytics,
} from "../controllers/videoviews.controller.js";
import { optionalAuth } from "../middlewares/optionalAuth.middleware.js";
import { generalRateLimiter } from "../middlewares/rateLimiter.middleware.js";

/**
 * ============================================================
 * VIDEO VIEWS ROUTER
 * ============================================================
 *
 * BEGINNER MISTAKE — Putting all routes in app.js / server.js:
 * Problem: Beginners write all route definitions in a single file.
 * Reason: At scale, one file becomes unmaintainable and causes merge
 *         conflicts in teams.
 * Solution: One Router per resource (videos, users, views, comments).
 *           Mount them in app.js with a base path prefix.
 *
 * Mount in app.js like:
 *   import viewsRouter from "./routes/videoViews.routes.js";
 *   app.use("/api/v1/views", viewsRouter);
 *
 * BEGINNER MISTAKE — Not applying rate limiting before auth:
 * Problem: Applying middlewares in the wrong order means the DB is hit
 *          before rate limiting can block the request.
 * Reason: Middleware executes left-to-right in Express. Expensive operations
 *         (DB queries, JWT verification) should come AFTER cheap guards
 *         (rate limiting).
 * Solution: Order: rateLimiter → optionalAuth → controller.
 *           The cheapest guard always runs first.
 *
 * BEGINNER MISTAKE — Using the same rate limiter for all routes:
 * Problem: Applying the same aggressive rate limit to analytics endpoints
 *          (which creators poll regularly) as to the write endpoint.
 * Solution: Different limits for different routes based on expected traffic.
 *           Write (POST record): very strict (e.g., 5 req/min per IP).
 *           Read (GET count, analytics): relaxed (e.g., 60 req/min).
 */

const router = Router();

/**
 * POST /:videoId
 * Record a video view — with deduplication and rate limiting.
 *
 * Rate limit is strict here: this is the write path that bots attack.
 * optionalAuth populates req.user if a valid token exists (guests are fine too).
 */
router.post(
  "/:videoId",
  generalRateLimiter({ windowMs: 60 * 1000, max: 5 }), // 5 requests/minute per IP
  optionalAuth,
  recordView,
);

/**
 * GET /:videoId/count
 * Get total view count for a video.
 * Public endpoint — no auth needed. Relaxed rate limit.
 */
router.get(
  "/:videoId/count",
  generalRateLimiter({ windowMs: 60 * 1000, max: 5 }),
  getViewCount,
);

/**
 * GET /:videoId/unique-viewers
 * Get count of unique viewers (authenticated users + unique guest IPs).
 * Useful for creator analytics. Still public — no sensitive data exposed.
 */
router.get(
  "/:videoId/unique-viewers",
  generalRateLimiter({ windowMs: 60 * 1000, max: 30 }),
  getUniqueViewers,
);

/**
 * GET /:videoId/analytics
 * Get daily view breakdown for creator dashboard.
 * Query param: ?days=30 (default 30, max 90)
 */
router.get(
  "/:videoId/analytics",
  generalRateLimiter({ windowMs: 60 * 1000, max: 20 }),
  getViewAnalytics,
);

export default router;
