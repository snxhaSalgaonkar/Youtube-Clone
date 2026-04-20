import mongoose, { Schema } from "mongoose";

/**
 * VISIBILITY RULES (as per schema design):
 * - "public"  → playlist is visible to everyone; created/managed by a channel
 * - "private" → playlist is visible only to the owner; personal user playlist
 *
 * These are enforced at the model level via enum validation.
 * Authorization logic (who can change visibility) belongs in the controller/service layer.
 */

const playlistSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Playlist name is required"],
      trim: true,
      minlength: [1, "Playlist name cannot be empty"],
      maxlength: [150, "Playlist name cannot exceed 150 characters"],
    },

    description: {
      type: String,
      trim: true,
      default: "",
      maxlength: [500, "Description cannot exceed 500 characters"],
    },

    /**
     * VISIBILITY ENUM
     * Never store raw strings without enums in production.
     * Without enum validation, a bad client payload like visibility: "friends_only"
     * would silently persist into the DB — corrupting your query logic downstream.
     */
    visibility: {
      type: String,
      enum: {
        values: ["public", "private"],
        message: "Visibility must be either 'public' or 'private'",
      },
      default: "private",
    },

    /**
     * OWNER (FK → User)
     * This is always the User who owns or created the playlist.
     * "Channel" in your system is a representation of the user in public context —
     * not a separate collection. So owner always points to User._id.
     *
     * Beginner mistake: Storing owner as a plain string (e.g., "userId_123").
     * That breaks .populate(), loses referential integrity, and can't be indexed properly.
     */
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Playlist must have an owner"],
      index: true, // INDEX: frequent query — "get all playlists by this user"
    },

    /**
     * VIDEOS ARRAY
     * Stores references to Video documents.
     *
     * IMPORTANT PRODUCTION CONSIDERATION:
     * If a playlist can grow very large (500+ videos), storing all video refs
     * inside a single document array will eventually hit MongoDB's 16MB document limit.
     * For a beginner project this is fine. At scale, use a separate PlaylistItem
     * collection with (playlistId, videoId, position) — this also enables
     * efficient reordering and pagination without loading the full document.
     *
     * For now: cap is enforced via validate() to keep the document safe.
     */
    videos: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "Video",
        },
      ],
      default: [],
      validate: {
        validator: function (arr) {
          return arr.length <= 500;
        },
        message: "A playlist cannot contain more than 500 videos",
      },
    },

    /**
     * THUMBNAIL (optional)
     * Usually auto-derived from the first video, but allowing explicit override
     * is a common production pattern (Cloudinary URL or similar CDN URL).
     */
    thumbnail: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true, // automatically manages createdAt and updatedAt

    /**
     * toJSON / toObject with virtuals: true
     * Ensures virtual fields (like videoCount) are included when you do
     * res.json(playlist) or playlist.toObject() in your controller.
     * Without this, virtuals are invisible in API responses — a very common gotcha.
     */
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────

/**
 * COMPOUND INDEX: owner + visibility
 *
 * The most common query pattern in a YouTube-like app:
 *   "Fetch all PUBLIC playlists of a channel" → filter by owner + visibility: "public"
 *   "Fetch all PRIVATE playlists of a user"  → filter by owner + visibility: "private"
 *
 * A compound index on (owner, visibility) covers both queries efficiently.
 * Without this, MongoDB does a COLLSCAN — full collection scan — which is catastrophic
 * at scale (imagine scanning 10M playlists to find 5 belonging to a user).
 *
 * Rule of thumb: Index the fields you filter/sort by most frequently, in the
 * order they appear in your query (equality fields first, range/sort fields last).
 */
playlistSchema.index({ owner: 1, visibility: 1 });

/**
 * INDEX: createdAt
 *
 * Used for sorting playlists by newest first — a standard feed pattern.
 * Without this, sorting is done in memory (very expensive for large collections).
 */
playlistSchema.index({ createdAt: -1 });

/**
 * INDEX: name (text index)
 *
 * Enables full-text search on playlist names via MongoDB's $text operator.
 * Example query: db.playlists.find({ $text: { $search: "gaming highlights" } })
 *
 * This is NOT the same as a regex search (which is slow). Text indexes
 * tokenize and stem words for efficient search.
 *
 * In production, you'd likely graduate to Elasticsearch or Atlas Search,
 * but $text is a solid starting point.
 */
playlistSchema.index({ name: "text", description: "text" });

// ─────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────

/**
 * VIRTUAL: videoCount
 *
 * Derived field — computed on the fly from the videos array length.
 * Never store this as a real field; it will go stale when videos are added/removed
 * unless you manually sync it everywhere (a maintenance nightmare).
 *
 * Virtuals are NOT persisted to MongoDB. They exist only in-memory when you
 * access a document. They appear in API responses only when toJSON.virtuals = true.
 */
playlistSchema.virtual("videoCount").get(function () {
  return this.videos?.length ?? 0;
});

/**
 * VIRTUAL: isPublic
 *
 * Convenience boolean — avoids string comparison in controller/view logic.
 * e.g., if (playlist.isPublic) { ... }  instead of  if (playlist.visibility === "public")
 */
playlistSchema.virtual("isPublic").get(function () {
  return this.visibility === "public";
});

// ─────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────

/**
 * addVideo(videoId)
 *
 * Adds a video to the playlist only if:
 *   1. It's not already in the list (prevents duplicates)
 *   2. The 500-video cap is not exceeded
 *
 * IMPORTANT: Always call .save() after this. The method mutates the document
 * in memory but does NOT persist to DB until save() is called.
 * This is intentional — gives the caller control over when to commit.
 */
