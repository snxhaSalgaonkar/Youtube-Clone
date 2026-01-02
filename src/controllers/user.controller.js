import { asyncHandler } from "../utils/asyncHandler.js";

const registerUser = asyncHandler(async (req, res) => {
  res.status(200).json({
    message: "ok from Sneha controller",
    heelo: "hello from controller",
  });
});

export { registerUser };
