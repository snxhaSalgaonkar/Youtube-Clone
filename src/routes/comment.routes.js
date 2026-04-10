import { Router } from "express";
import {
  addComment,
  updateComment,
  deleteComment,
  getVideoComments,
  getReplies,
  getCommentById,
  likeComment,
  getUserComments,
  deleteCommentByAdmin,
} from "../controllers/comment.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import {
  verifyCommentOwnership,
  verifyAdmin,
} from "../middlewares/Verifycommentownership .middleware.js";

const router = Router();

// --- Public routes ---
router.get("/video/:videoId", getVideoComments);
router.get("/:commentId/replies", getReplies);
router.get("/:commentId", getCommentById);

// All routes below require a valid JWT
router.use(verifyJWT);

router.post("/video/:videoId", addComment);
router.get("/user/:userId", getUserComments);
router.post("/:commentId/like", likeComment);

// Owner-only
router.patch("/:commentId", verifyCommentOwnership, updateComment);
router.delete("/:commentId", verifyCommentOwnership, deleteComment);

// Admin-only
router.delete("/admin/:commentId", verifyAdmin, deleteCommentByAdmin);

export default router;
