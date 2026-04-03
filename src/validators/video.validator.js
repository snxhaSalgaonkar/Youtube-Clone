/**
 * VIDEO VALIDATORS
 *
 * KEY CONCEPT: Input Validation vs Sanitization
 * Validation = checking if data meets rules (required, type, length).
 * Sanitization = cleaning data (trimming whitespace, escaping HTML, lowercasing).
 *
 * LIBRARY: express-validator
 * Install: npm install express-validator
 *
 * WHY NOT RELY ON MONGOOSE VALIDATION ALONE?
 * Mongoose validates at the DB layer — after your controller code runs.
 * If a user sends garbage input, you've already burned CPU processing it.
 * Validate at the HTTP layer (here) first, reject early, fail fast.
 * Also, Mongoose errors return ugly messages that leak schema details.
 * express-validator gives you clean, user-friendly error messages.
 *
 * SECURITY TIP: Never trust any data from req.body, req.query, or req.params.
 * Treat all user input as hostile until proven otherwise.
 */

import { body, query, param } from "express-validator";

// ─── UPLOAD VIDEO VALIDATOR ───────────────────────────────────────────────────

export const uploadVideoValidator = [
  body("title")
    .trim()
    .notEmpty()
    .withMessage("Title is required")
    .isLength({ min: 3, max: 150 })
    .withMessage("Title must be between 3 and 150 characters"),

  body("description")
    .optional()
    .trim()
    .isLength({ max: 5000 })
    .withMessage("Description cannot exceed 5000 characters"),

  body("tags")
    .optional()
    .custom((value) => {
      // Tags come as JSON string from multipart form
      try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        if (!Array.isArray(parsed)) throw new Error();
        if (parsed.length > 20) throw new Error("Too many tags");
        return true;
      } catch {
        throw new Error("Tags must be a valid JSON array with max 20 items");
      }
    }),

  body("category")
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Category cannot exceed 50 characters"),

  body("visibility")
    .optional()
    .isIn(["public", "unlisted", "private"])
    .withMessage("Visibility must be: public, unlisted, or private"),
];

// ─── UPDATE VIDEO VALIDATOR ───────────────────────────────────────────────────

export const updateVideoValidator = [
  body("title")
    .optional()
    .trim()
    .isLength({ min: 3, max: 150 })
    .withMessage("Title must be between 3 and 150 characters"),

  body("description")
    .optional()
    .trim()
    .isLength({ max: 5000 })
    .withMessage("Description cannot exceed 5000 characters"),

  body("tags")
    .optional()
    .isArray({ max: 20 })
    .withMessage("Tags must be an array with max 20 items"),

  body("visibility")
    .optional()
    .isIn(["public", "unlisted", "private"])
    .withMessage("Visibility must be: public, unlisted, or private"),

  body("category")
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Category name too long"),
];

// ─── GET ALL VIDEOS QUERY VALIDATOR ───────────────────────────────────────────

export const getAllVideosValidator = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Page must be a positive integer")
    .toInt(),

  query("limit")
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage("Limit must be between 1 and 50")
    .toInt(),

  query("sortBy")
    .optional()
    .isIn(["createdAt", "views", "likeCount", "duration"])
    .withMessage("sortBy must be: createdAt, views, likeCount, or duration"),

  query("sortType")
    .optional()
    .isIn(["asc", "desc"])
    .withMessage("sortType must be 'asc' or 'desc'"),

  query("query")
    .optional()
    .trim()
    .isLength({ min: 2, max: 200 })
    .withMessage("Search query must be between 2 and 200 characters")
    // Escape HTML entities to prevent XSS if the query is ever rendered in UI
    .escape(),

  query("minDuration")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("minDuration must be a non-negative number")
    .toFloat(),

  query("maxDuration")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("maxDuration must be a non-negative number")
    .toFloat(),
];

// ─── VIDEO ID PARAM VALIDATOR ─────────────────────────────────────────────────

/**
 * Reusable validator for routes with /:videoId param.
 * Always validate ObjectId format before hitting the DB —
 * Mongoose throws an ugly CastError if you pass "abc" as an ObjectId.
 */
export const videoIdParamValidator = [
  param("videoId").isMongoId().withMessage("Invalid video ID format"),
];
