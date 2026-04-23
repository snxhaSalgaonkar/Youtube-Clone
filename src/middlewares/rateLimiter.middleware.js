/**
 * RATE LIMITER MIDDLEWARE
 *
 * WHAT IS RATE LIMITING?
 * It restricts how many requests a single client (IP or user) can make
 * within a time window. Without it:
 * - Bots can upload thousands of videos, filling your storage.
 * - Attackers can brute-force login attempts.
 * - A single user can accidentally (or intentionally) DoS your server.
 *
 * LIBRARY: express-rate-limit
 * Install: npm install express-rate-limit
 *
 * KEY CONCEPT: In-memory vs Distributed rate limiting
 * express-rate-limit by default stores counters IN MEMORY on your Node process.
 * Problem: If you have 3 server instances (horizontal scaling), each has its
 * own counter. A user can hit all 3 servers and exceed the limit 3x.
 *
 * PRODUCTION FIX: Use a Redis store (rate-limit-redis package).
 * Redis is a shared in-memory store accessible to all instances.
 * All counters live in one place — limits work correctly across all servers.
 *
 * Example with Redis store:
 *   import RedisStore from "rate-limit-redis";
 *   import { createClient } from "redis";
 *   const redisClient = createClient({ url: process.env.REDIS_URL });
 *   store: new RedisStore({ sendCommand: (...args) => redisClient.sendCommand(args) })
 */

import rateLimit from "express-rate-limit";
import { ApiError } from "../utils/ApiError.js";

// ─── UPLOAD RATE LIMITER ──────────────────────────────────────────────────────

/**
 * Most restrictive limiter — uploading is expensive (storage, processing).
 * 5 uploads per hour per IP is generous enough for real users,
 * tight enough to stop bot abuse.
 */
const rawUploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 5, // max 5 requests per window per IP
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable deprecated X-RateLimit-* headers

  // Custom error handler — returns your ApiError format instead of default HTML
  handler: (req, res, next, options) => {
    console.log("❌ Rate limit exceeded for IP:", req.ip);
    next(
      new ApiError(
        429,
        `Too many upload requests. You can upload up to ${options.max} videos per hour. Try again later.`,
      ),
    );
  },

  // Skip rate limiting for admin users (identified after JWT decode)
  skip: (req) => {
    const isAdmin = req.user?.role === "admin";
    console.log(
      "📊 Rate limiter check - User:",
      req.user?.email,
      "IsAdmin:",
      isAdmin,
    );
    return isAdmin;
  },
});

// Wrapper to log rate limiter flow
export const uploadRateLimiter = (req, res, next) => {
  console.log(
    "*******************upload rateLimiter called from rateLimiter.M********** ",
  );
  console.log("🚦 uploadRateLimiter: Checking rate limits...");
  rawUploadRateLimiter(req, res, (err) => {
    if (!err) {
      console.log("✅ Rate limit check passed, proceeding...");
    } else {
      console.log("❌ Rate limit error:", err.message);
    }
    next(err);
  });
};

// ─── GENERAL API RATE LIMITER ─────────────────────────────────────────────────

/**
 * Applied broadly to all routes as a baseline protection.
 * 200 requests per 15 minutes = ~13 requests/minute = normal browsing.
 * Scrapers and bots typically hit hundreds per second.
 */
// export const generalRateLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 200,
//   standardHeaders: true,
//   legacyHeaders: false,
//   handler: (req, res, next) => {
//     next(new ApiError(429, "Too many requests. Please slow down."));
//   },
// });

// ─── SEARCH RATE LIMITER ──────────────────────────────────────────────────────
export const generalRateLimiter = (options = {}) => {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000,
    max: options.max || 200,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => {
      next(new ApiError(429, "Too many requests. Please slow down."));
    },
  });
};
/**
 * Search queries hit text indexes and can be expensive under load.
 * Separate limiter allows you to tune it independently.
 */
export const searchRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 searches/minute is plenty
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(
      new ApiError(
        429,
        "Too many search requests. Wait a moment and try again.",
      ),
    );
  },
});

// ─── VIEW COUNT RATE LIMITER ──────────────────────────────────────────────────

/**
 * Prevents view count manipulation. One view per IP per 30 minutes.
 * Real view deduplication needs user session tracking + time-in-video checks.
 * This is a basic layer of protection.
 */
export const viewCountRateLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 minutes
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use IP + videoId combination so the limit is per-video, not global
    return `${req.ip}-${req.params.videoId}`;
  },
  handler: (req, res, next) => {
    // Don't throw an error — silently skip duplicate views
    // Return 200 so the player doesn't know it was skipped
    res.status(200).json({ message: "View already counted" });
  },
});
