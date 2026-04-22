import mongoose from "mongoose";
import { Playlist } from "../models/playlist.model.js";
import { PlaylistItem } from "../models/playlistItem.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  buildPaginationOptions,
  buildPaginationMeta,
} from "../utils/playlist/Buildpaginationoptions.js";
import {
  reorderPositions,
  REORDER_OPERATION,
} from "../utils/playlist/Reorderpositions.js";

// ─────────────────────────────────────────────
// CREATE PLAYLIST
// ─────────────────────────────────────────────

/**
 * POST /playlists
 * Auth: required (verifyJWT)
 *
 * Creates a new playlist owned by the authenticated user.
 * Visibility defaults to "private" at the model level.
 *
 * BEGINNER MISTAKE: passing req.body directly into the model constructor.
 *   new Playlist(req.body) → a malicious client sends { owner: someoneElsesId }
 *   and hijacks ownership. Always destructure only what you need.
 */
export const createPlaylist = asyncHandler(async (req, res) => {
  const { name, description, visibility } = req.body;

  if (!name?.trim()) {
    throw new ApiError(400, "Playlist name is required");
  }

  const playlist = await Playlist.create({
    name: name.trim(),
    description: description?.trim() || "",
    visibility: visibility || "private",
    owner: req.user._id, // ALWAYS from req.user, never from req.body
  });

  return res
    .status(201)
    .json(new ApiResponse(201, playlist, "Playlist created successfully"));
});

// ─────────────────────────────────────────────
// UPDATE PLAYLIST DETAILS
// ─────────────────────────────────────────────

/**
 * PATCH /playlists/:playlistId
 * Auth: verifyJWT + verifyOwnership
 *
 * Handles partial updates: name, description, visibility.
 * toggleVisibility is NOT a separate controller — it's just a PATCH
 * with { visibility: "public" } or { visibility: "private" }.
 * Clients can compute the toggle themselves.
 *
 * WHY PATCH AND NOT PUT?
 * PUT means "replace the entire resource". PATCH means "update specific fields".
 * You never want the client to send the entire playlist object just to change the name.
 * Use PATCH for partial updates — it's semantically correct and avoids
 * accidentally wiping fields the client didn't send.
 *
 * DYNAMIC $set CONSTRUCTION:
 * Only build the update object from fields that were actually sent.
 * If the client sends { name: "new name" } and omits description,
 * description should remain unchanged. This is why we check each field explicitly.
 */
