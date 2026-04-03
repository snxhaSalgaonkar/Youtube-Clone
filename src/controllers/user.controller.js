import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from "../models/user.model.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

const registerUser = asyncHandler(async (req, res) => {
  console.log("Inside register user controller");
  console.log("req.body ", req.body);
  console.log("req.files ", req.files);
  //res.status(201).json({ message: "User registered successfully" });

  //1. get user details from frontend
  //2. validation
  //3. check if user already exists: username,email
  //4. check for images, check for avatar
  //5. upload image to cloudinary, avator
  //6. create user object - create entry in db
  //7. remove password and refresh token field from response
  //8. check for user creation
  //9. return response

  //1. get user details from frontend
  const { username, email, fullname, password } = req.body;

  //2. validation
  // if(fullname== ""){
  //   throw new ApiError(400, "Fullname is required");
  // }
  if (
    [fullname, username, email, password].some((fields) => fields.trim() === "")
  ) {
    throw new ApiError(400, "All fields are required");
  }

  //3. check if user already exists: username,email
  const existeduser = await User.findOne({
    $or: [{ username }, { email }],
  });
  if (existeduser) {
    throw new ApiError(409, "User with given username or email already exists");
  }

  // 4. Check for images, check for avatar
  let avatarLocalPath;
  if (
    req.files &&
    req.files.avatar &&
    Array.isArray(req.files.avatar) &&
    req.files.avatar.length > 0
  ) {
    avatarLocalPath = req.files.avatar[0].path;
  }

  let coverImageLocalPath;
  if (
    req.files &&
    req.files.coverImage &&
    Array.isArray(req.files.coverImage) &&
    req.files.coverImage.length > 0
  ) {
    coverImageLocalPath = req.files.coverImage[0].path;
  }

  if (!avatarLocalPath) {
    throw new ApiError(400, "Avatar is required");
  }
  console.log("avatarLocalPath ", avatarLocalPath);
  console.log("coverImageLocalPath ", coverImageLocalPath);

  //5. upload image to cloudinary, avator
  const avatar = await uploadToCloudinary(avatarLocalPath);
  const coverImage = await uploadToCloudinary(coverImageLocalPath);

  if (!avatar) {
    throw new ApiError(400, "Avatar upload failed upload agaain");
  }

  //6. create user object - create entry in db
  const user = await User.create({
    fullname,
    avatar: avatar.url,
    coverImage: coverImage?.url || "",
    email,
    password,
    username: username.toLowerCase(),
  });
  console.log("User created :", user);

  //7. remove password and refresh token field from response
  const createdUser = await User.findById(user._id).select(
    "-password -refreshToken",
  );
  console.log("Created user after removing sensitive info :", createdUser);

  //8. check for user creation
  if (!createdUser) {
    throw new ApiError(500, "User creation failed, try again");
  }

  //9. return response
  return res
    .status(201)
    .json(new ApiResponse(200, createdUser, "User registered successfully"));
});

const loginUser = asyncHandler(async (req, res) => {
  //1. get login credentials from frontend
  //2. validation
  //3. check if user exists
  //4. check for password correctness
  //5. generate access token and refresh token
  //6. store refresh token in db
  //7. return response with access token and refresh token

  //1. get login credentials from frontend
  console.log("*************************");
  console.log("request: ", req);
  const { email, password, username } = req.body;
  console.log("Login credentials ", req.body);

  //2. validation
  if (!email && !username) {
    throw new ApiError(400, "Email or username is required");
  }
  if (!password) {
    throw new ApiError(400, "Password is required");
  }

  //3. check if user exists
  const user = await User.findOne({
    $or: [{ username }, { email }],
  });
  if (!user) {
    throw new ApiError(404, "User does not exixt, Register it");
  }
  console.log("User exit ", user);

  //4. check for password correctness
  const isPassword = await user.isPasswordCorrect(password);
  if (!isPassword) {
    throw new ApiError(401, "Invalid User credentials");
  }
  console.log("password Matched");

  //5. generate access token and refresh token
  //6. store refresh token in db
  const { accessToken, refreshToken } = await generateAcessAndRefreshTokens(
    user._id,
  );

  //7. remove password and refresh token field from response
  const loggedInuser = await User.findById(user._id).select(
    "-password -refreshToken",
  );
  console.log("Logged in user after removing sensitive info :", loggedInuser);

  //send cookies
  const options = {
    httpOnly: true,
    secure: true,
  };

  //7. return response with access token and refresh token
  return res
    .status(200)
    .cookie("accessToken", accessToken, options)
    .cookie("refreshToken", refreshToken, options)
    .json(
      new ApiResponse(
        200,
        { user: loggedInuser, accessToken, refreshToken },
        "User logged in successfully",
      ),
    );
});

