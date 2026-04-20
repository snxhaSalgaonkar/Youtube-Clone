import { Router } from "express";
import {
  toggleSubscription,
  getChannelSubscribers,
  getSubscribedChannels,
  getSubscriberCount,
  checkSubscriptionStatus,
} from "../controllers/subscription.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { preventSelfSubscription } from "../middlewares/subscription.middleware.js";

const router = Router();

// ─────────────────────────────────────────────
// ALL ROUTES REQUIRE AUTHENTICATION
// ─────────────────────────────────────────────
/*
  HOW IT WORKS IN PRODUCTION:
  router.use(verifyJWT) applies verifyJWT to EVERY route registered on this
  router AFTER this line. This is called a router-level middleware.

  Placing it once here is cleaner than repeating verifyJWT on every individual
  route. If you ever need a public route on this router (e.g. public subscriber
  count), define it BEFORE this router.use() line.
*/
router.use(verifyJWT);

// ─────────────────────────────────────────────
// SUBSCRIPTION TOGGLE
// POST /api/v1/subscriptions/c/:channelId
// ─────────────────────────────────────────────
/*
  preventSelfSubscription runs BEFORE the controller as route-level middleware.
  It's placed here (not router.use) because self-subscription only makes sense
  for the toggle route — not for fetching subscriber lists.

  Route-level middleware = applies to this one route only.
  Router-level middleware = applies to all routes in the router.
*/
router.route("/c/:channelId").post(preventSelfSubscription, toggleSubscription);

// ─────────────────────────────────────────────
// GET SUBSCRIBERS OF A CHANNEL
// GET /api/v1/subscriptions/c/:channelId/subscribers
// ─────────────────────────────────────────────
// Supports ?page=1&limit=20 query params for pagination
router.route("/c/:channelId/subscribers").get(getChannelSubscribers);

// ─────────────────────────────────────────────
// GET CHANNELS A USER SUBSCRIBED TO
// GET /api/v1/subscriptions/u/:subscriberId/channels
// ─────────────────────────────────────────────
// Supports ?page=1&limit=20 query params for pagination
router.route("/u/:subscriberId/channels").get(getSubscribedChannels);

// ─────────────────────────────────────────────
// GET SUBSCRIBER COUNT FOR A CHANNEL
// GET /api/v1/subscriptions/c/:channelId/count
// ─────────────────────────────────────────────
router.route("/c/:channelId/count").get(getSubscriberCount);

// ─────────────────────────────────────────────
// CHECK IF CURRENT USER IS SUBSCRIBED
// GET /api/v1/subscriptions/c/:channelId/status
// ─────────────────────────────────────────────
router.route("/c/:channelId/status").get(checkSubscriptionStatus);

export default router;