export const updatePlaylistDetails = asyncHandler(async (req, res) => {
  const { playlistId } = req.params;
  const { name, description, visibility } = req.body;

  // Build update object dynamically — only include fields that were sent
  const updateFields = {};
  if (name !== undefined) updateFields.name = name.trim();
  if (description !== undefined) updateFields.description = description.trim();
  if (visibility !== undefined) updateFields.visibility = visibility;

  if (Object.keys(updateFields).length === 0) {
    throw new ApiError(400, "No valid fields provided for update");
  }

  const updated = await Playlist.findByIdAndUpdate(
    playlistId,
    { $set: updateFields },
    {
      new: true, // return the updated document, not the old one
      runValidators: true, // run schema validators on update — off by default in Mongoose
    },
  );

  if (!updated) {
    throw new ApiError(404, "Playlist not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, updated, "Playlist updated successfully"));
});

// ─────────────────────────────────────────────
// DELETE PLAYLIST
// ─────────────────────────────────────────────

/**
 * DELETE /playlists/:playlistId
 * Auth: verifyJWT + verifyOwnership
 *
 * Uses findOneAndDelete (not findByIdAndDelete) because the pre("findOneAndDelete")
 * hook on the Playlist model needs to fire to cascade-delete PlaylistItems.
 *
 * CRITICAL: findByIdAndDelete IS findOneAndDelete under the hood — both fire the hook.
 * But deleteOne() and deleteMany() do NOT fire findOneAndDelete hooks.
 * If you use deleteOne() here, PlaylistItems are never cleaned up.
 */
export const deletePlaylist = asyncHandler(async (req, res) => {
  const { playlistId } = req.params;

  const deleted = await Playlist.findOneAndDelete({ _id: playlistId });

  if (!deleted) {
    throw new ApiError(404, "Playlist not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Playlist deleted successfully"));
});

// ─────────────────────────────────────────────
// ADD VIDEO TO PLAYLIST
// ─────────────────────────────────────────────

/**
 * POST /playlists/:playlistId/videos
 * Auth: verifyJWT + verifyOwnership
 * Body: { videoId }
 *
 * WHAT HAPPENS:
 *   1. Get the next available position (MAX current position + 1)
 *   2. Create the PlaylistItem
 *   3. The post-save hook on PlaylistItem auto-updates playlist thumbnail if empty
 *
 * DUPLICATE HANDLING:
 * The unique index on (playlistId, videoId) in PlaylistItem will throw
 * error code 11000 if the same video is added twice.
 * We catch that specific code and return a clean 409 Conflict response.
 * Never let raw Mongoose errors reach the client.
 */
export const addVideoToPlaylist = asyncHandler(async (req, res) => {
  const { playlistId } = req.params;
  const { videoId } = req.body;

  if (!videoId) {
    throw new ApiError(400, "videoId is required");
  }

  if (!mongoose.Types.ObjectId.isValid(videoId)) {
    throw new ApiError(400, "Invalid videoId format");
  }

  // Get next position BEFORE creating the item
  const nextPosition = await PlaylistItem.getNextPosition(playlistId);

  try {
    const item = await PlaylistItem.create({
      playlistId,
      videoId,
      position: nextPosition,
    });

    return res
      .status(201)
      .json(new ApiResponse(201, item, "Video added to playlist"));
  } catch (error) {
    // MongoDB duplicate key error code
    if (error.code === 11000) {
      throw new ApiError(409, "This video is already in the playlist");
    }
    throw error;
  }
});

// ─────────────────────────────────────────────
// REMOVE VIDEO FROM PLAYLIST
// ─────────────────────────────────────────────

/**
 * DELETE /playlists/:playlistId/videos/:videoId
 * Auth: verifyJWT + verifyOwnership
 *
 * WHAT HAPPENS:
 *   1. Delete the PlaylistItem
 *   2. Shift all items after the removed position down by 1 (one bulk query)
 *
 * WHY STORE THE REMOVED POSITION BEFORE DELETING?
 * After deletion, the document is gone. We need the position value
 * to know which items to shift. Capture it from the deleted document.
 * findOneAndDelete returns the deleted document — use that.
 */
export const removeVideoFromPlaylist = asyncHandler(async (req, res) => {
  const { playlistId, videoId } = req.params;

  const deleted = await PlaylistItem.findOneAndDelete({ playlistId, videoId });

  if (!deleted) {
    throw new ApiError(404, "Video not found in this playlist");
  }

  // Shift everything after the deleted position down by 1
  await reorderPositions(REORDER_OPERATION.AFTER_REMOVE, {
    playlistId,
    removedPosition: deleted.position,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Video removed from playlist"));
});

// ─────────────────────────────────────────────
// REORDER VIDEOS IN PLAYLIST
// ─────────────────────────────────────────────

/**
 * PATCH /playlists/:playlistId/videos/reorder
 * Auth: verifyJWT + verifyOwnership
 * Body: { videoId, fromPosition, toPosition }
 *
 * WHY ACCEPT fromPosition FROM THE CLIENT?
 * You could query it from the DB, but the client already has it
 * (they rendered the list). Accepting it avoids an extra DB query.
 *
 * VALIDATE IT: if fromPosition doesn't match what's actually in the DB,
 * the client's list is stale (another device reordered simultaneously).
 * We verify it before committing the move.
 *
 * CONCURRENCY NOTE:
 * If two devices reorder the same playlist simultaneously,
 * the second write will be based on stale state. This is a last-write-wins
 * scenario. For a YouTube clone, this is acceptable — the UX edge case is rare.
 * If you needed strong consistency here (collaborative editing), you'd use
 * operational transforms or CRDTs — well beyond this scope.
 */
export const reorderPlaylistVideos = asyncHandler(async (req, res) => {
  const { playlistId } = req.params;
  const { videoId, fromPosition, toPosition } = req.body;

  if (!videoId || fromPosition === undefined || toPosition === undefined) {
    throw new ApiError(
      400,
      "videoId, fromPosition, and toPosition are required",
    );
  }

  if (fromPosition === toPosition) {
    return res
      .status(200)
      .json(new ApiResponse(200, null, "No change in position"));
  }

  if (fromPosition < 0 || toPosition < 0) {
    throw new ApiError(400, "Positions cannot be negative");
  }

  // Verify the fromPosition is accurate — client state might be stale
  const currentItem = await PlaylistItem.findOne({ playlistId, videoId })
    .select("position")
    .lean();

  if (!currentItem) {
    throw new ApiError(404, "Video not found in this playlist");
  }

  if (currentItem.position !== fromPosition) {
    throw new ApiError(
      409,
      "Playlist has changed since you last loaded it. Please refresh.",
    );
  }

  await reorderPositions(REORDER_OPERATION.MOVE, {
    playlistId,
    videoId,
    fromPosition,
    toPosition,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Playlist reordered successfully"));
});

// ─────────────────────────────────────────────
// GET PLAYLIST META (lightweight)
// ─────────────────────────────────────────────

/**
 * GET /playlists/:playlistId/meta
 * Auth: checkPlaylistVisibility (attaches req.playlist)
 *
 * Returns only metadata — no videos.
 * Used for: page title bar, share preview, "playlist info" panel.
 *
 * WHY SEPARATE FROM getPlaylistById?
 * getPlaylistById populates all videos (paginated but still a JOIN).
 * The meta endpoint is a single indexed lookup — sub-millisecond.
 * Use it when you don't need the video list yet (e.g., rendering the shell
 * of the page before lazy-loading the video list).
 *
 * req.playlist is already fetched by checkPlaylistVisibility middleware.
 * We extend it with videoCount and owner info.
 */
export const getPlaylistMeta = asyncHandler(async (req, res) => {
  const { playlistId } = req.params;

  // Fetch full metadata (middleware already verified visibility with a lean fetch)
  const playlist = await Playlist.findById(playlistId)
    .select("name description thumbnail visibility owner createdAt updatedAt")
    .populate("owner", "username avatar fullName")
    .lean();

  if (!playlist) {
    throw new ApiError(404, "Playlist not found");
  }

  const videoCount = await PlaylistItem.countDocuments({ playlistId });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { ...playlist, videoCount },
        "Playlist metadata fetched",
      ),
    );
});

// ─────────────────────────────────────────────
// GET PLAYLIST BY ID (with paginated videos)
// ─────────────────────────────────────────────

/**
 * GET /playlists/:playlistId
 * Auth: checkPlaylistVisibility
 *
 * Returns playlist metadata + paginated video list.
 * Videos are fetched from PlaylistItem, always sorted by position.
 *
 * WHY TWO SEPARATE QUERIES (playlist + items) INSTEAD OF AGGREGATE?
 * Readability and maintainability at this scale.
 * Two indexed queries are fast enough. If profiling shows this endpoint
 * is slow, move to a single aggregation pipeline.
 *
 * NEVER return all videos without pagination. A playlist with 500 videos
 * would serialize 500 populated documents in a single response.
 */
export const getPlaylistById = asyncHandler(async (req, res) => {
  const { playlistId } = req.params;

  const { page, limit, skip } = buildPaginationOptions(req.query, {
    defaultLimit: 20,
    defaultSortField: "position",
    defaultSortOrder: "asc",
  });

  const playlist = await Playlist.findById(playlistId)
    .select("name description thumbnail visibility owner createdAt")
    .populate("owner", "username avatar")
    .lean();

  if (!playlist) {
    throw new ApiError(404, "Playlist not found");
  }

  // Run count + items fetch in parallel — Promise.all cuts latency in half
  // (two sequential queries: 2x the wait; two parallel queries: 1x the wait)
  const [totalItems, items] = await Promise.all([
    PlaylistItem.countDocuments({ playlistId }),
    PlaylistItem.find({ playlistId })
      .sort({ position: 1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "videoId",
        select: "title thumbnail duration views owner createdAt",
        populate: { path: "owner", select: "username avatar" },
      })
      .lean(),
  ]);

  const pagination = buildPaginationMeta(totalItems, page, limit);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        playlist,
        items,
        pagination,
      },
      "Playlist fetched successfully",
    ),
  );
});

// ─────────────────────────────────────────────
// GET USER PLAYLISTS
// ─────────────────────────────────────────────

/**
 * GET /users/:userId/playlists
 * Auth: optional (verifyJWT runs but doesn't block)
 *
 * VISIBILITY LOGIC (done here, not in middleware — it's query-level filtering):
 *   - If viewer IS the owner: return public + private
 *   - If viewer is anyone else (or unauthenticated): return public only
 *
 * This replaces getPublicPlaylists as a separate controller —
 * it's the same endpoint, visibility is derived from auth context.
 *
 * AGGREGATION: uses getPublicPlaylistsWithCount static to get video counts
 * without N+1 queries. For the owner's own view (includes private),
 * we run the same aggregation with a different match.
 */
export const getUserPlaylists = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new ApiError(400, "Invalid userId");
  }

  const { page, limit, skip } = buildPaginationOptions(req.query);

  const isOwner = req.user && req.user._id.toString() === userId;

  // Build visibility filter
  const visibilityFilter = isOwner
    ? {} // owner sees everything
    : { visibility: "public" }; // others see public only

  const matchStage = {
    owner: new mongoose.Types.ObjectId(userId),
    ...visibilityFilter,
  };

  // Aggregation pipeline with pagination
  const [result] = await Playlist.aggregate([
    { $match: matchStage },
    {
      $facet: {
        // $facet runs multiple pipelines on the same dataset in one query
        // "data" pipeline: paginated results with video counts
        // "count" pipeline: total matching documents for pagination meta
        // Without $facet, you'd run two separate aggregate calls
        data: [
          {
            $lookup: {
              from: "playlistitems",
              localField: "_id",
              foreignField: "playlistId",
              as: "itemDocs",
            },
          },
          { $addFields: { videoCount: { $size: "$itemDocs" } } },
          { $project: { itemDocs: 0 } }, // drop the joined array, keep everything else
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
        ],
        count: [{ $count: "total" }],
      },
    },
  ]);

  const playlists = result.data;
  const total = result.count[0]?.total || 0;
  const pagination = buildPaginationMeta(total, page, limit);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { playlists, pagination },
        "User playlists fetched successfully",
      ),
    );
});

