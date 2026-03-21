import mongoose, { Schema } from "mongoose";

const watchHistorySchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        videoId: {
            type: Schema.Types.ObjectId,
            ref: "Video",
            required: true,
            index: true,
        },
        rewatchCount: { type: Number, default: 0 },
        lastPositionSeconds: { type: Number, default: 0 },
        watchedPercent: {
            type: Number,
            required: true,
            default: 0,
            min: [0, "watchedPercent cannot be negative"],
            max: [100, "watchedPercent cannot exceed 100"],
        },
        watchedAt: {
            type: Date,
            default: Date.now, // IMPORTANT: Write Date.now, NOT Date.now() — without parentheses!
        },
    },

    {
        timestamps: true,
    },
);

watchHistorySchema.index({ userId: 1, videoId: 1 }, { unique: true });
watchHistorySchema.index({ userId: 1, watchedAt: -1 });

export const WatchHistory = mongoose.model("WatchHistory", watchHistorySchema);
