// controllers/like.controller.js

import mongoose from "mongoose";
import { Like } from "../models/likes.model.js";
import { Video } from "../models/video.model.js";
import { Comment } from "../models/comment.model.js";
//import { Tweet } from "../models/tweet.model.js";
import { buildLikeQuery } from "../utils/buildLikeQuery.js";

// ─── HELPER ────────────────────────────────────────────────────────────────────
// Maps targetType string to the actual Mongoose model
// Beginners hardcode model names in every controller — don't do that
const modelMap = {
  Video: Video,
  Comment: Comment,
  //Tweet: Tweet,
};

// Validates that the referenced document actually exists in its collection
// MongoDB has NO foreign key constraints — this is YOUR job
const validateTarget = async (targetType, targetId) => {
  const Model = modelMap[targetType];
  if (!Model) return false;

  // findById returns null if not found — existence check only, no data fetch
  const doc = await Model.findById(targetId).select("_id").lean();
  return !!doc;
};

// ─── TOGGLE LIKE ON VIDEO ──────────────────────────────────────────────────────
// Problem beginners face: They do find() → check → insert separately
// This is a RACE CONDITION. Two simultaneous requests both pass the check
// and both insert, creating duplicate likes.
// Solution: findOneAndDelete is atomic. One DB round-trip. No race window.

const toggleVideoLike = async (req, res) => {
  const { videoId } = req.params;
  const userId = req.user._id; // injected by verifyJWT middleware

  // Step 1: Validate ObjectId format before hitting the DB
  // Beginners skip this — MongoDB throws a CastError if the ID is malformed
  // and your server crashes with a 500 instead of returning a clean 400
  if (!mongoose.Types.ObjectId.isValid(videoId)) {
    return res.status(400).json({ message: "Invalid video ID" });
  }

  // Step 2: Confirm the video actually exists
  // Without this, likes accumulate against ghost documents silently
  const exists = await validateTarget("Video", videoId);
  if (!exists) {
    return res.status(404).json({ message: "Video not found" });
  }

  const query = buildLikeQuery(userId, videoId, "Video");

  // Step 3: Atomic toggle
  // findOneAndDelete returns the deleted document if it existed, null if not
  // If it returns null → no like existed → create one
  // If it returns a doc → like existed → it's now deleted (unliked)
  const existingLike = await Like.findOneAndDelete(query);

  if (existingLike) {
    // Was liked → now unliked
    await Video.findByIdAndUpdate(videoId, { $inc: { likeCount: -1 } });
    return res.status(200).json({ liked: false, message: "Video unliked" });
  }

  // Was not liked → create like
  await Like.create(query);
  await Video.findByIdAndUpdate(videoId, { $inc: { likeCount: 1 } });
  return res.status(201).json({ liked: true, message: "Video liked" });
};

// ─── TOGGLE LIKE ON COMMENT ────────────────────────────────────────────────────
// Exact same pattern as video. The only difference is targetType and param name.
// Beginners copy-paste and forget to change targetType — bugs that are hard to trace

const toggleCommentLike = async (req, res) => {
  const { commentId } = req.params;
  const userId = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(commentId)) {
    return res.status(400).json({ message: "Invalid comment ID" });
  }

  const exists = await validateTarget("Comment", commentId);
  if (!exists) {
    await Video.findByIdAndUpdate(commentId, { $inc: { likeCount: -1 } });
    return res.status(404).json({ message: "Comment not found" });
  }

  const query = buildLikeQuery(userId, commentId, "Comment");
  const existingLike = await Like.findOneAndDelete(query);

  if (existingLike) {
    return res.status(200).json({ liked: false, message: "Comment unliked" });
  }

  await Like.create(query);
  await Video.findByIdAndUpdate(commentId, { $inc: { likeCount: 1 } });
  return res.status(201).json({ liked: true, message: "Comment liked" });
};

// ─── TOGGLE LIKE ON TWEET ──────────────────────────────────────────────────────

