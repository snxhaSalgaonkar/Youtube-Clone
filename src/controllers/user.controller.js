import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from "../models/user.model.js";
import { uploadOnCloudinary } from "../utils/cloudinary.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import jwt from "jsonwebtoken";

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

  //4. check for images, check for avatar
  const avatarLocalPath = req.files?.avatar[0]?.path;
  //const coverImageLocalPath = req.files?.coverImage[0]?.path;
  let coverImageLocalPath;
  if (
    req.files &&
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
  const avatar = await uploadOnCloudinary(avatarLocalPath);
  const coverImage = await uploadOnCloudinary(coverImageLocalPath);

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

export { registerUser, loginUser, logoutUser, refreshAccessToken };