playlistSchema.methods.addVideo = async function (videoId) {
  const videoObjectId = new mongoose.Types.ObjectId(videoId);

  // .some() with .equals() is correct for ObjectId comparison.
  // Never use == or === for ObjectIds — they are objects, not primitives.
  const alreadyExists = this.videos.some((id) => id.equals(videoObjectId));

  if (alreadyExists) {
    throw new Error("Video already exists in this playlist");
  }

  if (this.videos.length >= 500) {
    throw new Error("Playlist has reached the maximum limit of 500 videos");
  }

  this.videos.push(videoObjectId);
  return this.save();
};

/**
 * removeVideo(videoId)
 *
 * Filters out the video by ObjectId. Uses .equals() for correct comparison.
 *
 * Beginner mistake: arr.filter(id => id !== videoId)
 * This ALWAYS returns the full array unchanged because ObjectId !== string.
 * Always use .equals() or compare .toString() versions.
 */
playlistSchema.methods.removeVideo = async function (videoId) {
  const videoObjectId = new mongoose.Types.ObjectId(videoId);
  const initialLength = this.videos.length;

  this.videos = this.videos.filter((id) => !id.equals(videoObjectId));

  if (this.videos.length === initialLength) {
    throw new Error("Video not found in this playlist");
  }

  return this.save();
};

/**
 * toggleVisibility()
 *
 * Flips the playlist between public and private.
 * Useful for a single-action UI toggle button.
 *
 * NOTE: Authorization (is this user the owner? is it a channel?) must be
 * checked in the controller BEFORE calling this method.
 * Models should not contain auth logic — that violates separation of concerns.
 */
playlistSchema.methods.toggleVisibility = async function () {
  this.visibility = this.visibility === "public" ? "private" : "public";
  return this.save();
};

/**
 * isOwnedBy(userId)
 *
 * Ownership check helper. Returns boolean.
 * Use this in your controller before any mutation (add/remove/delete/update).
 *
 * Example in controller:
 *   if (!playlist.isOwnedBy(req.user._id)) throw new ApiError(403, "Forbidden")
 */
playlistSchema.methods.isOwnedBy = function (userId) {
  return this.owner.equals(new mongoose.Types.ObjectId(userId));
};

// ─────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────

/**
 * Static: getPublicPlaylistsByOwner(ownerId)
 *
 * Fetches all PUBLIC playlists for a given channel/user.
 * Uses .select() to return only fields needed for a listing view —
 * never return the full document (especially the videos array with 500 refs)
 * when you only need metadata for a list page.
 *
 * This is called "projection" — a core MongoDB performance technique.
 */
playlistSchema.statics.getPublicPlaylistsByOwner = async function (ownerId) {
  return this.find({ owner: ownerId, visibility: "public" })
    .select("name description thumbnail createdAt")
    .sort({ createdAt: -1 })
    .lean(); // .lean() returns plain JS objects instead of Mongoose Documents
  // Much faster for read-only operations — skips hydration overhead
};

/**
 * Static: getPrivatePlaylistsByOwner(ownerId)
 *
 * Fetches all PRIVATE playlists. Only the authenticated owner should trigger this.
 * Authorization guard belongs in the controller/middleware — not here.
 */
playlistSchema.statics.getPrivatePlaylistsByOwner = async function (ownerId) {
  return this.find({ owner: ownerId, visibility: "private" })
    .select("name description thumbnail createdAt")
    .sort({ createdAt: -1 })
    .lean();
};

/**
 * Static: getPlaylistWithVideos(playlistId)
 *
 * Fetches a single playlist and populates its video references.
 * Uses .populate() to replace ObjectId refs with actual Video documents.
 *
 * "path" = field to populate
 * "select" = which fields from the Video document to include
 *
 * CRITICAL: Never populate without a select in production.
 * Populating without select pulls the entire Video document for every video
 * in the playlist — that's potentially 500 full documents per request.
 * Select only what the UI actually needs.
 */
playlistSchema.statics.getPlaylistWithVideos = async function (playlistId) {
  return this.findById(playlistId).populate({
    path: "videos",
    select: "title thumbnail duration views createdAt owner",
    // You can chain nested populates if needed:
    // populate: { path: "owner", select: "username avatar" }
  });
};

// ─────────────────────────────────────────────
// MIDDLEWARE (pre/post hooks)
// ─────────────────────────────────────────────

/**
 * PRE-SAVE HOOK: Auto-set thumbnail from first video
 *
 * If no explicit thumbnail is set, this hook fires before every save
 * and sets a placeholder. In production, you'd resolve the actual
 * video's thumbnail URL here (requires a Video lookup or passing it in).
 *
 * Hooks are the Mongoose equivalent of database triggers.
 * Use them for cross-cutting concerns: audit logs, derived fields,
 * cascading updates. Do NOT put business logic here — keep hooks lean.
 *
 * "next()" must be called or the save operation hangs indefinitely.
 */
playlistSchema.pre("save", function (next) {
  // If thumbnail is missing and there are videos, flag for controller to resolve
  if (!this.thumbnail && this.videos.length > 0) {
    // Actual thumbnail resolution (fetching from Video collection) should be done
    // in the service/controller layer to avoid async complexity inside hooks.
    // Here we just leave it empty — controller decides.
  }
  next();
});

/**
 * PRE findOneAndDelete HOOK: Cleanup
 *
 * When a playlist is deleted, you may want to perform cleanup
 * (e.g., remove this playlist ref from User's savedPlaylists array).
 *
 * This is where you'd trigger that cascade. For now it's a placeholder
 * showing WHERE to put such logic — never scatter cleanup across controllers.
 */
playlistSchema.pre("findOneAndDelete", async function (next) {
  // const playlistId = this.getQuery()["_id"];
  // await User.updateMany({}, { $pull: { savedPlaylists: playlistId } });
  next();
});

export const Playlist = mongoose.model("Playlist", playlistSchema);
