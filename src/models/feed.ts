import { z } from "zod";

// Typed references for the write side (the tools validate their own inputs).
export const NursingInterval = z.object({
  mode: z.literal("breast"),
  start: z.number(),
  offset: z.number(),
  leftDuration: z.number().optional(),
  rightDuration: z.number().optional(),
  lastSide: z.enum(["left", "right"]).optional(),
  notes: z.string().optional(),
  lastUpdated: z.number().optional(),
});

export const BottleInterval = z.object({
  mode: z.literal("bottle"),
  start: z.number(),
  offset: z.number(),
  amount: z.number(),
  bottleType: z.string(),
  units: z.enum(["ml", "oz"]),
  notes: z.string().optional(),
  lastUpdated: z.number().optional(),
});

export const SolidsInterval = z.object({
  mode: z.literal("solids"),
  start: z.number(),
  offset: z.number(),
  notes: z.string().optional(),
  lastUpdated: z.number().optional(),
});

// Read model for feed/{cid}/intervals — lenient so any feed entry parses
// regardless of `mode` or which optional fields are present. `mode` is a free
// string (not a discriminated union) and unknown fields pass through.
export const FeedingInterval = z
  .object({
    mode: z.string(),
    start: z.number(),
    offset: z.number().optional(),
    lastUpdated: z.number().optional(),
    // nursing
    leftDuration: z.number().optional(),
    rightDuration: z.number().optional(),
    lastSide: z.string().optional(),
    // bottle
    amount: z.number().optional(),
    bottleType: z.string().optional(),
    units: z.string().optional(),
    // shared
    notes: z.string().optional(),
  })
  .passthrough();

export type NursingIntervalParsed = z.infer<typeof NursingInterval>;
export type BottleIntervalParsed = z.infer<typeof BottleInterval>;
export type SolidsIntervalParsed = z.infer<typeof SolidsInterval>;
export type FeedingIntervalParsed = z.infer<typeof FeedingInterval>;

// Live nursing timer (feed/{cid}.timer). Read model — lenient; states are
// re-validated by the timer ops before acting.
// NOTE: timerStartTime/feedStartTime are epoch SECONDS here (sleep/pump use ms).
export const FeedTimer = z
  .object({
    active: z.boolean().default(false),
    paused: z.boolean().default(false),
    feedStartTime: z.number().nullable().optional(),
    timerStartTime: z.number().nullable().optional(),
    leftDuration: z.number().optional(),
    rightDuration: z.number().optional(),
    // "none" marks a paused/transitioning segment (app convention).
    lastSide: z.string().optional(),
    activeSide: z.string().optional(),
    uuid: z.string().optional(),
    timestamp: z.object({ seconds: z.number() }).passthrough().optional(),
    local_timestamp: z.number().optional(),
  })
  .passthrough();

export type FeedTimerParsed = z.infer<typeof FeedTimer>;

// feed/{cid} parent document as the timer tools see it.
export const FeedDocument = z
  .object({
    timer: FeedTimer.optional(),
    prefs: z.object({}).passthrough().optional(),
  })
  .passthrough();

export type FeedDocumentParsed = z.infer<typeof FeedDocument>;
