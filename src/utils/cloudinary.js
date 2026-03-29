// import { v2 as cloudinary } from "cloudinary";
// import fs from "fs";

// cloudinary.config({
//   cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
//   api_key: process.env.CLOUDINARY_API_KEY,
//   api_secret: process.env.CLOUDINARY_API_SECRET, // Click 'View API Keys' above to copy your API secret
// });

// const uploadOnCloudinary = async (localfilepath) => {
//   try {
//     if (!localfilepath) return null;
//     //upload the file on cloudinary
//     const response = await cloudinary.uploader.upload(localfilepath, {
//       resource_type: "auto",
//     });
//     //file has been uploaded,
//     //console.log("***********************");
//     console.log("File uploaded on cloudinary successfully:", response);
//     console.log("file url", response.url);

//     fs.unlinkSync(localfilepath); // remove the locally stored tomparailly file
//     return response;
//   } catch (error) {
//     console.log(error);
//     fs.unlinkSync(localfilepath); // remove
//     // the locally stored tomparailly file
//     //  as the upload operation got failed
//     return null;
//   }
// };

// export { uploadOnCloudinary };
/**
 * UTILITY: cloudinary.js
 *
 * KEY CONCEPT: Why a utility file for Cloudinary?
 * Cloudinary logic (config, upload, delete) is needed in multiple controllers
 * — video upload, video delete, update thumbnail, etc. Instead of copy-pasting
 * the same Cloudinary code everywhere, we write it ONCE here and import it
 * wherever needed. This is the DRY principle: Don't Repeat Yourself.
 *
 * If you ever switch from Cloudinary to AWS S3, you only change THIS file —
 * not every controller that does uploads.
 *
 * SETUP: Install the Cloudinary SDK
 *   npm install cloudinary
 *
 * Add these to your .env file:
 *   CLOUDINARY_CLOUD_NAME=your_cloud_name
 *   CLOUDINARY_API_KEY=your_api_key
 *   CLOUDINARY_API_SECRET=your_api_secret
 *
 * SECURITY TIP: Never hardcode these values in your code. Anyone who sees
 * your GitHub repo can use your Cloudinary account and run up charges.
 * Always use environment variables and add .env to your .gitignore.
 */

import { v2 as cloudinary } from "cloudinary";
import fs from "fs";

/**
 * KEY CONCEPT: Configuration
 * cloudinary.config() reads your credentials and sets them globally for all
 * subsequent Cloudinary calls in this process. Call it once — at the top of
 * this file — so every function below automatically uses the right account.
 *
 * process.env reads from your .env file (loaded by dotenv in app.js).
 */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD TO CLOUDINARY
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Uploads a file from the local temp path to Cloudinary.
 * Called after Multer saves the file to /tmp.
 *
 * KEY CONCEPT: resource_type
 * Cloudinary handles different file types differently:
 *   "image" → optimizes as an image (JPEG, PNG, WebP transforms available)
 *   "video" → generates thumbnails, HLS streams, duration metadata
 *   "raw"   → any other file (PDFs, zip files, etc.)
 * Always pass the correct resource_type — uploading a video as "image" will fail.
 *
 * KEY CONCEPT: folder
 * Cloudinary organizes files in folders (like directories).
 * Using separate folders for videos and thumbnails keeps your Cloudinary
 * media library organized and makes bulk operations easier.
 *
 * KEY CONCEPT: Cleaning up the temp file
 * After the upload succeeds (or fails), we MUST delete the temp file from /tmp.
 * If we don't, temp files accumulate and eventually fill the server's disk.
 * We use fs.unlinkSync() in a finally block — so cleanup ALWAYS runs, even
 * if the Cloudinary upload throws an error.
 *
 * COMMON BEGINNER MISTAKE: Only cleaning up on success and forgetting the
 * error case. A failed upload still leaves a temp file behind.
 *
 * @param {string} localFilePath  - The /tmp path Multer saved the file to
 * @param {string} resourceType   - "video" | "image" | "raw"
 * @returns {object|null}         - Cloudinary upload result, or null on failure
 */
