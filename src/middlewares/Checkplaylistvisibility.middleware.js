import { Playlist } from "../models/playlist.model.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/**
 * VISIBILITY CHECK MIDDLEWARE
 *
 * Sits between verifyJWT (optional) and the controller on any route
 * that serves playlist data to potentially unauthenticated users.
 *
 * FLOW:
 *   1. Fetch the playlist (lightweight — only _id, owner, visibility)
 *   2. If public → let everyone through
 *   3. If private → only the owner gets through, everyone else gets 403
 *
 * WHY FETCH HERE AND NOT IN THE CONTROLLER?
 * Because the controller would have to fetch it again anyway.
 * We attach the fetched playlist to req.playlist so the controller
 * can reuse it without a second DB hit. This is called the
 * "attach and pass" pattern — middleware does the fetch, controller uses it.
 *
 * WHY 403 AND NOT 404 FOR PRIVATE PLAYLISTS?
 * Returning 404 for a private playlist leaks information —
 * it tells the caller "this playlist exists but you can't see it"
 * (because if it truly didn't exist, you'd get 404).
 * 403 is the honest response: "you don't have permission".
 * Some APIs intentionally return 404 to prevent enumeration attacks.
 * For a YouTube clone, 403 is fine and more debuggable.
 *
 * IMPORTANT: verifyJWT must run BEFORE this middleware on protected routes.
 * On public-facing routes (channel page), verifyJWT should run optionally —
 * meaning it sets req.user if a token is present but doesn't block if absent.
 * This middleware then uses req.user?.id to check ownership.
 */
export const checkPlaylistVisibility = asyncHandler(async (req, res, next) => {
  const { playlistId } = req.params;

  if (!playlistId) {
    throw new ApiError(400, "Playlist ID is required");
  }

  const playlist = await Playlist.findById(playlistId)
    .select("_id owner visibility")
    .lean();

  if (!playlist) {
    throw new ApiError(404, "Playlist not found");
  }

  // Public playlists: everyone through, no further checks
  if (playlist.visibility === "public") {
    req.playlist = playlist; // attach for controller reuse
    return next();
  }

  // Private playlist from here — must be authenticated and must be the owner
  if (!req.user) {
    throw new ApiError(
      403,
      "This playlist is private. Authentication required.",
    );
  }

  const isOwner = playlist.owner.equals(req.user._id);
  if (!isOwner) {
    throw new ApiError(403, "This playlist is private.");
  }

  req.playlist = playlist;
  next();
});
