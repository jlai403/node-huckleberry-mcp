import { z } from "zod";

// Sleep interval (sleep/{cid}/intervals). Read model — lenient so real entries
// never fail to parse: only `start` is required; everything else is optional and
// unknown fields pass through.
export const SleepInterval = z
  .object({
    start: z.number(),
    duration: z.number().optional(),
    offset: z.number().optional(),
    lastUpdated: z.number().optional(),
    notes: z.string().optional(),
    _id: z.string().optional(),
  })
  .passthrough();

export type SleepIntervalParsed = z.infer<typeof SleepInterval>;

// Live sleep timer (sleep/{cid}.timer). Read model — lenient: the app treats a
// missing or half-populated timer the same way, so nothing fails to parse; the
// timer tools re-validate state themselves before acting.
export const SleepTimer = z
  .object({
    active: z.boolean().default(false),
    paused: z.boolean().default(false),
    // Epoch milliseconds (unlike feed's seconds timerStartTime).
    timerStartTime: z.number().optional(),
    timerEndTime: z.number().optional(),
    uuid: z.string().optional(),
    timestamp: z.object({ seconds: z.number() }).passthrough().optional(),
    local_timestamp: z.number().optional(),
    details: z.object({}).passthrough().optional(),
  })
  .passthrough();

export type SleepTimerParsed = z.infer<typeof SleepTimer>;

// sleep/{cid} parent document as the timer tools see it.
export const SleepDocument = z
  .object({
    timer: SleepTimer.optional(),
    prefs: z.object({}).passthrough().optional(),
  })
  .passthrough();

export type SleepDocumentParsed = z.infer<typeof SleepDocument>;
