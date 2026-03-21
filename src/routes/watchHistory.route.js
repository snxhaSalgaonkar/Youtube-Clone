import { Router } from "express";
import {
  saveOrUpdateWatchHistory,
  getWatchHistory,
  deleteWatchHistoryEntry,
  clearWatchHistory,
  getContinueWatching,
  checkVideoWatched,
  getUserAnalytics,
  getTopWatchedVideos,
} from "../controllers/watchHistory.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { isAdmin } from "../middlewares/admin.middleware.js";

const router = Router();

router.use(verifyJWT); // applies to ALL routes below

router.post("/", saveOrUpdateWatchHistory);
router.get("/", getWatchHistory);
router.delete("/clear", clearWatchHistory);           // must be before /:videoId
router.get("/continue-watching", getContinueWatching);
router.get("/analytics/me", getUserAnalytics);
router.get("/analytics/top", isAdmin, getTopWatchedVideos); // admin only
router.get("/:videoId", checkVideoWatched);
router.delete("/:videoId", deleteWatchHistoryEntry);

export default router;