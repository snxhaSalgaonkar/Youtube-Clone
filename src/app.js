import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoSanitize from "express-mongo-sanitize";

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json({ limit: "16kb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));
app.use(express.static("public"));
app.use(cookieParser());
//app.use(mongoSanitize({ replaceWith: "_", onSanitize: ({ req, key }) => {} }));
app.use((req, res, next) => {
  if (req.body) {
    req.body = mongoSanitize.sanitize(req.body, { replaceWith: "_" });
  }
  if (req.params) {
    req.params = mongoSanitize.sanitize(req.params, { replaceWith: "_" });
  }
  if (req.query) {
    // ✅ Never reassign req.query — mutate its properties in place instead
    const sanitized = mongoSanitize.sanitize(
      { ...req.query },
      { replaceWith: "_" },
    );
    Object.keys(req.query).forEach((key) => delete req.query[key]);
    Object.assign(req.query, sanitized);
  }
  next();
});
// app.get("/", (req, res) => {
//     res.send("Hello World!")
// })

//routes import
import userRouter from "./routes/user.routes.js";

//routes declaration
app.use("/api/v1/users", userRouter);
//http://localhiost:8000/api/v1/users/register

import videoRouter from "./routes/video.routes.js";
app.use("/api/v1/videos", videoRouter);

import commentRouter from "./routes/comment.routes.js";
app.use("/api/v1/comments", commentRouter);

import likeRouter from "./routes/like.routes.js";
app.use("/api/v1/likes", likeRouter);

import SubscriptionRouter from "./routes/Subscription.routes.js";
app.use("/api/v1/Subscription", SubscriptionRouter);

import PlaylistRouter from "./routes/playlist.route.js";
app.use("api/v1/Playlist", PlaylistRouter);
// import watchHistoryRouter from "./routes/watchHistory.route.js";
// app.use("/api/v1/watch-history", watchHistoryRouter);

import { globalErrorHandler } from "./middlewares/Errorhandler.middlewar.js";
app.use(globalErrorHandler);

// ✅ This MUST be at the very bottom of app.js, after all routes
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";
  return res.status(statusCode).json({
    success: false,
    message,
  });
});

export default app;
