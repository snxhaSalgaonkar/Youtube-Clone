import mongoose, { Schema } from "mongoose";

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

    visibility: {
      type: String,
      enum: {
        values: ["public", "private"],
        message: "Visibility must be either 'public' or 'private'",
      },
      default: "private",
    },

    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Playlist must have an owner"],
      index: true,
    },

    thumbnail: {
      type: String,
      default: "",
      trim: true,
      /**
       * PRODUCTION NOTE:
       * In the embedded-array model, thumbnail could be derived from videos[0].
       * Now that videos live in PlaylistItem, the controller must explicitly set
       * this field when the first item is added (query PlaylistItem → get video
       * thumbnail → update playlist.thumbnail).
       *
       * Or use a post-save hook on PlaylistItem to update this automatically.
       * That hook lives in playlistItem.model.js — see that file.
       */
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ─────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────

// Compound: covers "all public playlists by this user" and "all playlists by this user"
playlistSchema.index({ owner: 1, visibility: 1 });

// Sort by newest first on listing pages
playlistSchema.index({ createdAt: -1 });

// Full-text search on name + description
playlistSchema.index({ name: "text", description: "text" });

// ─────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────

/**
 * isPublic — convenience boolean, unchanged
 */
playlistSchema.virtual("isPublic").get(function () {
  return this.visibility === "public";
});

/**
 * items — Virtual populate
 *
 * This is Mongoose's "virtual populate" feature — it behaves like a JOIN.
 * It does NOT embed items into the document. It tells Mongoose:
 * "When someone calls .populate('items') on a Playlist document,
 *  go look in the PlaylistItem collection for docs where playlistId === this._id"
 *
 * HOW IT WORKS:
 *   ref         → which model to query
 *   localField  → field on THIS document (_id)
 *   foreignField→ field on PlaylistItem that must match (_id → playlistId)
 *   options     → sort by position so videos always come back in correct order
 *
 * USAGE IN CONTROLLER:
 *   const playlist = await Playlist.findById(id).populate("items");
 *   // playlist.items is now an array of PlaylistItem documents (with video refs)
 *
 * WHY NOT JUST QUERY PlaylistItem DIRECTLY?
 *   You can — and sometimes should (e.g., paginated fetches).
 *   Virtual populate is for convenience when you need the full playlist + items
 *   in a single expression. For paginated video lists inside a playlist,
 *   query PlaylistItem directly with skip/limit.
 */
playlistSchema.virtual("items", {
  ref: "PlaylistItem",
  localField: "_id",
  foreignField: "playlistId",
  options: { sort: { position: 1 } }, // always return in correct order
});

// ─────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────

/**
 * toggleVisibility() — unchanged logic, still valid
 */
playlistSchema.methods.toggleVisibility = async function () {
  this.visibility = this.visibility === "public" ? "private" : "public";
  return this.save();
};

/**
 * isOwnedBy(userId) — unchanged, still valid
 */
playlistSchema.methods.isOwnedBy = function (userId) {
  return this.owner.equals(new mongoose.Types.ObjectId(userId));
};

/**
 * getVideoCount()
 *
 * NEW METHOD replacing the old videoCount virtual.
 *
 * Since videos no longer live in this document, we can't derive the count
 * from an array length. We must hit the PlaylistItem collection.
 *
 * countDocuments() is an indexed count — it doesn't load documents into memory.
 * As long as PlaylistItem has an index on playlistId (it does), this is O(log n).
 *
 * WHY NOT A VIRTUAL?
 * Virtuals are synchronous getters. DB calls are async. You cannot await inside
 * a virtual getter — it would return a Promise object, not a number.
 * So this is an async instance method instead.
 *
 * USAGE:
 *   const count = await playlist.getVideoCount();
 */
playlistSchema.methods.getVideoCount = async function () {
  const PlaylistItem = mongoose.model("PlaylistItem");
  return PlaylistItem.countDocuments({ playlistId: this._id });
};

// ─────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────

/**
 * getPublicPlaylistsByOwner(ownerId)
 *
 * Returns metadata only — no items, no video refs.
 * To get video count per playlist on a listing page, use aggregation
 * (see getPublicPlaylistsWithCount below) — don't make N+1 calls.
 */
playlistSchema.statics.getPublicPlaylistsByOwner = async function (ownerId) {
  return this.find({ owner: ownerId, visibility: "public" })
    .select("name description thumbnail createdAt")
    .sort({ createdAt: -1 })
    .lean();
};

/**
 * getPrivatePlaylistsByOwner(ownerId)
 */
playlistSchema.statics.getPrivatePlaylistsByOwner = async function (ownerId) {
  return this.find({ owner: ownerId, visibility: "private" })
    .select("name description thumbnail createdAt")
    .sort({ createdAt: -1 })
    .lean();
};

/**
 * getPublicPlaylistsWithCount(ownerId)
 *
 * Uses MongoDB Aggregation Pipeline to fetch playlists + their video counts
 * in a SINGLE database round-trip.
 *
 * WHY AGGREGATION?
 * The naive approach: fetch playlists, then for each playlist call
 * PlaylistItem.countDocuments(). If a user has 50 playlists, that's
 * 51 DB queries — called the N+1 problem. It kills performance.
 *
 * HOW THIS PIPELINE WORKS:
 *   $match     → filter to this owner's public playlists (uses index)
 *   $lookup    → LEFT JOIN with playlistItems collection on _id = playlistId
 *                (like SQL: SELECT * FROM playlists LEFT JOIN playlistItems ON ...)
 *   $addFields → compute videoCount from the joined array's size
 *   $project   → return only the fields needed, drop the joined array from response
 *   $sort      → newest first
 *
 * USAGE:
 *   const playlists = await Playlist.getPublicPlaylistsWithCount(userId);
 *   // Each object has: name, description, thumbnail, createdAt, videoCount
 */
playlistSchema.statics.getPublicPlaylistsWithCount = async function (ownerId) {
  return this.aggregate([
    {
      $match: {
        owner: new mongoose.Types.ObjectId(ownerId),
        visibility: "public",
      },
    },
    {
      $lookup: {
        from: "playlistitems", // MongoDB collection name (auto-lowercased + pluralized)
        localField: "_id",
        foreignField: "playlistId",
        as: "itemDocs",
      },
    },
    {
      $addFields: {
        videoCount: { $size: "$itemDocs" },
      },
    },
    {
      $project: {
        name: 1,
        description: 1,
        thumbnail: 1,
        createdAt: 1,
        videoCount: 1,
      },
    },
    { $sort: { createdAt: -1 } },
  ]);
};

// ─────────────────────────────────────────────
// HOOKS
// ─────────────────────────────────────────────

/**
 * PRE findOneAndDelete — Cascade delete PlaylistItems
 *
 * CRITICAL: When a playlist is deleted, all its PlaylistItem rows MUST be deleted too.
 * MongoDB has no foreign key constraints — orphaned PlaylistItem documents
 * will pile up silently and waste storage/corrupt future counts.
 *
 * This hook fires before findOneAndDelete() runs.
 * this.getQuery()["_id"] gives you the playlist ID being deleted.
 *
 * IMPORTANT: This does NOT fire for deleteMany() or Model.remove().
 * If you ever bulk-delete playlists (e.g., when a user account is deleted),
 * you must handle PlaylistItem cleanup separately in that operation.
 */
playlistSchema.pre("findOneAndDelete", async function (next) {
  const playlistId = this.getQuery()["_id"];
  const PlaylistItem = mongoose.model("PlaylistItem");
  await PlaylistItem.deleteMany({ playlistId });
  next();
});

export const Playlist = mongoose.model("Playlist", playlistSchema);
