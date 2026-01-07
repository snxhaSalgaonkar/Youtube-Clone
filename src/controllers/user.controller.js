import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from "../models/user.model.js";
import { uploadOnCloudinary } from "../utils/cloudinary.js";
import { ApiResponse } from "../utils/ApiResponse.js";

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
  console.log("***********");
  console.log("data  ", email);

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

export { registerUser };
