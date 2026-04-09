import mongoose, { Schema } from "mongoose";
import mongooseAggregatePaginate from "mongoose-aggregate-paginate-v2";

/**
 * COMMENT MODEL
 *
 * Represents a comment on a video. Supports:
 * - Top-level comments (parentComment = null)
 * - Nested replies (parentComment = ObjectId of parent comment)
 *
 * This is a self-referencing schema — a comment can reference another comment
 * as its parent. This is how threaded comments (like YouTube replies) work.
 */

const commentSchema = new Schema(
  {
    // --- FOREIGN KEYS (References to other collections) ---

    /**
     * The video this comment belongs to.
     * Required — a comment cannot exist without a video.
     *
     * BEGINNER MISTAKE: Storing the video's title/URL here instead of its ObjectId.
     * Always reference by ObjectId. You join the actual data at query time using
     * .populate() or $lookup in aggregation. This is called normalization.
     */
    video: {
      type: Schema.Types.ObjectId,
      ref: "Video",
      required: true,
      index: true, // Index this — you'll frequently query "all comments for a video"
    },

    /**
     * The user who wrote the comment.
     * Required — anonymous comments are not allowed in this system.
     *
     * BEGINNER MISTAKE: Embedding the entire user object here (name, avatar, etc.).
     * If the user updates their profile, you'd have stale data everywhere.
     * Always store just the reference. Populate on demand.
     */
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // --- CORE FIELDS ---

    /**
     * The actual text of the comment.
     *
     * trim: true — strips leading/trailing whitespace before saving.
     * maxLength — enforced at the DB level as a last line of defense.
     *
     * SECURITY NOTE: This does NOT sanitize HTML or scripts. If you ever render
     * this content as raw HTML in a browser, you have an XSS (Cross-Site Scripting)
     * vulnerability. Always sanitize user-generated content before rendering.
     * Libraries like DOMPurify (frontend) or sanitize-html (backend) handle this.
     *
     * BEGINNER MISTAKE: Only validating on the frontend. Never trust the client.
     * Validation must exist on the server/DB level. Someone can bypass your UI
     * entirely and hit your API directly with malformed data.
     */
    content: {
      type: String,
      required: [true, "Comment content is required"],
      trim: true,
      minLength: [1, "Comment cannot be empty"],
      maxLength: [1000, "Comment cannot exceed 1000 characters"],
    },

    /**
     * Self-referencing field for nested replies.
     * null = top-level comment
     * ObjectId = this is a reply to that comment
     *
     * PRODUCTION NOTE: In large-scale systems (Reddit, YouTube), deeply nested
     * threads are often flattened — all replies reference the ROOT comment,
     * not each other. This avoids recursive queries and keeps pagination simple.
     * For a learning project, one level of nesting (comment → reply) is fine.
     *
     * BEGINNER MISTAKE: Not indexing this field. If you want to fetch all replies
     * to a comment, MongoDB has to scan the entire collection without an index.
     * At scale, this becomes a serious performance problem.
     */
    parentComment: {
      type: Schema.Types.ObjectId,
      ref: "Comment",
      default: null,
      index: true,
    },

    /**
     * Stores the count of likes, NOT the actual like documents.
     *
     * DESIGN DECISION: Likes are typically a separate collection (Like model)
     * with references to both the comment and user. This field is a DENORMALIZED
     * cache of that count for fast reads.
     *
     * BEGINNER MISTAKE: Fetching all like documents and using .length to count.
     * At 10,000 likes, that's a massive query just to show a number.
     *
     * PRODUCTION TECHNIQUE: Use atomic operations like $inc to update this counter:
     *   Comment.findByIdAndUpdate(id, { $inc: { likeCount: 1 } })
     * This is safe under concurrent requests — unlike read-then-write patterns
     * which are vulnerable to race conditions.
     *
     * NOTE: Keep this in sync with your Like model via post-save hooks or
     * a background job. If they diverge, this number becomes stale (denormalization cost).
     */
    likeCount: {
      type: Number,
      default: 0,
      min: [0, "Like count cannot be negative"],
    },

    /**
     * Soft delete flag.
     *
     * PRODUCTION TECHNIQUE: Never hard-delete comments in a real system.
     * If a comment has replies and you delete it, the replies lose context.
     * Instead, mark it as deleted and render "[Comment deleted]" on the frontend.
     * This is called a soft delete pattern.
     *
     * This field is not in your schema diagram — but you will need it.
     * Adding it now saves a painful migration later.
     */
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    /**
     * timestamps: true
     * Automatically adds `createdAt` and `updatedAt` fields.
     * Mongoose manages these — you never set them manually.
     *
     * BEGINNER MISTAKE: Creating these fields manually and forgetting to
     * update `updatedAt` on every save. Let Mongoose handle it.
     */
    timestamps: true,
  },
);