const logoutUser = asyncHandler(async (req, res) => {
  //if i ask username and password while logging out then the
  // user may enter any wrong credentials

  //1. find user from req.user
  //2. remove refresh token from db
  //3. clear cookies
  //4. return response

  //1. find user from req.user
  //2. remove refresh token from db
  await User.findByIdAndUpdate(
    req.user._id,
    { $set: { refreshToken: undefined } },
    {
      new: true,
    },
  );

  const options = {
    httpOnly: true,
    secure: true,
  };

  //3. clear cookies
  //4. return response
  return res
    .status(200)
    .clearCookie("accessToken", options)
    .clearCookie("refreshToken", options)
    .json(new ApiResponse(200, {}, "User logged Out"));
});

const generateAcessAndRefreshTokens = async (userId) => {
  try {
    const user = await User.findById(userId);
    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });
    console.log("Generated Access and Refresh Tokens");
    console.log("accessToken ", accessToken);
    console.log("refreshToken ", refreshToken);
    console.log("User after storing refresh token ", user);

    return { accessToken, refreshToken };
  } catch (error) {
    throw new ApiError(500, "Error while generating Acess And Refresh Tokens");
  }
};

const refreshAccessToken = asyncHandler(async (req, res) => {
  //1. get refresh token from cookies
  //2. validate refresh token
  //3. check if refresh token is present in db
  //4. check the incoming RefreshToken with the refresh token saved in DB
  //5. generate new access token
  //5. return response

  //1. get refresh token from cookies
  const incomingRefrehToken = req.cookies.refreshToken || req.body.refreshToken;

  if (!incomingRefrehToken) {
    throw new ApiError(401, "Unauthorized request, refresh token missing");
  }

  try {
    //2. validate refresh token
    const decodedToken = jwt.verify(
      incomingRefrehToken,
      process.env.REFRESH_TOKEN_SECRET,
    );

    //3. check if refresh token is present in db
    const user = await User.findById(decodedToken?._id);
    if (!user) {
      throw new ApiError(401, "Invalid refresh token");
    }
    //4. check the incoming RefreshToken with the refresh token saved in DB
    if (incomingRefrehToken != user?.refreshToken) {
      throw new ApiError(401, "Refresh token is expired or used");
    }
    //5. generate new access token
    const options = {
      httpOnly: true,
      secure: true,
    };

    const { accessToken, newrefreshToken } =
      await generateAcessAndRefreshTokens(user._id);

    return res
      .status(200)
      .cookie("accessToken", accessToken, options)
      .cookie("refreshToken", newrefreshToken, options)
      .json(
        new ApiResponse(
          200,
          { accessToken, refreshToken: newrefreshToken },
          "Acess token refreshed",
        ),
      );
  } catch (error) {
    throw new ApiError(401, error?.message || "Invalid refresh token");
  }
});

const changeCurrentPassword = asyncHandler(async (req, res) => {
  const { oldPassword, newPassword, confirmPassword } = req.body;

  if (newPassword != confirmPassword) {
    throw new ApiError(401, "Password do not match");
  }
  const user = User.findById(req.user?._id);
  const isPasswordCorrect = await user.isPasswordCorrect(oldPassword);
  if (!isPasswordCorrect) {
    throw new ApiError(400, "Invalid Old password");
  }

  user.password = newPassword;
  await user.save({ validateBeforeSave: false });

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Password changed successfully"));
});

const getCurrentUser = asyncHandler(async (req, res) => {
  return res
    .status(200)
    .json(new ApiResponse(200, req.user, "current user fetched successfully"));
});

const updateAccountdetails = asyncHandler(async (req, res) => {
  const { fullname, email } = req.body;
  if (!fullname || !email) {
    throw new ApiError(400, "All field are required");
  }
  await User.findByIdAndUpdate(
    req.user?._id,
    {
      $set: {
        fullname,
        email: email,
      },
    },
    { new: true },
  ).select("-password");
  return res
    .status(200)
    .json(new ApiResponse(200, req.user, "current user fetched successfully"));
});

