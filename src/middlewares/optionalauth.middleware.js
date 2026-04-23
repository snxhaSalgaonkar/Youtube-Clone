import jwt from "jsonwebtoken";

/**
 * ============================================================
 * MIDDLEWARE: optionalAuth
 * ============================================================
 *
 * PURPOSE:
 * Standard auth middleware (the kind you use on protected routes) calls
 * `next(error)` when no token is present. That's correct for protected routes,
 * but view recording is PUBLIC — guests can watch videos too.
 *
 * This middleware attempts to authenticate, but NEVER blocks the request.
 * If the token is valid → req.user is populated.
 * If no token or invalid token → req.user stays null, request continues.
 *
 * This pattern is called "optional authentication" or "partial auth."
 *
 * BEGINNER MISTAKE — Using the same auth middleware everywhere:
 * Problem: Attaching your standard `verifyJWT` middleware to the view route
 *          means guests (no token) get a 401 Unauthorized error when trying
 *          to watch a video. Public content becomes inaccessible.
 * Reason: Middleware that calls `next(error)` on missing tokens is designed
 *         for protected routes, not public ones.
 * Solution: Write a separate `optionalAuth` middleware that silently skips
 *           authentication failures and always calls `next()` with no error.
 *
 * BEGINNER MISTAKE — Crashing on malformed JWT:
 * Problem: `jwt.verify()` throws if the token is malformed or expired.
 *          Beginners don't wrap it in try/catch, so a bad cookie/header
 *          crashes the entire request with an unhandled exception.
 * Reason: Any client can send a garbage Authorization header.
 * Solution: Always wrap jwt.verify() in try/catch. On failure, just set
 *           req.user = null and move on.
 *
 * BEGINNER MISTAKE — Reading tokens from the wrong place:
 * Problem: Some beginners only check `req.headers.authorization` but their
 *          frontend sends the token in a cookie (or vice versa).
 * Reason: JWTs can be transported via Bearer header OR HttpOnly cookies.
 *         HttpOnly cookies are more secure (JS can't read them) but require
 *         cookie-parser middleware.
 * Solution: Check both sources. Prefer cookies for browser clients since
 *           they're immune to XSS token theft.
 */
export function optionalAuth(req, res, next) {
  try {
    // Check cookie first (preferred for browser clients — XSS safe)
    // Then fall back to Authorization header (used by mobile apps, API clients)
    const token =
      req.cookies?.accessToken ||
      req.headers.authorization?.replace("Bearer ", "").trim();

    if (!token) {
      req.user = null;
      return next();
    }

    // jwt.verify throws on:
    // - Expired token (TokenExpiredError)
    // - Invalid signature (JsonWebTokenError)
    // - Malformed token
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    /**
     * BEGINNER MISTAKE — Trusting the entire decoded payload:
     * Problem: Storing the full user object in the JWT and reading all
     *          fields from it without re-checking the DB.
     * Reason: If a user is banned/deleted, their token still works until
     *         it expires. You're serving stale data.
     * Solution: For critical operations, fetch the user from DB here.
     *           For view recording, just the userId from the token is enough.
     *           We're not doing anything privileged with it.
     */
    req.user = { _id: decoded._id }; // Only extract what you need
    next();
  } catch (error) {
    // Token is invalid/expired — treat as guest, don't block
    req.user = null;
    next();
  }
}