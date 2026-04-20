import mongoose from "mongoose";
import { Subscription } from "../models/subscription.model.js";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { triggerNotification } from "../utils/triggerNotification.js";

// ─────────────────────────────────────────────
// TOGGLE SUBSCRIPTION (Subscribe / Unsubscribe)
// ─────────────────────────────────────────────
/*
  HOW IT WORKS IN PRODUCTION:
  - We use findOneAndDelete for unsubscribe — atomic, no race condition.
  - We use create() for subscribe — the compound unique index on {subscriber, channel}
    acts as the last-line guard against duplicate subscriptions even under concurrent requests.
  - After every toggle, we update BOTH User documents' counts using $inc.
    $inc is atomic at the document level in MongoDB — safe to use without transactions
    for counter fields like this.
  - We do NOT fetch updated user documents after $inc — unnecessary DB read.
    The client gets a clear subscribed: true/false flag to update its own UI state.
*/
const toggleSubscription = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const subscriberId = req.user._id;

  // ── Self-subscription guard ──────────────────────────────────────────────
  // This lives in the controller, not middleware, because it's business logic
  // specific to this one operation. Middleware is for cross-cutting concerns
  // (auth, rate limiting). Don't pollute your middleware layer with model logic.
  if (subscriberId.toString() === channelId.toString()) {
    throw new ApiError(400, "You cannot subscribe to your own channel");
  }

  // ── Validate channelId is a real ObjectId before hitting DB ─────────────
  // If channelId is garbage (e.g. "abc"), mongoose throws a CastError which
  // bubbles up as a 500. Validate early, fail with a clean 400.
  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    throw new ApiError(400, "Invalid channel ID");
  }

  // ── Check channel actually exists ────────────────────────────────────────
  // Never assume the client sends a valid user ID. Always verify existence.
  const channelExists = await User.exists({ _id: channelId });
  if (!channelExists) {
    throw new ApiError(404, "Channel not found");
  }

  // ── Attempt to find and delete an existing subscription (unsubscribe) ───
  // findOneAndDelete is a single atomic DB operation.
  // If it returns a document → subscription existed → we just deleted it.
  // If it returns null → no subscription existed → we need to create one.
  const existingSubscription = await Subscription.findOneAndDelete({
    subscriber: subscriberId,
    channel: channelId,
  });

  if (existingSubscription) {
    // ── UNSUBSCRIBED ─────────────────────────────────────────────────────
    // Decrement both sides atomically.
    // $inc with -1 is safe — but in production you'd add a floor validation
    // (count should never go below 0). For now, $inc -1 is standard practice.
    await User.findByIdAndUpdate(channelId, {
      $inc: { subscribersCount: -1 },
    });
    await User.findByIdAndUpdate(subscriberId, {
      $inc: { subscribedToCount: -1 },
    });

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { subscribed: false },
          "Unsubscribed successfully",
        ),
      );
  }

  // ── CREATE SUBSCRIPTION (subscribe) ──────────────────────────────────────
  // If two simultaneous requests slip past the findOneAndDelete check,
  // the compound unique index on {subscriber, channel} will reject the second
  // create() with a duplicate key error (code 11000).
  // That error is caught by your global error handler — wire it there.
  await Subscription.create({
    subscriber: subscriberId,
    channel: channelId,
  });

  // ── Increment both sides atomically ──────────────────────────────────────
  await User.findByIdAndUpdate(channelId, {
    $inc: { subscribersCount: 1 },
  });
  await User.findByIdAndUpdate(subscriberId, {
    $inc: { subscribedToCount: 1 },
  });

  // ── Trigger notification (scaffolded — no-op until you wire it) ──────────
  // This is fire-and-forget. We do NOT await it.
  // Reason: notification delivery is not the responsibility of the HTTP request.
  // If notification fails, the subscription still succeeded.
  // In production this becomes: push a job to Bull/Agenda queue instead.
  triggerNotification({
    type: "NEW_SUBSCRIBER",
    recipientId: channelId,
    triggeredBy: subscriberId,
  }).catch((err) => {
    // Log but never let notification failure crash the subscription response
    console.error("[triggerNotification] failed silently:", err.message);
  });

  return res
    .status(200)
    .json(
      new ApiResponse(200, { subscribed: true }, "Subscribed successfully"),
    );
});