const toggleTweetLike = async (req, res) => {
  const { tweetId } = req.params;
  const userId = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(tweetId)) {
    return res.status(400).json({ message: "Invalid tweet ID" });
  }

  const exists = await validateTarget("Tweet", tweetId);
  if (!exists) {
    await Video.findByIdAndUpdate(tweetId, { $inc: { likeCount: -1 } });
    return res.status(404).json({ message: "Tweet not found" });
  }

  const query = buildLikeQuery(userId, tweetId, "Tweet");
  const existingLike = await Like.findOneAndDelete(query);

  if (existingLike) {
    return res.status(200).json({ liked: false, message: "Tweet unliked" });
  }

  await Like.create(query);
  await Video.findByIdAndUpdate(tweetId, { $inc: { likeCount: -1 } });
  return res.status(201).json({ liked: true, message: "Tweet liked" });
};

// ─── GET ALL LIKED VIDEOS BY USER ─────────────────────────────────────────────
// Beginner mistake: They fetch all likes then do a second query per video in a loop
// This is called the N+1 query problem.
// If a user liked 200 videos → 1 query to get likes + 200 queries to get video data
// = 201 DB round-trips. This kills performance at scale.
// Solution: Use MongoDB aggregation with $lookup to JOIN in a single DB operation

const getLikedVideos = async (req, res) => {
  const userId = req.user._id;

  // Aggregation pipeline — runs entirely inside MongoDB, not in Node
  const likedVideos = await Like.aggregate([
    // Stage 1: Filter only this user's video likes
    {
      $match: {
        likedBy: new mongoose.Types.ObjectId(userId),
        targetType: "Video",
      },
    },

    // Stage 2: JOIN with the videos collection
    // localField: the field in likes collection
    // foreignField: the field in videos collection to match against
    // as: name of the array field added to each like document
    {
      $lookup: {
        from: "videos", // MongoDB collection name (lowercase plural)
        localField: "targetId",
        foreignField: "_id",
        as: "videoDetails",
      },
    },

    // Stage 3: $lookup always returns an array — unwind flattens it to an object
    // If the video was deleted, videoDetails is empty → document is removed here
    {
      $unwind: "$videoDetails",
    },

    // Stage 4: Shape the response — only return what the frontend needs
    // Beginners return the entire document including internal fields
    // In production you never expose raw DB documents directly
    {
      $project: {
        _id: 0,
        videoId: "$videoDetails._id",
        title: "$videoDetails.title",
        thumbnail: "$videoDetails.thumbnail",
        duration: "$videoDetails.duration",
        likedAt: "$createdAt",
      },
    },
  ]);

  return res.status(200).json({ likedVideos });
};

// ─── GET LIKE COUNT FOR A TARGET ───────────────────────────────────────────────
// Beginner mistake: Like.find({ targetId }).then(likes => likes.length)
// This loads EVERY like document into Node memory just to count them
// On popular content this is a massive memory and performance issue
// countDocuments runs the count inside MongoDB — zero data transfer

const getLikeCount = async (req, res) => {
  const { targetId, targetType } = req.query;

  if (!["Video", "Comment", "Tweet"].includes(targetType)) {
    return res.status(400).json({ message: "Invalid targetType" });
  }

  if (!mongoose.Types.ObjectId.isValid(targetId)) {
    return res.status(400).json({ message: "Invalid targetId" });
  }

  const count = await Like.countDocuments({ targetId, targetType });

  return res.status(200).json({ targetId, targetType, count });
};

// ─── CHECK IF CURRENT USER LIKED A TARGET ─────────────────────────────────────
// Used by the frontend to decide whether to show a filled or empty like button
// Beginners fetch the full document — you only need to know if it EXISTS
// exists() is more efficient than findOne() — stops as soon as it finds one match

const checkUserLiked = async (req, res) => {
  const { targetId, targetType } = req.query;
  const userId = req.user._id;

  if (!["Video", "Comment", "Tweet"].includes(targetType)) {
    return res.status(400).json({ message: "Invalid targetType" });
  }

  if (!mongoose.Types.ObjectId.isValid(targetId)) {
    return res.status(400).json({ message: "Invalid targetId" });
  }

  // exists() returns true/false — no document data transferred
  const liked = await Like.exists(buildLikeQuery(userId, targetId, targetType));

  return res.status(200).json({ liked: !!liked });
};

export {
  toggleVideoLike,
  toggleCommentLike,
  toggleTweetLike,
  getLikedVideos,
  getLikeCount,
  checkUserLiked,
};
