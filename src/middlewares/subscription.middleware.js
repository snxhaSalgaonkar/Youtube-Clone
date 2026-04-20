import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";

// ─────────────────────────────────────────────
// PREVENT SELF-SUBSCRIPTION MIDDLEWARE
// ─────────────────────────────────────────────
/*
  WHY THIS EXISTS AS MIDDLEWARE AND NOT ONLY IN THE CONTROLLER:

  The controller already has a self-subscription guard. So why a middleware too?

  In production, you apply defense in depth — multiple layers of the same
  check at different levels. The middleware catches it before the controller
  even runs, saving a function call and making intent explicit in the route.

  More importantly: if you ever add a second controller that toggles subscriptions
  (e.g. a bulk subscription feature), the middleware automatically protects it
  without you remembering to add the check again.

  WHAT IS req.user HERE:
  verifyJWT runs before this middleware (see routes — router.use(verifyJWT) is
  declared first). verifyJWT attaches the decoded user to req.user.
  By the time preventSelfSubscription runs, req.user is guaranteed to exist.
  This is why middleware ORDER matters — if you put preventSelfSubscription
  before verifyJWT, req.user would be undefined and this crashes.

  HOW MIDDLEWARE CHAIN WORKS:
  verifyJWT → preventSelfSubscription → controller
  Each calls next() to pass control to the next function.
  If any throws or calls next(error), Express skips to the error handler.
*/
const preventSelfSubscription = (req, res, next) => {
  const { channelId } = req.params;
  const subscriberId = req.user?._id;

  // Guard: if verifyJWT didn't attach user for some reason
  if (!subscriberId) {
    return next(new ApiError(401, "Unauthorized"));
  }

  // Guard: channelId must be a valid ObjectId before comparing
  if (!mongoose.Types.ObjectId.isValid(channelId)) {
    return next(new ApiError(400, "Invalid channel ID"));
  }

  // .toString() is required because subscriberId is a Mongoose ObjectId object,
  // not a string. Direct === comparison between ObjectId and string always fails.
  if (subscriberId.toString() === channelId.toString()) {
    return next(new ApiError(400, "You cannot subscribe to your own channel"));
  }

  // All checks passed — hand off to the next middleware/controller
  next();
};

export { preventSelfSubscription };
