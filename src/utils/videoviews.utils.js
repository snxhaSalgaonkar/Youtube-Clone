import crypto from "crypto";
import { VideoViews } from "../models/videoViews.model.js";

/**
 * ============================================================
 * UTIL: hashIP
 * ============================================================
 *
 * BEGINNER MISTAKE — Using req.ip directly:
 * Problem: `req.ip` behind a proxy like Nginx returns "127.0.0.1" always.
 * Reason: Express trusts the first layer. Behind a reverse proxy, you must
 *         set `app.set("trust proxy", 1)` so Express reads the real IP
 *         from the X-Forwarded-For header that Nginx injects.
 * Solution: Set trust proxy AND always hash before storing.
 *
 * BEGINNER MISTAKE — Using MD5 or SHA-1 for hashing:
 * Problem: MD5/SHA-1 are cryptographically broken and fast to reverse via rainbow tables.
 * Reason: Someone with a list of common IPs can precompute hashes and deanonymize users.
 * Solution: Use SHA-256. It's still a one-way hash — meaning you cannot reverse it —
 *           but it's collision-resistant and considered secure for this use case.
 *           (Note: for passwords, use bcrypt/argon2. SHA-256 is fine for IPs.)
 *
 * @param {string} ip - Raw IP address string from req.ip
 * @returns {string} - Hex-encoded SHA-256 hash
 */
export function hashIP(ip) {
  if (!ip || typeof ip !== "string") {
    // Fallback: hash an empty string rather than crashing. You still
    // get a consistent value, and you don't expose an unhandled error path.
    return crypto.createHash("sha256").update("unknown").digest("hex");
  }

  return crypto.createHash("sha256").update(ip.trim()).digest("hex");
}

/**
 * ============================================================
 * UTIL: deduplicateView
 * ============================================================
 *
 * This is the core fraud-prevention logic. It answers:
 * "Has this user/IP already been counted as a view for this video
 *  within the last 24 hours?"
 *
 * HOW YOUTUBE-STYLE DEDUPLICATION WORKS IN PRODUCTION:
 * YouTube's actual system is far more complex — they delay view counts,
 * batch-process them, and use ML classifiers to detect bot traffic.
 * For a learning project, the 24-hour time-window check is the
 * industry-standard minimum viable deduplication approach.
 *
 * BEGINNER MISTAKE — Not awaiting the DB check before recording:
 * Problem: Beginners write to DB first, then check for duplicates.
 * Reason: Race condition. Two near-simultaneous requests both pass the
 *         check and both write. The view gets double-counted.
 * Solution: Check first, write second. For production, you'd add
 *           a unique index or use Redis with atomic SETNX to prevent
 *           the race condition entirely.
 *
 * BEGINNER MISTAKE — Using findOne when count is enough:
 * Problem: `findOne` fetches the entire document. You only need to know
 *          if one exists — you don't need its data.
 * Reason: Wastes bandwidth and memory, especially under high traffic.
 * Solution: Use `countDocuments` or `exists`. Even better: `{ _id: 1 }` projection
 *           in a findOne so Mongo returns the minimal document.
 *
 * @param {Object} params
 * @param {string} params.videoId - The video being viewed
 * @param {string|null} params.userId - Authenticated user's ID, or null for guest
 * @param {string} params.ipHash - Hashed IP of the viewer
 * @param {number} [params.windowHours=24] - Dedup window in hours
 * @returns {Promise<boolean>} - true if already viewed (duplicate), false if new view
 */
export async function deduplicateView({
  videoId,
  userId,
  ipHash,
  windowHours = 24,
}) {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  /**
   * Build the query based on whether user is logged in.
   *
   * LOGGED IN user: Deduplicate by userId (more reliable — doesn't break
   * if user switches networks/VPNs).
   *
   * GUEST: Deduplicate by ipHash. Less reliable (shared IPs, VPNs,
   * NAT networks) but it's the only identifier we have.
   *
   * BEGINNER MISTAKE — Always querying by ipHash even for logged-in users:
   * Problem: A logged-in user on a coffee shop WiFi shares an IP with
   *          100 other people. Their view gets blocked because "someone
   *          already viewed from that IP."
   * Solution: Prefer userId for authenticated users. Fall back to ipHash
   *           only for guests.
   */
  const query = {
    videoId,
    watchedAt: { $gte: windowStart },
    ...(userId ? { userId } : { ipHash }),
  };

  const existingView = await VideoViews.findOne(query, { _id: 1 }).lean();

  // .lean() is critical in read-only queries. It returns a plain JS object
  // instead of a full Mongoose document, skipping hydration overhead.
  // In high-traffic paths like view recording, this matters.

  return existingView !== null; // true = duplicate, skip counting
}
