import mongoose, { Schema } from "mongoose";

/**
 * VIDEO MODEL — YouTube Clone
 *
 * KEY CONCEPT: Mongoose Schema vs Model
 * - A Schema defines the *shape* of a document (fields, types, rules).
 * - A Model is a class built from that schema — it gives you methods like
 *   Video.find(), Video.create(), video.save(), etc.
 * - Think: Schema = blueprint, Model = the actual factory.
 */

const videoSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    videoFile: {
      type: String,
      required: [true, "Video file URL is required"],
      trim: true,
    },

    /**
     * HLS (HTTP Live Streaming) URL — the adaptive streaming version of the video.
     * HLS splits a video into small segments and adjusts quality based on the
     * viewer's internet speed. YouTube uses a similar approach (DASH).
     * This is generated server-side after upload (e.g., via FFmpeg or Cloudinary).
     */
    hlsUrl: {
      type: String,
      trim: true,
    },
    thumbnail: {
      type: String,
      required: [true, "Thumbnail is required"],
      trim: true,
    },
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
      minlength: [3, "Title must be at least 3 characters"],
      maxlength: [150, "Title cannot exceed 150 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [5000, "Description cannot exceed 5000 characters"],
      default: "",
    },
    duration: {
      type: Number,
      required: true,
      min: [0, "Duration cannot be negative"],
    },

    views: {
      type: Number,
      default: 0,
      min: 0,
    },

    likeCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    commentCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─── PROCESSING STATUS ────────────────────────────────────────────────────

    /**
     * KEY CONCEPT: Enum (Enumerated Values)
     * Restricts the field to a fixed set of valid strings.
     * This prevents typos like "Pending" or "READY" from sneaking into your DB.
     *
     * Video processing lifecycle:
     *   pending → (upload complete, job queued)
     *   processing → (FFmpeg/transcoder working)
     *   ready → (HLS generated, video is watchable)
     *   failed → (something went wrong, needs retry)
     *
     * SYSTEM FAILURE TIP: Always handle the "failed" state in your UI and
     * have a retry/alert mechanism. Never let a video stay stuck in "processing"
     * forever — set a timeout and move it to "failed" if it exceeds it.
     */
    status: {
      type: String,
      enum: {
        values: ["pending", "processing", "ready", "failed"],
        message: "{VALUE} is not a valid status",
      },
      default: "pending",
      index: true,
    },

    visibility: {
      type: String,
      enum: {
        values: ["public", "unlisted", "private"],
        message: "{VALUE} is not a valid visibility option",
      },
      default: "private",
    },
    tags: {
      type: [String],
      default: [],
    },

    resolution: {
      type: [String], // e.g. ["360p", "720p", "1080p"] — populated after processing
      default: [],
    },
    category: {
      type: String,
      trim: true,
      default: "General",
    },
    isPublished: {
      type: Boolean,
      default: false,
    },
  },

  { timestamps: true },
);

// ─── INDEXES ──────────────────────────────────────────────────────────────────

/**
 * SYSTEM FAILURE TIP: Missing indexes on large collections cause slow queries
 * that time out under load. Always index fields you query or sort by frequently.
 *
 * COMMON BEGINNER MISTAKE: Adding indexes on every field. Indexes speed up
 * reads but slow down writes (MongoDB has to update every index on insert/update).
 * Only index fields you actually query on.
 */

// Compound index for the public video feed (most common query)
videoSchema.index({ visibility: 1, status: 1, isPublished: 1, createdAt: -1 });

// Full-text search on title and description
videoSchema.index({ title: "text", description: "text" });

// Fast lookup of all videos by a specific owner
videoSchema.index({ owner: 1, createdAt: -1 });

// ─── PRE-SAVE MIDDLEWARE (Hooks) ──────────────────────────────────────────────

/**
 * KEY CONCEPT: Mongoose Middleware (Hooks)
 * Code that runs automatically before or after certain operations.
 * "pre('save')" runs before every .save() call.
 *
 * This hook normalizes tags so "JavaScript", " javascript ", "JAVASCRIPT"
 * all become "javascript" — consistent data = reliable queries.
 *
 * SECURITY TIP: Data sanitization should always happen on the server,
 * never rely on the client to send clean data.
 */
videoSchema.pre("save", function (next) {
  if (this.isModified("tags")) {
    this.tags = this.tags
      .map((tag) => tag.toLowerCase().trim())
      .filter((tag) => tag.length > 0) // remove empty strings
      .filter((tag, index, arr) => arr.indexOf(tag) === index); // remove duplicates
  }
  next();
});

// ─── VIRTUAL FIELDS ───────────────────────────────────────────────────────────

/**
 * KEY CONCEPT: Virtuals
 * A computed field that is NOT stored in the database.
 * It's calculated on the fly from existing data.
 * Here we convert raw seconds into a human-readable "mm:ss" or "h:mm:ss" string.
 *
 * Virtuals are great for derived data that never needs to be queried/filtered —
 * only displayed. If you need to filter BY it (e.g., "videos longer than 10 min"),
 * store it as a real field instead.
 */
videoSchema.virtual("formattedDuration").get(function () {
  const totalSeconds = Math.floor(this.duration);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
});

// ─── INSTANCE METHODS ─────────────────────────────────────────────────────────

/**
 * KEY CONCEPT: Instance Methods
 * Methods you can call on a single video document (an instance of the model).
 *   const video = await Video.findById(id);
 *   await video.incrementViews();
 *
 * IMPORTANT: Use `function` keyword (not arrow functions) for methods that use
 * `this` — arrow functions don't bind their own `this` in Mongoose.
 */

// Safely increment view count using atomic $inc
videoSchema.methods.incrementViews = async function () {
  return await this.model("Video").findByIdAndUpdate(
    this._id,
    { $inc: { views: 1 } },
    { new: true },
  );
};

// Publish a video (sets both flags atomically)
videoSchema.methods.publish = async function () {
  this.isPublished = true;
  this.visibility = "public";
  return await this.save();
};

// ─── STATIC METHODS ───────────────────────────────────────────────────────────

/**
 * KEY CONCEPT: Static Methods
 * Methods you call on the Model class itself, not on a document instance.
 *   const feed = await Video.getPublicFeed({ page: 1, limit: 20 });
 */

// Reusable public feed query with pagination
videoSchema.statics.getPublicFeed = async function ({
  page = 1,
  limit = 20,
  category,
} = {}) {
  const filter = { visibility: "public", status: "ready", isPublished: true };
  if (category) filter.category = category;

  /**
   * KEY CONCEPT: Aggregation Pipeline
   * For complex queries (sorting, grouping, joining, computed fields),
   * Mongoose's find() isn't enough. The aggregation pipeline processes
   * documents through a series of stages — like a Unix pipe.
   *
   * Here we use the simpler find() + populate() for the feed,
   * but for analytics (trending, recommended) you'd use aggregate().
   */
  return await this.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate("owner", "username avatar") // only fetch username & avatar, not password etc.
    .select("-__v"); // exclude the internal version key
};

// ─── MODEL EXPORT ─────────────────────────────────────────────────────────────

/**
 * KEY CONCEPT: Preventing "Cannot overwrite model" errors
 * In development, hot-reloading can call this file multiple times.
 * If the "Video" model is already registered, use it — don't re-create it.
 * This is a common beginner error that crashes the server during development.
 */
export const Video =
  mongoose.models.Video || mongoose.model("Video", videoSchema);
