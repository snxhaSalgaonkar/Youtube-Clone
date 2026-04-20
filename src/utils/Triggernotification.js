// triggerNotification.js
// ─────────────────────────────────────────────
/*
  CURRENT STATE: Scaffolded. Does nothing except log.
  FUTURE STATE:  Push a job onto Bull/Agenda queue. A background worker
                 picks it up and delivers emails/push notifications to
                 the channel owner (or all subscribers on video upload).

  WHY A QUEUE AND NOT DIRECT EMAIL HERE:

  Imagine a channel with 2 million subscribers uploads a video.
  You need to notify all 2 million people.

  If you loop and send emails inside the HTTP request:
    - The request never finishes (timeout in seconds, loop takes hours)
    - Your email provider rate-limits you and starts dropping
    - One failed email crashes the entire loop unless you handle it
    - Your Express server is blocked doing I/O for hours

  The correct pattern:
    1. Push ONE job to the queue: { type: "VIDEO_UPLOADED", channelId, videoId }
    2. HTTP request returns immediately — user gets a fast response
    3. Background worker reads the job, fetches subscriber list in batches
       (e.g. 500 at a time), sends emails batch by batch over minutes/hours
    4. If worker crashes, the queue retries the job automatically
    5. Your HTTP server is never blocked

  This is called "async job processing" and it's how every production
  notification system works — YouTube, Twitter, Gmail — all of them.

  WHEN YOU'RE READY TO WIRE THIS:
  1. npm install bull ioredis (Bull requires Redis)
     OR
     npm install agenda (Agenda uses your existing MongoDB)
  2. Replace the console.log block below with queue.add(...)
  3. Create a separate worker file that processes the jobs
  4. Run the worker as a separate process (or separate dyno on Heroku)

  NOTIFICATION TYPES THIS UTIL HANDLES:
  - NEW_SUBSCRIBER  → notify channel owner someone subscribed
  - VIDEO_UPLOADED  → notify all subscribers of a channel (future, needs queue)
*/

// ─────────────────────────────────────────────
// NOTIFICATION TYPE CONSTANTS
// ─────────────────────────────────────────────
// Using a frozen object as an enum — JavaScript has no native enum.
// Object.freeze prevents accidental mutation of these constants.
export const NOTIFICATION_TYPES = Object.freeze({
  NEW_SUBSCRIBER: "NEW_SUBSCRIBER",
  VIDEO_UPLOADED: "VIDEO_UPLOADED",
  NEW_COMMENT: "NEW_COMMENT",
  VIDEO_LIKED: "VIDEO_LIKED",
});

// ─────────────────────────────────────────────
// MAIN UTIL FUNCTION
// ─────────────────────────────────────────────
/*
  @param {Object} options
  @param {string} options.type          - One of NOTIFICATION_TYPES
  @param {string} options.recipientId   - The user who receives the notification
  @param {string} options.triggeredBy   - The user who caused the notification
  @param {Object} [options.meta]        - Any extra data (videoId, comment text, etc.)

  Returns a Promise — designed to be called fire-and-forget (no await).
  Errors are caught by the caller with .catch() so they never crash the request.
*/
const triggerNotification = async ({
  type,
  recipientId,
  triggeredBy,
  meta = {},
}) => {
  // ── Input validation ──────────────────────────────────────────────────────
  // This function is called without await — so throw here is caught by the
  // .catch() in the controller, not by Express error handler.
  if (!type || !recipientId || !triggeredBy) {
    throw new Error(
      "[triggerNotification] Missing required fields: type, recipientId, triggeredBy",
    );
  }

  if (!Object.values(NOTIFICATION_TYPES).includes(type)) {
    throw new Error(`[triggerNotification] Unknown notification type: ${type}`);
  }

  // ── Scaffold: Log the notification intent ────────────────────────────────
  // Replace this entire block with queue.add() when you wire Bull/Agenda.
  console.log("[triggerNotification] Notification queued (scaffold):", {
    type,
    recipientId: recipientId.toString(),
    triggeredBy: triggeredBy.toString(),
    meta,
    timestamp: new Date().toISOString(),
  });

  // ── FUTURE: Bull queue implementation (uncomment when ready) ─────────────
  /*
  import notificationQueue from "../queues/notification.queue.js";

  await notificationQueue.add(
    type,                          // job name — used by worker to route logic
    {
      type,
      recipientId: recipientId.toString(),
      triggeredBy: triggeredBy.toString(),
      meta,
    },
    {
      attempts: 3,                 // retry up to 3 times on failure
      backoff: {
        type: "exponential",       // wait 2s, 4s, 8s between retries
        delay: 2000,
      },
      removeOnComplete: true,      // don't pile up completed jobs in Redis
      removeOnFail: false,         // keep failed jobs for debugging
    }
  );
  */

  // ── FUTURE: Agenda queue implementation (uncomment when ready) ───────────
  /*
  import agenda from "../queues/agenda.js";

  await agenda.now(type, {
    recipientId: recipientId.toString(),
    triggeredBy: triggeredBy.toString(),
    meta,
  });
  */

  return true;
};

export { triggerNotification };
