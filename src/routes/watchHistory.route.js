import { Router } from "express";
import {
  upsertWatchHistory,
  getWatchHistory,
  getContinueWatching,
  deleteWatchHistoryEntry,
  clearAllWatchHistory,
  updateWatchProgress,
  checkVideoWatchStatus,
} from "../controllers/watchHistory.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { optionalAuth } from "../middlewares/optionalAuth.middleware.js";

/**
 * MISTAKE #19 — Putting specific routes AFTER parameterized routes
 * Problem:  If you define /:entryId before /continue-watching,
 *           Express matches "continue-watching" as a value for :entryId.
 *           Your getContinueWatching controller never runs.
 * Reason:   Express matches routes TOP TO BOTTOM, FIRST MATCH WINS.
 *           Parameterized segments (:entryId) match ANY string, including
 *           literal path segments like "continue-watching".
 * Solution: Always define specific literal routes BEFORE parameterized ones.
 *
 * WRONG ORDER (breaks):
 *   router.get("/:entryId", ...)          ← matches "continue-watching" as entryId
 *   router.get("/continue-watching", ...) ← NEVER reached
 *
 * CORRECT ORDER (below):
 *   router.get("/continue-watching", ...) ← matched first for that path
 *   router.get("/check/:videoId", ...)    ← matched for /check/abc123
 *   router.delete("/", ...)               ← matched for DELETE /
 *   router.delete("/:entryId", ...)       ← matched for DELETE /abc123
 */

const router = Router();

/**
 * MISTAKE #20 — Not applying rate limiting to write endpoints
 * Problem:  A client (or attacker) hammers POST /watch-history
 *           10,000 times per second. Your DB gets overloaded.
 * Reason:   Without rate limiting, there's nothing stopping a client
 *           from sending unlimited requests.
 * Solution: Use express-rate-limit middleware on write endpoints.
 *           In production this is often done at the API Gateway level
 *           (Nginx, AWS API Gateway, Cloudflare) before requests even
 *           hit your Node.js server. Redis-backed rate limiting
 *           (via rate-limit-redis) is used in multi-server (cluster) setups
 *           because in-memory rate limits don't share state across processes.
 *
 * Example rate limiter (install: npm i express-rate-limit):
 *
 * import rateLimit from "express-rate-limit";
 * const progressUpdateLimiter = rateLimit({
 *   windowMs: 60 * 1000, // 1 minute window
 *   max: 30,             // max 30 progress updates per minute per IP
 *   message: { success: false, message: "Too many requests, slow down" },
 * });
 * router.patch("/progress", verifyJWT, progressUpdateLimiter, updateWatchProgress);
 */

// ── All routes below require authentication ──────────────────────────────────

// GET  /api/v1/watch-history                → paginated full history
router.get("/", verifyJWT, getWatchHistory);

// GET  /api/v1/watch-history/continue-watching → in-progress videos
// NOTE: This MUST be before /:entryId to avoid route shadowing (see above)
router.get("/continue-watching", verifyJWT, getContinueWatching);

// GET  /api/v1/watch-history/check/:videoId → resume position for player
router.get("/check/:videoId", verifyJWT, checkVideoWatchStatus);

// POST /api/v1/watch-history                → create or update history entry (full upsert)
router.post("/", verifyJWT, upsertWatchHistory);

// PATCH /api/v1/watch-history/progress      → lightweight progress-only update
// Used by the flush from Redis → MongoDB. Not the per-second client update.
router.patch("/progress", verifyJWT, updateWatchProgress);

// DELETE /api/v1/watch-history              → clear ALL user history
// NOTE: This MUST be before /:entryId — otherwise "DELETE /" gets misrouted.
// Actually for root-level DELETE this is not an issue, but be explicit about ordering.
router.delete("/", verifyJWT, clearAllWatchHistory);

// DELETE /api/v1/watch-history/:entryId     → delete single entry
router.delete("/:entryId", verifyJWT, deleteWatchHistoryEntry);

export default router;

/**
 * ROUTE REGISTRATION (in your app.js / index.js):
 *
 * import watchHistoryRouter from "./routes/watchHistory.routes.js";
 * app.use("/api/v1/watch-history", watchHistoryRouter);
 *
 * MISTAKE #21 — Registering routes without an API version prefix
 * Problem:  /watch-history is your current API. In 6 months you need
 *           to change the response shape. All existing clients break.
 * Reason:   Without versioning, you can't make breaking changes without
 *           breaking everyone.
 * Solution: Always prefix routes with /api/v1/. When you need to break
 *           compatibility, launch /api/v2/ alongside v1 and deprecate v1
 *           with a sunset header. This is standard REST API practice.
 */