// ─────────────────────────────────────────────
// GET PLAYLIST VIDEOS (paginated, standalone)
// ─────────────────────────────────────────────

/**
 * GET /playlists/:playlistId/videos
 * Auth: checkPlaylistVisibility
 *
 * Standalone paginated video list — without re-fetching playlist metadata.
 * Used for infinite scroll / "load more" after the initial page load.
 * The client already has the metadata from getPlaylistById or getPlaylistMeta.
 *
 * This keeps subsequent page fetches lightweight — only videos, no metadata re-fetch.
 */
export const getPlaylistVideos = asyncHandler(async (req, res) => {
  const { playlistId } = req.params;

  const { page, limit, skip } = buildPaginationOptions(req.query, {
    defaultLimit: 20,
    defaultSortField: "position",
  });

  const [total, items] = await Promise.all([
    PlaylistItem.countDocuments({ playlistId }),
    PlaylistItem.find({ playlistId })
      .sort({ position: 1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "videoId",
        select: "title thumbnail duration views owner createdAt",
        populate: { path: "owner", select: "username avatar" },
      })
      .lean(),
  ]);

  const pagination = buildPaginationMeta(total, page, limit);

  return res
    .status(200)
    .json(
      new ApiResponse(200, { items, pagination }, "Playlist videos fetched"),
    );
});