// ─────────────────────────────────────────────
// GET SUBSCRIBER LIST FOR A CHANNEL
// ─────────────────────────────────────────────
/*
  HOW IT WORKS IN PRODUCTION:
  - We use aggregation + $lookup (MongoDB JOIN) instead of populate().
  - populate() does N+1 queries under the hood — one query to get subscriptions,
    then one query PER subscriber to fetch user details. With 10,000 subscribers
    that's 10,001 DB round trips. Aggregation does it in ONE.
  - We add pagination. Never return unbounded lists. A channel with 5M subscribers
    returning all documents at once will crash your server and the client.
  - skip/limit is simple pagination. In production at scale you'd switch to
    cursor-based pagination (keyset pagination using _id or createdAt),
    but skip/limit is correct for beginner-to-intermediate level.
*/
const getChannelSubscribers = asyncHandler(async (req, res) => {
  const { channelId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    throw new ApiError(400, "Invalid channel ID");
  }

  // ── Pagination params from query string ──────────────────────────────────
  // Always parseInt and provide safe defaults. Never trust raw query strings.
  // Cap the limit — never let a client request 999999 documents.
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  // ── Aggregation Pipeline ─────────────────────────────────────────────────
  const subscribers = await Subscription.aggregate([
    // Stage 1: Filter — only documents where channel matches
    {
      $match: {
        channel: new mongoose.Types.ObjectId(channelId),
      },
    },
    // Stage 2: JOIN with users collection on the subscriber field
    // localField  → field in Subscription document
    // foreignField → field in User document
    // as          → name of the array that gets attached to each document
    {
      $lookup: {
        from: "users", // MongoDB collection name (lowercase plural)
        localField: "subscriber",
        foreignField: "_id",
        as: "subscriberDetails",
      },
    },
    // Stage 3: $unwind flattens the subscriberDetails array into a single object
    // preserveNullAndEmptyArrays: true → don't drop the document if user was deleted
    {
      $unwind: {
        path: "$subscriberDetails",
        preserveNullAndEmptyArrays: true,
      },
    },
    // Stage 4: Shape the output — only expose what the client needs
    // NEVER return full user documents. Password hash, tokens, private data
    // can leak if you project carelessly.
    {
      $project: {
        _id: 0,
        subscribedAt: "$createdAt",
        subscriber: {
          _id: "$subscriberDetails._id",
          username: "$subscriberDetails.username",
          fullName: "$subscriberDetails.fullName",
          avatar: "$subscriberDetails.avatar",
        },
      },
    },
    // Stage 5 & 6: Pagination
    { $skip: skip },
    { $limit: limit },
  ]);

  // ── Get total count for pagination metadata ──────────────────────────────
  // countDocuments is a fast index scan when channel is indexed.
  const totalSubscribers = await Subscription.countDocuments({
    channel: channelId,
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        subscribers,
        pagination: {
          total: totalSubscribers,
          page,
          limit,
          totalPages: Math.ceil(totalSubscribers / limit),
          hasNextPage: page * limit < totalSubscribers,
        },
      },
      "Subscribers fetched successfully",
    ),
  );
});

// ─────────────────────────────────────────────
// GET CHANNELS A USER IS SUBSCRIBED TO
// ─────────────────────────────────────────────
/*
  Same aggregation pattern, opposite direction.
  We match on subscriber field and join the channel side.
  This is the "Subscriptions" tab on a YouTube profile.
*/
const getSubscribedChannels = asyncHandler(async (req, res) => {
  const { subscriberId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(subscriberId)) {
    throw new ApiError(400, "Invalid subscriber ID");
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const channels = await Subscription.aggregate([
    {
      $match: {
        subscriber: new mongoose.Types.ObjectId(subscriberId),
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "channel",
        foreignField: "_id",
        as: "channelDetails",
      },
    },
    {
      $unwind: {
        path: "$channelDetails",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        _id: 0,
        subscribedAt: "$createdAt",
        channel: {
          _id: "$channelDetails._id",
          username: "$channelDetails.username",
          fullName: "$channelDetails.fullName",
          avatar: "$channelDetails.avatar",
          subscribersCount: "$channelDetails.subscribersCount",
        },
      },
    },
    { $skip: skip },
    { $limit: limit },
  ]);

  const totalChannels = await Subscription.countDocuments({
    subscriber: subscriberId,
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        channels,
        pagination: {
          total: totalChannels,
          page,
          limit,
          totalPages: Math.ceil(totalChannels / limit),
          hasNextPage: page * limit < totalChannels,
        },
      },
      "Subscribed channels fetched successfully",
    ),
  );
});

// ─────────────────────────────────────────────
// GET SUBSCRIBER COUNT FOR A CHANNEL
// ─────────────────────────────────────────────
/*
  HOW IT WORKS IN PRODUCTION:
  We read directly from the User document's subscribersCount field
  instead of doing countDocuments on the Subscription collection.

  WHY: subscribersCount on the User document is a denormalized counter.
  We keep it in sync via $inc in toggleSubscription.
  Reading a single field from a single document = one indexed _id lookup = ~1ms.
  countDocuments on a large collection = index scan = slower at scale.

  TRADEOFF: denormalized counters can drift if a bug skips the $inc.
  Production systems run periodic reconciliation jobs that recount from
  Subscription collection and correct any drift. That's a background cron task.
*/
const getSubscriberCount = asyncHandler(async (req, res) => {
  const { channelId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    throw new ApiError(400, "Invalid channel ID");
  }

  // Select only the field we need — never fetch the entire user document
  // when you only need one field. .select() maps to a MongoDB projection.
  const channel = await User.findById(channelId).select(
    "subscribersCount username",
  );

  if (!channel) {
    throw new ApiError(404, "Channel not found");
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        channelId,
        username: channel.username,
        subscribersCount: channel.subscribersCount,
      },
      "Subscriber count fetched successfully",
    ),
  );
});

// ─────────────────────────────────────────────
// CHECK IF CURRENT USER IS SUBSCRIBED
// ─────────────────────────────────────────────
/*
  HOW IT WORKS IN PRODUCTION:
  This endpoint is hit every time a video page loads to know whether to show
  "Subscribe" or "Subscribed" button. It must be FAST.

  We use exists() instead of findOne().
  exists() → returns null or { _id } — MongoDB stops scanning as soon as it
  finds ONE matching document. findOne() fetches the full document.
  For a boolean check, exists() is strictly better.

  The compound index on {subscriber, channel} makes this an exact index lookup
  — effectively O(1) at any scale.
*/
const checkSubscriptionStatus = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const subscriberId = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    throw new ApiError(400, "Invalid channel ID");
  }

  if (subscriberId.toString() === channelId.toString()) {
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { isSubscribed: false, isSelf: true },
          "Cannot subscribe to own channel",
        ),
      );
  }

  const isSubscribed = await Subscription.exists({
    subscriber: subscriberId,
    channel: channelId,
  });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { isSubscribed: Boolean(isSubscribed) },
        "Subscription status fetched",
      ),
    );
});

export {
  toggleSubscription,
  getChannelSubscribers,
  getSubscribedChannels,
  getSubscriberCount,
  checkSubscriptionStatus,
};