const updateUserAvatar = asyncHandler(async (req, res) => {
  const avatarLocalPath = req.file?.path;

  //delete the previous file
  //1. get the user id
  //2. get the avatar file url
  //3. delete it

  if (!avatarLocalPath) {
    throw new ApiError(400, "Avatar file is missing");
  }
  const avatar = await uploadToCloudinary(avatarLocalPath);
  if (!avatar.url) {
    throw new ApiError(400, "Error while uploading Avatar");
  }

  const user = await User.findByIdAndUpdate(
    req.user?._id,
    {
      $set: {
        avatar: avatar.url,
      },
    },
    { new: true },
  ).select("-password");

  return res
    .status(200)
    .json(new ApiResponse(200, user, "updated avata Image successfully"));
});

const updateUserCoverImage = asyncHandler(async (req, res) => {
  const coverLocalPath = req.file?.path;

  if (!coverLocalPath) {
    throw new ApiError(400, "coverImage file is missing");
  }
  const coverImage = await uploadToCloudinary(coverLocalPath);
  if (!coverImage.url) {
    throw new ApiError(400, "Error while uploading Avatar");
  }

  const user = await User.findByIdAndUpdate(
    req.user?._id,
    {
      $set: {
        coverImage: coverImage.url,
      },
    },
    { new: true },
  ).select("-password");

  return res
    .status(200)
    .json(new ApiResponse(200, user, "updated coverImage successfully"));
});

const getUserChannelProfile = asyncHandler(async (req, res) => {
  const { username } = req.params;

  if (!username?.trim()) {
    throw new ApiError(400, "username is missing");
  }
  const channel = await User.aggregate([
    {
      $match: {
        username: username?.toLowerCase(),
      },
    },
    //how many subscribers
    {
      $lookup: {
        from: "Subscriptions",
        localField: "_id",
        foreignField: "channel",
        as: "subscribers",
      },
    },
    //how many you have subscribed
    {
      $lookup: {
        from: "Subscriptions",
        localField: "_id",
        foreignField: "subscriber",
        as: "subscriberedTo",
      },
    },
    //inside origal user object have add 2 fiels
    {
      $addFields: {
        subscriberCount: {
          $size: "$subscribers",
        },
        channelsSubscribedToCount: {
          $size: "subscriberedTo",
        },
        isSubscribed: {
          $cond: {
            if: {
              $in: [req.user?._id, "$subscribers.subscriber"],
            },
            then: true,
            else: false,
          },
        },
      },
    },

    {
      $project: {
        fullname: 1,
        username: 1,
        subscriberCount: 1,
        channelsSubscribedToCount: 1,
        avatar: 1,
        coverImage: 1,
        email: 1,
      },
    },
  ]);

  if (!channel?.length) {
    throw new ApiError(404, "channel does not exits");
  }
  console.log("Channel ", channel);

  return res
    .status(200)
    .json(new ApiResponse(200, channel[0], "Channel fetched successfully"));
});

const getWatchHistory = asyncHandler(async (req, res) => {
  const user = await User.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(req.user._id),
      },
    },
    {
      $lookup: {
        from: "videos",
        localField: "watchHistory",
        foreignField: "_id",
        as: "watchHistory",
        pipeline: [
          {
            $lookup: {
              from: "users",
              localField: "owner",
              foreignField: "_id",
              as: "owner",
              pipeline: [
                {
                  $project: {
                    fullname: 1,
                    username: 1,
                    avatar: 1,
                  },
                },
                {
                  $addFields: {
                    owner: {
                      $first: "$owner",
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ]);
  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        user[0].watchHistory,
        "watch history fetched successfully",
      ),
    );
});

//delete account
//verify email
//forgot password
//reste password
//Get all users(admin only)
//Ban/unban user admin only)
// update user role (admin only)

export {
  registerUser,
  loginUser,
  logoutUser,
  refreshAccessToken,
  changeCurrentPassword,
  getCurrentUser,
  updateAccountdetails,
  updateUserAvatar,
  updateUserCoverImage,
  getUserChannelProfile,
  getWatchHistory,
};
