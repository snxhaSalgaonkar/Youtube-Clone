/**
 * MULTER MIDDLEWARE
 *
 * KEY CONCEPT: Multer for File Uploads
 * Multer intercepts multipart/form-data (file uploads) and:
 * 1. Parses form fields into req.body
 * 2. Saves uploaded files to disk (or custom storage)
 * 3. Attaches file metadata to req.files or req.file
 *
 * FLOW:
 * 1. Client sends file + form data with Content-Type: multipart/form-data
 * 2. Multer middleware intercepts and saves to ./public/temp
 * 3. Controller receives req.files with file paths
 * 4. Controller uploads files to Cloudinary using uploadOnCloudinary()
 * 5. Controller deletes the temp files (cleanup in finally block)
 * 6. Controller returns Cloudinary URLs in response
 *
 * WHY TEMP DISK STORAGE?
 * Cloudinary SDK requires a file path on disk to upload FROM.
 * We can't stream directly to Cloudinary from request memory.
 * So: temp disk → Cloudinary → delete temp file.
 *
 * SECURITY TIP: Always validate file types (MIME check) and sizes
 * BEFORE accepting uploads. A 5GB "video" file can crash your server.
 */

import multer from "multer";
import { ApiError } from "../utils/ApiError.js";

// ─── STORAGE CONFIGURATION ────────────────────────────────────────────────────

/**
 * Disk storage for temporary file uploads
 * Files are saved to ./public/temp and later uploaded to Cloudinary
 */
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const diskStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "../../public/temp")); // ← absolute path
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});



// Legacy export for simple file uploads (if used elsewhere)
export const upload = multer({ storage: diskStorage });

// ─── UPLOAD LIMITS ────────────────────────────────────────────────────────────

/**
 * File size limits for different upload types
 * Video: 500MB (typical streaming limit)
 * Thumbnail: 5MB (small images only)
 */
const LIMITS = {
  VIDEO_MAX_SIZE: 500 * 1024 * 1024, // 500MB
  THUMBNAIL_MAX_SIZE: 5 * 1024 * 1024, // 5MB
};

// ─── FILE FILTER ──────────────────────────────────────────────────────────────

/**
 * Validates files before upload
 * Accepts only video (mp4, webm, mkv) and image (jpg, png) files
 *
 * SECURITY TIP: MIME type checking prevents obviously wrong files.
 * However, MIME types can be spoofed. For production, also validate
 * file magic bytes (file signatures) using libraries like 'file-type'.
 */
const videoFileFilter = (req, file, cb) => {
  const allowedMimes = {
    // Video MIME types
    "video/mp4": true,
    "video/webm": true,
    "video/x-matroska": true, // .mkv
    "video/quicktime": true, // .mov
    "video/x-msvideo": true, // .avi
    // Image MIME types (for thumbnails)
    "image/jpeg": true,
    "image/png": true,
    "image/webp": true,
  };

  if (allowedMimes[file.mimetype]) {
    cb(null, true);
  } else {
    cb(
      new ApiError(
        400,
        `Invalid file type: ${file.mimetype}. Allowed: MP4, WebM, MKV (video) or JPEG, PNG, WebP (thumbnail)`,
      ),
    );
  }
};

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────

/**
 * Multer throws its own error types (MulterError) that bypass Express's
 * normal error handler if you're not careful. This wrapper catches them
 * and converts to your ApiError format.
 *
 * Usage in routes (wrap the multer middleware):
 *   router.post("/upload", handleMulterErrors(uploadVideoAndThumbnail), controller);
 */
export const handleMulterErrors = (multerMiddleware) => {
  return (req, res, next) => {
    console.log("*************handleMulterErrors called from multer.M*************")
    console.log("🔄 handleMulterErrors: Starting multer processing...");
    multerMiddleware(req, res, (err) => {
      console.log("✅ multer callback called. Error:", err?.message || "None");
      if (!err) {
        console.log("✅ No multer errors. Files:", Object.keys(req.files || {}));
        console.log("✅ Body:", req.body);
        return next(); // Files parsed successfully, move to next middleware
      }

      console.log("❌ Multer error:", err.code || err.message);
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(
          new ApiError(
            413,
            "File too large. Maximum size: 500MB for video, 5MB for thumbnail",
          ),
        );
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return next(
          new ApiError(
            400,
            "Too many files. Upload one video and one thumbnail",
          ),
        );
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return next(
          new ApiError(
            400,
            `Unexpected field: "${err.field}". Use "videoFile" and "thumbnail"`,
          ),
        );
      }
      if (err instanceof ApiError) {
        return next(err); // Already formatted
      }

      // Unknown multer or stream error
      return next(new ApiError(500, `Upload error: ${err.message}`));
    });
  };
};

// ─── MULTER INSTANCES ─────────────────────────────────────────────────────────

/**
 * For uploading both video + thumbnail in one request
 * Multer will save files to ./public/temp
 */
export const uploadVideoAndThumbnail = multer({
  storage: diskStorage,
  fileFilter: videoFileFilter,
  limits: {
    fileSize: LIMITS.VIDEO_MAX_SIZE,
    files: 2, // Max 2 files per request
  },
}).fields([
  { name: "videoFile", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 },
]);

/**
 * For updating just the thumbnail
 * Accepts only image files, max 5MB
 */
export const uploadThumbnailOnly = multer({
  storage: diskStorage,
  fileFilter: videoFileFilter,
  limits: {
    fileSize: LIMITS.THUMBNAIL_MAX_SIZE,
    files: 1,
  },
}).single("thumbnail");
