// routes/like.routes.js

import { Router } from "express";
import {
  toggleVideoLike,
  toggleCommentLike,
  toggleTweetLike,
  getLikedVideos,
  getLikeCount,
  checkUserLiked,
} from "../controllers/like.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

// Every like route requires authentication — applied once at router level
// Beginner mistake: applying verifyJWT individually on each route and missing some
// router.use() applies the middleware to ALL routes registered below this line
router.use(verifyJWT);

// POST because you're changing server state (creating or deleting a like)
// Beginners use GET for toggle — GET must be idempotent and side-effect free
router.post("/video/:videoId", toggleVideoLike);
router.post("/comment/:commentId", toggleCommentLike);
router.post("/tweet/:tweetId", toggleTweetLike);

// GET because you're only reading data
router.get("/videos", getLikedVideos);          // /likes/videos
router.get("/count", getLikeCount);             // /likes/count?targetId=&targetType=
router.get("/check", checkUserLiked);           // /likes/check?targetId=&targetType=

export default router;