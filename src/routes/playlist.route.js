import { Router } from "express";
import {
  createPlaylist,
  updatePlaylistDetails,
  deletePlaylist,
  addVideoToPlaylist,
  removeVideoFromPlaylist,
  getPlaylistMeta,
  getUserPlaylists,
  getPlaylistVideos,
} from "../controllers/playlist.controller.js";
const router = Router();
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { checkPlaylistVisibility } from "../middlewares/Checkplaylistvisibility.middleware.js";

// Get all playlists of a user
router.get("/user/:userId", getUserPlaylists);

router.use(verifyJWT);

// Get playlist metadata (title, description, video count) without videos
router.get("/:playlistId/meta", checkPlaylistVisibility, getPlaylistMeta);

// Get videos in a playlist
router.get("/:playlistId/videos", checkPlaylistVisibility, getPlaylistVideos);

// Update playlist details (title, description, visibility)
router.patch("/:playlistId", updatePlaylistDetails);

// Delete a playlist
router.delete("/:playlistId", deletePlaylist);

// Add a video to a playlist
router.post("/:playlistId/videos", addVideoToPlaylist);

// Remove a video from a playlist
router.delete("/:playlistId/videos/:videoId", removeVideoFromPlaylist);

// Create a new playlist
router.post("/", createPlaylist);
export default router;
