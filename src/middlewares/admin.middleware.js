/**
 * ADMIN ROLE VERIFICATION MIDDLEWARE
 *
 * KEY CONCEPT: Role-based Access Control (RBAC)
 * Middleware that checks if the authenticated user has the required role.
 * Used after JWT verification to enforce authorization.
 *
 * SECURITY TIP: A user is authenticated (has valid JWT) but not authorized
 * (doesn't have the required role). Always check both:
 * 1. Authentication (verifyJWT) — is this token valid?
 * 2. Authorization (verifyRole) — does this user have permission?
 *
 * PATTERN: Role-based middleware is a factory that returns Express middleware.
 * This allows reusing the same function for different roles:
 *   verifyRole("admin") → checks for admin role
 *   verifyRole("moderator") → checks for moderator role
 *   verifyRole(["admin", "moderator"]) → checks if user is either role
 */

import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Legacy middleware: Check if user is admin
 * @deprecated Use verifyRole("admin") instead
 */
export const isAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    throw new ApiError(403, "Access denied: Admins only");
  }
  next();
};

/**
 * Middleware factory for role-based access control
 *
 * @param {string|string[]} allowedRoles - Single role or array of allowed roles
 * @returns {Function} Express middleware that validates user role
 *
 * Example:
 *   router.patch("/admin/settings", verifyJWT, verifyRole("admin"), updateSettings)
 *   router.delete("/content/:id", verifyJWT, verifyRole(["admin", "moderator"]), deleteContent)
 */
export const verifyRole = (allowedRoles) => {
  return asyncHandler((req, res, next) => {
    // Ensure user is authenticated (populated by verifyJWT middleware)
    if (!req.user) {
      throw new ApiError(401, "Authentication required");
    }

    // Normalize allowedRoles to array
    const rolesArray = Array.isArray(allowedRoles)
      ? allowedRoles
      : [allowedRoles];

    // Check if user's role is in the allowed roles
    if (!rolesArray.includes(req.user.role)) {
      throw new ApiError(
        403,
        `Access denied: Requires one of roles [${rolesArray.join(", ")}]`,
      );
    }

    // User has required role, proceed to next middleware/controller
    next();
  });
};
