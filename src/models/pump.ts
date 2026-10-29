import { z } from "zod";

// Pump interval (pump/{cid}/intervals). Read model — lenient: `entryMode` and
// `units` are free strings (not enums), amounts/duration/offset are optional,
// and unknown fields pass through. Only `start` is required.
export const PumpInterval = z
  .object({
    entryMode: z.string().optional(),
    start: z.number(),
    offset: z.number().optional(),
    leftAmount: z.number().optional(),
    rightAmount: z.number().optional(),
    units: z.string().optional(),
    duration: z.number().optional(),
    notes: z.string().optional(),
    lastUpdated: z.number().optional(),
  })
  .passthrough();

export type PumpIntervalParsed = z.infer<typeof PumpInterval>;

// Live pump timer (pump/{cid}.timer). Read model — lenient.
// NOTE: startTime/endTime are epoch MILLISECONDS (like sleep).
export const PumpTimer = z
  .object({
    active: z.boolean().default(false),
    paused: z.boolean().default(false),
    // ms; reset leaves null, not absent (dump-observed).
    startTime: z.number().nullable().optional(),
    endTime: z.number().nullable().optional(),
    units: z.string().optional(),
    uuid: z.string().optional(),
    timestamp: z.object({ seconds: z.number() }).passthrough().optional(),
    local_timestamp: z.number().optional(),
  })
  .passthrough();

export type PumpTimerParsed = z.infer<typeof PumpTimer>;

// pump/{cid} parent document as the timer tools see it.
export const PumpDocument = z
  .object({
    timer: PumpTimer.optional(),
    prefs: z.object({}).passthrough().optional(),
  })
  .passthrough();

export type PumpDocumentParsed = z.infer<typeof PumpDocument>;
