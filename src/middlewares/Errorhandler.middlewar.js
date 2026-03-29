/**
 * GLOBAL ERROR HANDLER MIDDLEWARE
 *
 * KEY CONCEPT: Express Global Error Middleware
 * A middleware with 4 parameters (err, req, res, next) is Express's error handler.
 * It must be registered LAST in app.js — after all routes.
 * When any controller calls next(err) or throws inside asyncHandler, this runs.
 *
 * SECURITY TIPS:
 * 1. Never send stack traces to the client in production — they reveal your
 *    internal code structure to attackers.
 * 2. Never send raw MongoDB error messages (e.g., "E11000 duplicate key error
 *    collection: videos index: email_1") — these leak schema information.
 * 3. Always return a consistent response shape (same as ApiResponse).
 *
 * SYSTEM FAILURE TIP: Log ALL errors to a structured logging service
 * (Winston + Datadog/Loggly/CloudWatch). Silent errors = unknown failures.
 * In production, you want to be alerted when 500 errors spike.
 *
 * COMMON BEGINNER MISTAKE: Returning the raw err object to the client:
 *   res.json(err) — this sends everything including the stack trace.
 */

import { ApiError } from "../utils/apiResponse.js";

export const globalErrorHandler = (err, req, res, next) => {
  // Log the full error internally (use a proper logger in production)
  console.error(`[ERROR] ${req.method} ${req.path}`, {
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    statusCode: err.statusCode,
  });

  // Handle known operational errors (our ApiError class)
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      statusCode: err.statusCode,
      message: err.message,
      errors: err.errors,
    });
  }

  // Handle Mongoose validation errors (e.g., required field missing)
  if (err.name === "ValidationError") {
    const errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: "Validation failed",
      errors,
    });
  }

  // Handle Mongoose duplicate key error (unique index violation)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    return res.status(409).json({
      success: false,
      statusCode: 409,
      message: `Duplicate value for ${field}. Please use a different value.`,
      errors: [],
    });
  }

  // Handle Mongoose CastError (e.g., invalid ObjectId format)
  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: `Invalid ${err.path}: ${err.value}`,
      errors: [],
    });
  }

  // Handle Multer errors
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      statusCode: 400,
      message: "File too large. Maximum allowed size is 500MB.",
      errors: [],
    });
  }

  // Catch-all: unknown/unexpected errors
  // SECURITY: Never expose internal error details in production
  return res.status(500).json({
    success: false,
    statusCode: 500,
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Internal server error. Please try again later.",
    errors: [],
  });
};
