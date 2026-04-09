import sanitizeHtml from "sanitize-html";

// =============================================================================
// sanitizeContent
// =============================================================================
/**
 * Strips all HTML tags and dangerous content from user-submitted text.
 *
 * WHY THIS EXISTS:
 * If someone submits: <script>document.cookie</script> nice video!
 * And you store + render that raw — every user who loads that comment
 * runs that script in their browser. Their session cookies get stolen.
 * This is XSS (Cross-Site Scripting). It is in the OWASP Top 10.
 *
 * sanitize-html with allowedTags: [] strips EVERYTHING — plain text only.
 * If you ever want to allow formatting (bold, links), explicitly whitelist
 * those tags here. Never blacklist — attackers find tags you forgot to block.
 *
 * BEGINNER MISTAKE: Using regex to strip HTML tags.
 * Regex-based HTML sanitization is broken by design. There are hundreds of
 * ways to encode a script tag that bypass naive regex. Use a real parser.
 *
 * @param {string} text - Raw user input
 * @returns {string} - Safe plain text
 */
export const sanitizeContent = (text) => {
  if (!text || typeof text !== "string") return "";

  const sanitized = sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  });

  // Collapse excessive whitespace — prevents 10,000-space "comments"
  return sanitized.trim().replace(/\s+/g, " ");
};

// =============================================================================
// buildPaginationOptions
// =============================================================================
/**
 * Normalizes pagination query params into a safe options object
 * for mongooseAggregatePaginate.
 *
 * SECURITY NOTE:
 * Query params come in as strings. ?page="abc" or ?limit=99999 are both
 * valid URLs. This function coerces types and clamps to safe ranges.
 * Never pass raw req.query into a DB query.
 *
 * MAX LIMIT = 50: Returning 1000 documents in one response can crash your
 * server under load. Always enforce a ceiling.
 *
 * @param {object} query - req.query
 * @param {object} overrides - optional sort or custom options
 * @returns {object} - safe pagination options
 */
export const buildPaginationOptions = (query = {}, overrides = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 10));

  return {
    page,
    limit,
    customLabels: {
      docs: "comments",
      totalDocs: "totalComments",
      totalPages: "totalPages",
      currentPage: "currentPage",
      nextPage: "nextPage",
      prevPage: "prevPage",
      hasPrevPage: "hasPrevPage",
      hasNextPage: "hasNextPage",
    },
    ...overrides,
  };
};

// =============================================================================
// isValidObjectId
// =============================================================================
/**
 * Validates a MongoDB ObjectId string before hitting the database.
 *
 * WHY: If someone passes ?videoId=notanid, Mongoose throws a CastError deep
 * inside the query. That leaks stack traces and is hard to debug.
 * Checking upfront gives a clean 400 response.
 *
 * @param {string} id
 * @returns {boolean}
 */
export const isValidObjectId = (id) => {
  return /^[a-fA-F0-9]{24}$/.test(id);
};
