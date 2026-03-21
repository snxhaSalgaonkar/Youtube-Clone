// Using zod for runtime request body validation
import { z } from "zod";

const watchHistorySchema = z.object({
  videoId: z.string().min(1),
  watchedPercent: z.number().min(0).max(100),
  lastPositionSeconds: z.number().min(0).optional(),
});
