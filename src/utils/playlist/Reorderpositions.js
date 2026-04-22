import mongoose from "mongoose";
import { PlaylistItem } from "../../models/playlistItem.model.js";
import { ApiError } from "../../utils/ApiError.js";

/**
 * reorderPositions
 *
 * This is the most critical utility in the playlist system.
 * Every position management operation routes through here.
 *
 * ─────────────────────────────────────────────────────────
 * THE CORE PROBLEM (what beginners get wrong)
 * ─────────────────────────────────────────────────────────
 *
 * You have a playlist with 10 videos at positions 0–9.
 * User removes the video at position 3.
 *
 * WRONG approach (what beginners do):
 *   Loop through items 4–9, call findByIdAndUpdate() on each.
 *   That's 6 separate DB queries. For a 100-video playlist: 99 queries.
 *   For 1000 concurrent users doing this: catastrophic.
 *
 * CORRECT approach:
 *   ONE bulk write: updateMany({ position: { $gt: 3 } }, { $inc: { position: -1 } })
 *   One query. Doesn't matter if 6 items shift or 600.
 *
 * ─────────────────────────────────────────────────────────
 * THE SWAP PROBLEM (what even experienced beginners miss)
 * ─────────────────────────────────────────────────────────
 *
 * User moves item from position 2 to position 5.
 *
 * WRONG approach: set item A to 5, set item B to 2.
 * Problem: after step 1, TWO items have position 5.
 * If your unique index was on (playlistId, position) — this throws.
 * Even without a unique constraint, your sort order is undefined during the write.
 *
 * CORRECT approach: use a TRANSACTION and shift the range in bulk FIRST,
 * then place the moved item. The item never shares a position with another
 * at any point in time.
 *
 * ─────────────────────────────────────────────────────────
 * OPERATIONS HANDLED
 * ─────────────────────────────────────────────────────────
 *
 * 1. AFTER_REMOVE  — called after a video is removed from a playlist.
 *                    Shifts everything after the removed position down by 1.
 *
 * 2. MOVE          — called when user reorders (drags video from pos A to pos B).
 *                    Handles the range shift + placement in one transaction.
 *
 * 3. FULL_RESET    — called when positions have drifted (gap after many removes).
 *                    Resequences all items back to 0, 1, 2... using bulkWrite.
 *                    Use this as a repair tool, not a routine operation.
 */

export const REORDER_OPERATION = Object.freeze({
  AFTER_REMOVE: "AFTER_REMOVE",
  MOVE: "MOVE",
  FULL_RESET: "FULL_RESET",
});

/**
 * reorderPositions(operation, payload)
 *
 * @param {string} operation - one of REORDER_OPERATION values
 * @param {object} payload   - operation-specific data (documented per case)
 */
export const reorderPositions = async (operation, payload) => {
  switch (operation) {
    case REORDER_OPERATION.AFTER_REMOVE:
      return _shiftDownAfterRemove(payload);

    case REORDER_OPERATION.MOVE:
      return _moveItem(payload);

    case REORDER_OPERATION.FULL_RESET:
      return _fullReset(payload);

    default:
      throw new ApiError(400, `Unknown reorder operation: ${operation}`);
  }
};

// ─────────────────────────────────────────────
// INTERNAL HANDLERS
// ─────────────────────────────────────────────

/**
 * _shiftDownAfterRemove
 *
 * After removing the item at `removedPosition`, shift everything
 * at a HIGHER position down by 1.
 *
 * Example: remove position 3 from [0,1,2,3,4,5,6]
 * Result: [0,1,2,3,4,5] ← positions 4,5,6 became 3,4,5
 *
 * $gt: removedPosition  → only items AFTER the removed one
 * $inc: { position: -1 } → decrement by 1
 *
 * ONE query. Atomic per document (MongoDB guarantees this for updateMany).
 *
 * @param {{ playlistId: string, removedPosition: number }} payload
 */
const _shiftDownAfterRemove = async ({ playlistId, removedPosition }) => {
  if (removedPosition === undefined || removedPosition === null) {
    throw new ApiError(400, "removedPosition is required for AFTER_REMOVE");
  }

  await PlaylistItem.updateMany(
    {
      playlistId,
      position: { $gt: removedPosition },
    },
    {
      $inc: { position: -1 },
    },
  );
};