const uploadToCloudinary = async (localFilePath, resourceType = "image") => {
  // Guard: if no path was provided, nothing to upload
  if (!localFilePath) return null;

  try {
    const uploadOptions = {
      resource_type: resourceType,

      // Store in a subfolder based on type — keeps Cloudinary organized
      folder:
        resourceType === "video"
          ? "youtube-clone/videos"
          : "youtube-clone/thumbnails",

      /**
       * KEY CONCEPT: eager transformations
       * Cloudinary can process the file immediately after upload as part of the
       * same API call. Here we generate an HLS (HTTP Live Streaming) version
       * of the video — the format used by YouTube for adaptive quality.
       * The result URL is in response.eager[0].url.
       *
       * This only applies to videos (ignored for images).
       */
      ...(resourceType === "video" && {
        eager: [
          {
            streaming_profile: "hd", // generates multiple quality levels
            format: "m3u8", // HLS playlist format
          },
        ],
        eager_async: false, // wait for HLS to be ready before responding
      }),
    };

    const response = await cloudinary.uploader.upload(
      localFilePath,
      uploadOptions,
    );

    /**
     * The response object contains (among other things):
     * {
     *   public_id: "youtube-clone/videos/abc123",  ← needed for deletion
     *   url:       "http://res.cloudinary.com/...", ← standard URL
     *   secure_url:"https://res.cloudinary.com/...",← HTTPS URL (always use this)
     *   duration:  124.5,                           ← video duration in seconds
     *   width:     1920,
     *   height:    1080,
     *   format:    "mp4",
     *   eager: [{ url: "https://.../hls/abc.m3u8" }] ← HLS stream URL
     * }
     *
     * KEY CONCEPT: Always use secure_url, not url.
     * url is HTTP (insecure). secure_url is HTTPS. Modern browsers block
     * mixed content — an HTTPS page loading an HTTP video will be blocked.
     * We remap url → secure_url below so callers always get the HTTPS version.
     */
    return {
      ...response,
      url: response.secure_url, // override http url with https secure_url
    };
  } catch (error) {
    /**
     * KEY CONCEPT: Fail gracefully — log the error, return null.
     * The controller checks if uploadToCloudinary returned null and throws
     * an ApiError(500) with a user-friendly message.
     * We do NOT re-throw here — the controller decides what to tell the client.
     *
     * In production: send this error to your logging service (Sentry, Datadog).
     */
    console.error("[Cloudinary] Upload failed:", error.message);
    return null;
  } finally {
    /**
     * KEY CONCEPT: finally block — ALWAYS runs, success or failure.
     * Delete the temp file no matter what happened above.
     *
     * fs.existsSync() check: if Multer failed partway and the file doesn't
     * exist, unlinkSync would throw. Always check before deleting.
     */
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE FROM CLOUDINARY
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Permanently deletes a file from Cloudinary by its public_id.
 * Called in deleteVideo to clean up the actual files after removing the DB record.
 *
 * KEY CONCEPT: public_id vs URL
 * To delete a file, Cloudinary needs its public_id — NOT the full URL.
 * The public_id is the path without the domain and without the file extension.
 *
 * Example URL:
 *   https://res.cloudinary.com/mycloudname/video/upload/v1234/youtube-clone/videos/abc123.mp4
 *
 * public_id is just:
 *   youtube-clone/videos/abc123
 *
 * KEY CONCEPT: Where do we GET the public_id?
 * Two options:
 *   Option A (used here): Extract it from the stored URL using string parsing.
 *   Option B (better for production): Store the public_id as a separate field
 *             in your Video schema alongside the URL. This is more reliable
 *             because it doesn't depend on the URL format never changing.
 *
 * COMMON BEGINNER MISTAKE: Passing the full URL to cloudinary.uploader.destroy().
 * That will silently fail (Cloudinary returns { result: "not found" }) because
 * it expects just the public_id, not the whole URL.
 *
 * @param {string} publicIdOrUrl  - Either the public_id OR the full Cloudinary URL
 * @param {string} resourceType   - "video" | "image" | "raw"
 * @returns {boolean}             - true if deleted, false if failed
 */
const deleteFromCloudinary = async (publicIdOrUrl, resourceType = "image") => {
  if (!publicIdOrUrl) return false;

  try {
    /**
     * KEY CONCEPT: Extracting public_id from a URL
     * We support both raw public_id strings AND full Cloudinary URLs.
     * Detection: if the value starts with "http", it's a URL — extract the public_id.
     * Otherwise treat it as already being a public_id.
     *
     * URL structure:
     *   https://res.cloudinary.com/{cloud_name}/{resource_type}/upload/{version}/{public_id}.{ext}
     *
     * Steps to extract public_id from the URL:
     *   1. Split by "/upload/" — gives us everything before and after the upload segment
     *   2. Take the part AFTER "/upload/"
     *   3. Remove the version prefix if present (v1234567/)
     *   4. Remove the file extension (.mp4, .jpg etc.)
     *
     * Example:
     *   Input:  "https://res.cloudinary.com/demo/video/upload/v1234/youtube-clone/videos/abc.mp4"
     *   After step 1+2: "v1234/youtube-clone/videos/abc.mp4"
     *   After step 3:   "youtube-clone/videos/abc.mp4"
     *   After step 4:   "youtube-clone/videos/abc"  ← this is the public_id
     */
    let publicId = publicIdOrUrl;

    if (publicIdOrUrl.startsWith("http")) {
      // Step 1 & 2: get everything after "/upload/"
      const uploadSegment = publicIdOrUrl.split("/upload/")[1];

      if (!uploadSegment) {
        console.error(
          "[Cloudinary] Could not parse URL — missing /upload/ segment:",
          publicIdOrUrl,
        );
        return false;
      }

      // Step 3: remove the version prefix (v followed by digits and a slash)
      // e.g. "v1234567/youtube-clone/videos/abc.mp4" → "youtube-clone/videos/abc.mp4"
      const withoutVersion = uploadSegment.replace(/^v\d+\//, "");

      // Step 4: remove the file extension
      // e.g. "youtube-clone/videos/abc.mp4" → "youtube-clone/videos/abc"
      publicId = withoutVersion.replace(/\.[^/.]+$/, "");
    }

    /**
     * cloudinary.uploader.destroy() permanently deletes the file.
     * It returns: { result: "ok" }          → success
     *             { result: "not found" }    → file didn't exist (already deleted)
     *
     * KEY CONCEPT: "not found" is NOT a hard failure for us.
     * If the file is already gone (maybe deleted manually in Cloudinary dashboard),
     * we still want the rest of our cleanup to proceed. Log it, don't throw.
     *
     * resource_type MUST match what was used during upload.
     * Destroying a video with resource_type: "image" returns "not found" silently —
     * one of the most confusing Cloudinary gotchas for beginners.
     */
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });

    if (result.result === "ok") {
      return true;
    }

    if (result.result === "not found") {
      // File was already gone — not an error for our purposes
      console.warn(
        `[Cloudinary] File not found (already deleted?): ${publicId}`,
      );
      return true; // treat as success — the file is gone either way
    }

    // Any other result is unexpected
    console.error(
      `[Cloudinary] Unexpected delete result for ${publicId}:`,
      result,
    );
    return false;
  } catch (error) {
    /**
     * Network errors, auth errors, invalid credentials etc.
     * Log but don't throw — the caller (deleteVideo) uses Promise.allSettled
     * so it handles individual failures gracefully.
     */
    console.error(
      `[Cloudinary] Delete failed for ${publicIdOrUrl}:`,
      error.message,
    );
    return false;
  }
};

export { uploadToCloudinary, deleteFromCloudinary };
