import mongoose, { Schema } from "mongoose";

/**
 * PLAYLISTITEM MODEL
 *
 * This is a junction/pivot collection — the same concept as a many-to-many
 * join table in SQL. One playlist has many videos, one video can be in many
 * playlists. PlaylistItem is the record that links them.
 *
 * SQL equivalent:
 *   CREATE TABLE playlist_items (
 *     id         UUID PRIMARY KEY,
 *     playlistId UUID REFERENCES playlists(id),
 *     videoId    UUID REFERENCES videos(id),
 *     position   INTEGER,
 *     addedAt    TIMESTAMP
 *   );
 *
 * WHY A SEPARATE COLLECTION (vs embedding in Playlist):
 *   1. No 16MB document size limit risk
 *   2. Efficient reordering — update one document's position field
 *   3. Paginate videos inside a playlist without loading all refs
 *   4. Query from the video side: "which playlists contain this video?"
 *   5. addedAt per item — impossible with a plain array of ObjectIds
 *   6. Deletions are targeted (deleteOne) vs rewriting the whole array
 */

const playlistItemSchema = new Schema(
  {
    /**
     * playlistId — FK → Playlist
     * Which playlist this item belongs to.
     */
    playlistId: {
      type: Schema.Types.ObjectId,
      ref: "Playlist",
      required: [true, "PlaylistItem must belong to a playlist"],
    },

    /**
     * videoId — FK → Video
     * Which video this item represents.
     */
    videoId: {
      type: Schema.Types.ObjectId,
      ref: "Video",
      required: [true, "PlaylistItem must reference a video"],
    },

    /**
     * position — ordering field
     *
     * This is how playlist ordering works in production.
     * It's a floating-point number on purpose.
     *
     * WHY FLOAT AND NOT INTEGER?
     * If you use integers (1, 2, 3, 4...) and want to move video from
     * position 5 to between position 2 and 3, you'd have to renumber
     * everything from position 3 onward. That's a multi-document write.
     *
     * With floats (lexorank / midpoint strategy):
     *   position 2 = 2.0, position 3 = 3.0
     *   insert between them → position = 2.5
     *   insert between 2.0 and 2.5 → position = 2.25
     * Only ONE document is written. This is how Trello, Notion, Jira do it.
     *
     * Eventually floats lose precision after many insertions. The fix is
     * to "rebalance" positions back to integers when the gap gets too small.
     * That's an async background job — not a user-facing operation.
     *
     * For a beginner project: start with integers and a reorder-all approach.
     * Graduate to this pattern when you need single-write reordering.
     */
    position: {
      type: Number,
      required: [true, "Position is required"],
      min: [0, "Position cannot be negative"],
    },

    /**
     * addedAt
     *
     * Separate from mongoose timestamps (createdAt/updatedAt).
     * This field semantically means "when was this video added to the playlist"
     * and is exposed to the user ("Added 3 days ago" on the UI).
     *
     * createdAt from timestamps would serve the same purpose, but having an
     * explicit field makes the intent clear and gives you flexibility to
     * set a custom value (e.g., data migrations).
     */
    addedAt: {
      type: Date,
      default: Date.now,
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

/**
 * UNIQUE COMPOUND INDEX: playlistId + videoId
 *
 * This is the most critical index in this model.
 * It does TWO things simultaneously:
 *   1. Performance: covers the most common query — "get all items in playlist X,
 *      sorted by position". Since position is a sort field (range), it goes last.
 *   2. Uniqueness: prevents the same video from being added to the same playlist twice.
 *      This is a DB-level constraint. Even if your controller has a duplicate check,
 *      this is your safety net against race conditions (two simultaneous requests
 *      both passing the check before either writes).
 *
 * Without this unique constraint, a race condition can insert duplicates:
 *   Request A: checks → no duplicate → [context switch] → Request B: checks → no duplicate
 *   → Request A writes → Request B writes → duplicate in DB
 *
 * The unique index makes one of those writes throw an E11000 error at the DB level.
 * Handle it in your controller (catch code 11000 → return "already in playlist").
 */
playlistItemSchema.index({ playlistId: 1, videoId: 1 }, { unique: true });

/**
 * INDEX: playlistId + position
 *
 * Used for: "get all videos in this playlist, ordered by position"
 * This is the core read query for displaying a playlist.
 * Without this, sorting by position requires an in-memory sort — expensive at scale.
 *
 * The (playlistId, videoId) unique index above already covers playlistId queries,
 * but does NOT help with position-based sorting. This separate index does.
 *
 * NOTE: In MongoDB, an index on (A, B) covers queries filtering by A alone,
 * or A + B together. It does NOT cover queries filtering by B alone.
 * So (playlistId, position) handles: filter by playlistId → sort by position. ✓
 */
playlistItemSchema.index({ playlistId: 1, position: 1 });

/**
 * INDEX: videoId
 *
 * Enables reverse lookup: "which playlists contain this video?"
 * Useful for:
 *   - "Save to playlist" UI (show which playlists already have this video checked)
 *   - When a video is deleted, find and remove all its PlaylistItem entries
 *
 * Without this index, that query scans the entire playlistItems collection.
 */
playlistItemSchema.index({ videoId: 1 });

// ─────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────

/**
 * Virtual populate: video
 *
 * When you call .populate("video") on a PlaylistItem document,
 * Mongoose fetches the referenced Video document.
 *
 * This is separate from the videoId field — videoId stores the raw ObjectId,
 * "video" virtual gives you the populated document when needed.
 */
playlistItemSchema.virtual("video", {
  ref: "Video",
  localField: "videoId",
  foreignField: "_id",
  justOne: true, // one video per item, not an array
});

// ─────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────

/**
 * getItemsByPlaylist(playlistId, options)
 *
 * Primary read query. Returns all items in a playlist sorted by position.
 * Populates videoId with selected video fields — never the full document.
 *
 * options.skip and options.limit enable PAGINATION.
 *
 * PAGINATION IN PRODUCTION:
 * A playlist can have hundreds of videos. Never return all of them in one response.
 * Use skip/limit for offset-based pagination:
 *   Page 1: skip=0, limit=20
 *   Page 2: skip=20, limit=20
 *
 * LIMITATION of offset pagination: if items are added/removed between page fetches,
 * pages shift. Cursor-based pagination (using position as cursor) is more stable.
 * For a beginner project, offset is fine.
 */
playlistItemSchema.statics.getItemsByPlaylist = async function (
  playlistId,
  { skip = 0, limit = 20 } = {},
) {
  return this.find({ playlistId })
    .sort({ position: 1 })
    .skip(skip)
    .limit(limit)
    .populate({
      path: "videoId",
      select: "title thumbnail duration views owner createdAt",
    })
    .lean();
};

/**
 * getNextPosition(playlistId)
 *
 * Finds the highest current position in a playlist and returns position + 1.
 * Used when adding a new video to the END of a playlist.
 *
 * HOW IT WORKS:
 *   Sort items by position descending → take the first result → add 1.
 *   If no items exist, return 0 (first item gets position 0).
 *
 * WHY NOT COUNT DOCUMENTS?
 *   countDocuments() returns 5 if there are 5 items. But if positions are
 *   [0, 1, 2, 10, 11] (after some deletions), the next position should be 12,
 *   not 5. Always derive next position from the MAX existing position.
 */
playlistItemSchema.statics.getNextPosition = async function (playlistId) {
  const lastItem = await this.findOne({ playlistId })
    .sort({ position: -1 })
    .select("position")
    .lean();

  return lastItem ? lastItem.position + 1 : 0;
};

/**
 * reorderItem(playlistId, videoId, newPosition)
 *
 * Moves a video to a new position within a playlist.
 * Uses a session + transaction to ensure atomicity.
 *
 * WHAT IS A TRANSACTION?
 * Multiple DB writes that must ALL succeed or ALL fail together.
 * Without a transaction:
 *   Step 1: shift existing items → succeeds
 *   Step 2: update moved item → DB crashes
 *   Result: corrupt ordering, some items shifted, moved item not updated.
 *
 * With a transaction: if step 2 fails, step 1 is rolled back automatically.
 * MongoDB requires a replica set (even a single-node replica set) for transactions.
 * In development, start mongod with --replSet rs0 and initialize.
 *
 * WHAT THIS DOES:
 *   1. Shift all items at newPosition or above up by 1 (make room)
 *   2. Set the target item to newPosition
 *
 * NOTE: This integer-shift approach requires updating multiple documents.
 * The float/midpoint approach (explained in the position field) avoids this.
 */
playlistItemSchema.statics.reorderItem = async function (
  playlistId,
  videoId,
  newPosition,
) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Step 1: Shift all items at or after newPosition up by 1
    await this.updateMany(
      { playlistId, position: { $gte: newPosition } },
      { $inc: { position: 1 } },
      { session },
    );

    // Step 2: Place the moved item at the target position
    await this.findOneAndUpdate(
      { playlistId, videoId },
      { position: newPosition },
      { session },
    );

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error; // Re-throw so controller can handle and respond with error
  } finally {
    session.endSession();
  }
};

/**
 * removeVideoFromPlaylist(playlistId, videoId)
 *
 * Deletes the PlaylistItem record. Does NOT touch the Video document.
 * Returns the deleted document so the controller can confirm deletion.
 */
playlistItemSchema.statics.removeVideoFromPlaylist = async function (
  playlistId,
  videoId,
) {
  const deleted = await this.findOneAndDelete({ playlistId, videoId });
  if (!deleted) {
    throw new Error("Video not found in this playlist");
  }
  return deleted;
};

/**
 * isVideoInPlaylist(playlistId, videoId)
 *
 * Existence check. Used in the "Save to Playlist" UI to show a checkmark
 * on playlists that already contain the video.
 *
 * Uses .exists() instead of .findOne() — it returns the _id or null,
 * does NOT load the full document. Faster for pure boolean checks.
 */
playlistItemSchema.statics.isVideoInPlaylist = async function (
  playlistId,
  videoId,
) {
  const exists = await this.exists({ playlistId, videoId });
  return !!exists;
};

// ─────────────────────────────────────────────
// HOOKS
// ─────────────────────────────────────────────

/**
 * POST save — Auto-update playlist thumbnail
 *
 * After a new PlaylistItem is saved (i.e., a video is added to a playlist),
 * check if the playlist has no thumbnail yet. If so, pull the thumbnail
 * from the newly added video and set it on the playlist.
 *
 * WHY POST-SAVE HERE AND NOT IN THE CONTROLLER?
 * This is a side effect of adding an item — it always needs to happen.
 * Putting it in a hook guarantees it runs regardless of which controller
 * path triggered the save. If you add videos from 3 different places
 * (API, admin panel, import tool), you'd have to duplicate this logic in each.
 * The hook centralizes it.
 *
 * this.videoId → the videoId saved on this PlaylistItem document.
 *
 * NOTE: Hooks run in the same process — avoid making them async-heavy.
 * If thumbnail resolution becomes complex, use a background job queue (Bull, BullMQ)
 * instead of blocking the save operation.
 */
playlistItemSchema.post("save", async function () {
  try {
    const Playlist = mongoose.model("Playlist");
    const Video = mongoose.model("Video");

    // Only update thumbnail if playlist doesn't have one yet
    const playlist = await Playlist.findById(this.playlistId).select(
      "thumbnail",
    );
    if (playlist && !playlist.thumbnail) {
      const video = await Video.findById(this.videoId).select("thumbnail");
      if (video?.thumbnail) {
        await Playlist.findByIdAndUpdate(this.playlistId, {
          thumbnail: video.thumbnail,
        });
      }
    }
  } catch {
    // Log but don't throw — thumbnail update failure should not break the add-video flow
    console.error(
      "PlaylistItem post-save: failed to update playlist thumbnail",
    );
  }
});

export const PlaylistItem = mongoose.model("PlaylistItem", playlistItemSchema);