/**
 * _moveItem
 *
 * Moves an item from `fromPosition` to `toPosition`.
 * Everything between shifts by 1 in the opposite direction.
 *
 * MOVING DOWN (from 2 to 5): [0,1,2,3,4,5,6,7]
 *   Items at positions 3,4,5 shift UP by -1 → become 2,3,4
 *   Item at position 2 goes to 5
 *   Result: [0,1,2,3,4,5,6,7] — same count, different order
 *
 * MOVING UP (from 5 to 2): [0,1,2,3,4,5,6,7]
 *   Items at positions 2,3,4 shift DOWN by +1 → become 3,4,5
 *   Item at position 5 goes to 2
 *   Result: [0,1,2,3,4,5,6,7] — same count, different order
 *
 * TRANSACTION IS MANDATORY HERE.
 * Without it: after the bulk shift, the target item still has its old position.
 * For a brief moment, positions are inconsistent.
 * If the second write fails, you're left with a permanently broken order.
 *
 * MongoDB requires a replica set for transactions.
 * In local dev: mongod --replSet rs0
 * In production (Atlas): replica sets are always on.
 *
 * @param {{ playlistId: string, videoId: string, fromPosition: number, toPosition: number }} payload
 */
const _moveItem = async ({ playlistId, videoId, fromPosition, toPosition }) => {
  if (fromPosition === toPosition) return; // no-op, don't waste a DB round-trip

  if (
    fromPosition === undefined ||
    toPosition === undefined ||
    !playlistId ||
    !videoId
  ) {
    throw new ApiError(
      400,
      "playlistId, videoId, fromPosition, toPosition are all required for MOVE",
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const movingDown = toPosition > fromPosition;

    if (movingDown) {
      // Items between from+1 and toPosition shift up (-1)
      // "Moving down in the list" means others in that range move up
      await PlaylistItem.updateMany(
        {
          playlistId,
          position: { $gt: fromPosition, $lte: toPosition },
        },
        { $inc: { position: -1 } },
        { session },
      );
    } else {
      // Items between toPosition and from-1 shift down (+1)
      await PlaylistItem.updateMany(
        {
          playlistId,
          position: { $gte: toPosition, $lt: fromPosition },
        },
        { $inc: { position: 1 } },
        { session },
      );
    }

    // Place the moved item at its target position
    const updated = await PlaylistItem.findOneAndUpdate(
      { playlistId, videoId },
      { position: toPosition },
      { session, new: true },
    );

    if (!updated) {
      throw new ApiError(404, "Video not found in this playlist");
    }

    await session.commitTransaction();
    return updated;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    // ALWAYS end the session — if you skip this, MongoDB leaks the session
    // handle and you'll eventually hit the server's session limit
    session.endSession();
  }
};

/**
 * _fullReset
 *
 * Resequences ALL positions in a playlist back to 0, 1, 2, 3...
 * Use this as a repair/maintenance tool — not on every operation.
 *
 * HOW IT WORKS:
 *   1. Fetch all items sorted by current position (ASC)
 *   2. Build a bulkWrite array: each item gets a new sequential position
 *   3. Execute all writes in one bulkWrite call
 *
 * WHAT IS bulkWrite?
 * A MongoDB operation that sends multiple write operations in a single
 * network round-trip. Instead of 100 separate updateOne() calls (100 round-trips),
 * you send one bulkWrite with 100 operations (1 round-trip).
 * For N items: O(1) round-trips instead of O(N).
 *
 * WHEN TO USE THIS:
 *   - After a data migration
 *   - After discovering position drift in your DB
 *   - As a scheduled repair job (cron, once a day)
 *   NOT as a response to normal add/remove operations.
 *
 * @param {{ playlistId: string }} payload
 */
const _fullReset = async ({ playlistId }) => {
  if (!playlistId) {
    throw new ApiError(400, "playlistId is required for FULL_RESET");
  }

  const items = await PlaylistItem.find({ playlistId })
    .sort({ position: 1 })
    .select("_id")
    .lean();

  if (items.length === 0) return;

  // Build bulk operations: assign position = index for each item
  const bulkOps = items.map((item, index) => ({
    updateOne: {
      filter: { _id: item._id },
      update: { $set: { position: index } },
    },
  }));

  await PlaylistItem.bulkWrite(bulkOps, {
    // ordered: false means all operations run even if one fails
    // ordered: true (default) stops at the first failure
    // For a reset, we want all to run — partial reset is better than none
    ordered: false,
  });
};