// =============================================================================
// INDEXES
// =============================================================================

/**
 * Compound index: fetch all comments for a video, ordered by newest first.
 * This is your most common query pattern. Without this, every comment fetch
 * is a full collection scan.
 *
 * PRODUCTION NOTE: MongoDB uses indexes similar to a book's index — instead of
 * reading every page, it jumps directly to the right location. A missing index
 * on a large collection is one of the most common causes of slow APIs in production.
 */
commentSchema.index({ video: 1, createdAt: -1 });

/**
 * Compound index: fetch all top-level comments for a video (no parent).
 * Partial indexes like this are more efficient — they only index documents
 * that match the filter, keeping the index small.
 */
commentSchema.index(
  { video: 1, parentComment: 1, createdAt: -1 },
  { partialFilterExpression: { parentComment: null } },
);

// =============================================================================
// PLUGINS
// =============================================================================

/**
 * mongooseAggregatePaginate
 *
 * This plugin adds `.aggregatePaginate()` to your model, allowing you to
 * paginate results from MongoDB aggregation pipelines.
 *
 * WHY PAGINATION MATTERS: Returning all comments in a single response is
 * never acceptable in production. A video with 50,000 comments would crash
 * your server or time out. Always paginate.
 *
 * Aggregation pipelines ($lookup, $match, $group) are more powerful than
 * simple .find() queries. You'll use them to join comment data with user
 * info, filter deleted comments, and count replies — all in one DB call.
 *
 * BEGINNER MISTAKE: Using .skip() + .limit() manually for pagination.
 * This works but becomes slow on large offsets because MongoDB still scans
 * all skipped documents. Cursor-based pagination (using _id as a cursor)
 * is the production standard, but skip/limit is fine while learning.
 */
commentSchema.plugin(mongooseAggregatePaginate);

// =============================================================================
// KEY TECHNIQUES YOU SHOULD KNOW BUT MIGHT NOT YET
// =============================================================================

/**
 * 1. MONGOOSE MIDDLEWARE (Pre/Post Hooks)
 *    You can run logic before or after a save/delete/find operation.
 *    Example use case: When a comment is deleted, automatically delete all
 *    its replies and their associated likes.
 *
 *    commentSchema.pre("findOneAndDelete", async function (next) {
 *      await Comment.deleteMany({ parentComment: this._conditions._id });
 *      next();
 *    });
 *
 *    Without this, deleting a parent comment leaves orphaned reply documents
 *    in your database. In production this is called a "cascading delete".
 *
 * 2. VIRTUAL FIELDS
 *    Fields that are computed at read time and NOT stored in the database.
 *    Example: a `isReply` virtual that returns true if parentComment is set.
 *
 *    commentSchema.virtual("isReply").get(function () {
 *      return this.parentComment !== null;
 *    });
 *
 * 3. OPTIMISTIC CONCURRENCY CONTROL
 *    When two users like a comment simultaneously, a read-then-write pattern
 *    like (likeCount + 1) can produce incorrect results (race condition).
 *    MongoDB's $inc is atomic — it always produces the correct result
 *    regardless of concurrent requests.
 *
 * 4. TTL INDEXES (Time-To-Live)
 *    MongoDB can automatically delete documents after a set time.
 *    Not needed for comments, but useful for things like OTP tokens,
 *    sessions, or temporary data.
 *
 * 5. SCHEMA VALIDATION VS. MIDDLEWARE VALIDATION
 *    Mongoose schema validators (required, minLength) run before saving.
 *    But they don't run on update operations by default. You need to pass
 *    { runValidators: true } in your update calls:
 *    Comment.findByIdAndUpdate(id, data, { runValidators: true })
 *
 * 6. $LOOKUP (MongoDB JOIN)
 *    When you need user details alongside a comment, instead of N separate
 *    .populate() calls (which fire N database queries), use a single
 *    aggregation pipeline with $lookup. This is one query, regardless of
 *    how many documents you're joining.
 */

export const Comment = mongoose.model("Comment", commentSchema);
