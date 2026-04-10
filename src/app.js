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
app.use(mongoSanitize());

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

export default app;
