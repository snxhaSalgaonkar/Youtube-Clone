import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";

export const verifyJWT = asyncHandler(async (req, _, next) => {
  try {
    console.log("Verifying JWT for request: ", req.method, req.originalUrl);
    console.log("***********************************************");
    if (req.cookies) {
      console.log("Cookies: ", req.cookies);
    } else {
      console.log("No cookies found in the request");
    }
    const token =
      req.cookies?.accessToken ||
      req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      throw new ApiError(401, "Unauthorized request, token missing");
    }
    console.log("Token found: ", token);
    //1. verify token
    const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    const user = await User.findById(decodedToken?._id).select(
      "-password -refreshToken",
    );

    if (!user) {
      throw new ApiError(404, "User not found");
    }
    console.log("User found: ", user);

    req.user = user;
    next();
  } catch (error) {
    throw new ApiError(
      401,
      error?.message || "Unauthorized request, invalid token",
    );
  }
});

/**
 * MIDDLEWARE: optionalAuth
 * Like verifyJWT but doesn't fail if no token is present.
 * Use this for public endpoints that have "extra features" for logged-in users
 * (e.g., showing a "liked" badge on a video if the user is logged in).
 */
export const optionalAuth = asyncHandler(async (req, _, next) => {
  const token =
    req.cookies?.accessToken ||
    req.header("Authorization")?.replace("Bearer ", "");

  if (token) {
    try {
      req.user = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch {
      // Invalid token — treat as unauthenticated, don't throw
      req.user = null;
    }
  }
  next();
});
