/**
 * buildPaginationOptions
 *
 * Centralizes all pagination query parsing and validation.
 * Call this once at the top of any controller that returns a list.
 *
 * WHY A UTILITY AND NOT INLINE IN EACH CONTROLLER?
 * Without this, every controller has its own parseInt, its own default,
 * its own clamp logic. Someone writes parseInt(req.query.page) in one place,
 * Number(req.query.page) in another, forgets to validate in a third.
 * Bad input (page=-1, limit=99999) hits MongoDB directly.
 * Centralizing this means you fix it once and every endpoint benefits.
 *
 * WHAT IS "CLAMPING"?
 * Restricting a value to a safe range.
 * Math.max(1, page) prevents page=0 or page=-5.
 * Math.min(limit, MAX_LIMIT) prevents a client requesting limit=100000
 * and dumping your entire collection into one response.
 *
 * OFFSET PAGINATION vs CURSOR PAGINATION:
 * This util implements OFFSET pagination (skip/limit).
 * skip = (page - 1) * limit
 *
 * Problem with offset pagination:
 *   If someone adds a video while a user is on page 2,
 *   the item that was last on page 1 now shifts to page 2.
 *   The user sees a duplicate. This is called "pagination drift".
 *
 * Cursor pagination (using position or _id as a cursor) avoids this.
 * For a beginner project, offset is acceptable. When you see user complaints
 * about duplicate videos in paginated lists, that's your signal to migrate.
 *
 * @param {object} query - req.query object
 * @param {object} overrides - optional defaults to override per-route
 * @returns {{ page, limit, skip, sortField, sortOrder, sortObj }}
 */

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const buildPaginationOptions = (query = {}, overrides = {}) => {
  const defaults = {
    defaultLimit: DEFAULT_LIMIT,
    maxLimit: MAX_LIMIT,
    defaultSortField: "createdAt",
    defaultSortOrder: "desc",
    ...overrides,
  };

  // Parse page — must be a positive integer
  const rawPage = parseInt(query.page, 10);
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : DEFAULT_PAGE;

  // Parse limit — must be a positive integer, capped at maxLimit
  const rawLimit = parseInt(query.limit, 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, rawLimit), defaults.maxLimit)
    : defaults.defaultLimit;

  // skip is what MongoDB uses — how many documents to skip before returning results
  const skip = (page - 1) * limit;

  // Sort field whitelist — never pass raw user input as a sort field to MongoDB.
  // A malicious client could send sortField="password" and cause unintended behavior.
  // Only allow fields you explicitly permit.
  const ALLOWED_SORT_FIELDS = new Set([
    "createdAt",
    "updatedAt",
    "position",
    "addedAt",
    "name",
  ]);

  const rawSortField = query.sortField || defaults.defaultSortField;
  const sortField = ALLOWED_SORT_FIELDS.has(rawSortField)
    ? rawSortField
    : defaults.defaultSortField;

  // Sort order: "asc" → 1, anything else → -1 (desc)
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;

  // sortObj is what you pass directly to .sort() in Mongoose
  const sortObj = { [sortField]: sortOrder };

  return { page, limit, skip, sortField, sortOrder, sortObj };
};

/**
 * buildPaginationMeta
 *
 * Builds the metadata object that goes into every paginated API response.
 * Clients use this to know if there are more pages and how to fetch them.
 *
 * NEVER make the client calculate totalPages themselves.
 * They have limit and total — they could compute it — but you sending it
 * explicitly prevents off-by-one bugs on the client side.
 *
 * @param {number} total - total documents matching the query (from countDocuments)
 * @param {number} page  - current page
 * @param {number} limit - items per page
 * @returns {{ total, page, limit, totalPages, hasNextPage, hasPrevPage }}
 */
export const buildPaginationMeta = (total, page, limit) => {
  const totalPages = Math.ceil(total / limit);

  return {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
};
