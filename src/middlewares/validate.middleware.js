/**
 * VALIDATION MIDDLEWARE
 *
 * KEY CONCEPT: Chain-based validation using express-validator
 * The validate() middleware wraps an array of validation rules and:
 * 1. Executes all validators in the array (body, query, param checks)
 * 2. Collects any errors via validationResult()
 * 3. If errors exist, throws ApiError with 400 status
 * 4. If valid, passes control to the next middleware/controller
 *
 * USAGE:
 * router.post("/", validate(uploadVideoValidator), controller)
 *
 * WHY NOT JUST validationResult() IN THE CONTROLLER?
 * Separating validation from business logic keeps controllers clean.
 * Middleware handles HTTP-layer concerns; controllers handle app logic.
 * We fail fast at the middleware layer before hitting the database.
 */

import { validationResult } from "express-validator";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * Middleware factory that validates request data using express-validator chains
 *
 * @param {Array} validators - Array of express-validator rules (body(), query(), param())
 * @returns {Function} Express middleware that validates and passes control if valid
 *
 * Example:
 *   const validator = [
 *     body('email').isEmail(),
 *     body('password').isLength({ min: 8 })
 *   ];
 *   app.post('/signup', validate(validator), controller);
 */
export const validate = (validators) => {
  return asyncHandler(async (req, res, next) => {
    console.log("**************validate called from validate.M*******");
    console.log("🔄 Validate middleware: Running validators...");
    // Run all validators in sequence (they modify req by attaching validation metadata)
    await Promise.all(validators.map((validator) => validator.run(req)));

    // Extract validation results
    const errors = validationResult(req);
    console.log("✅ Validation results:", errors.array().length, "errors");

    // If validation failed, throw ApiError with all error details
    if (!errors.isEmpty()) {
      const formattedErrors = errors.array().map((error) => ({
        field: error.param || error.path,
        message: error.msg,
        value: error.value,
      }));

      throw new ApiError(400, "Validation failed", formattedErrors);
    }

    console.log("✅ Validation passed. Calling next()...");
    // If validation passed, proceed to next middleware/controller
    next();
  });
};

// Using zod for runtime request body validation
import { z } from "zod";

const watchHistorySchema = z.object({
  videoId: z.string().min(1),
  watchedPercent: z.number().min(0).max(100),
  lastPositionSeconds: z.number().min(0).optional(),
});
