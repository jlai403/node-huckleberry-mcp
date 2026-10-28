import { z } from "zod";

// The eight app activity modes sharing one timer rack on activities/{cid}.
export const ACTIVITY_MODES = [
  "bath",
  "brushTeeth",
  "indoorPlay",
  "outdoorPlay",
  "screenTime",
  "skinToSkin",
  "storyTime",
  "tummyTime",
] as const;

export type ActivityMode = (typeof ACTIVITY_MODES)[number];

export const ActivityModeSchema = z.enum(ACTIVITY_MODES);

// `prefs.last{Bath|BrushTeeth|...}` lookup used to write the mode summary.
export const ACTIVITY_LAST_FIELD_BY_MODE: Record<ActivityMode, string> = {
  bath: "lastBath",
  brushTeeth: "lastBrushTeeth",
  indoorPlay: "lastIndoorPlay",
  outdoorPlay: "lastOutdoorPlay",
  screenTime: "lastScreenTime",
  skinToSkin: "lastSkinToSkin",
  storyTime: "lastStoryTime",
  tummyTime: "lastTummyTime",
};

// Activity interval (activities/{cid}/intervals). Read model — lenient.
export const ActivityInterval = z
  .object({
    mode: z.string(),
    start: z.number(),
    offset: z.number().optional(),
    end_offset: z.number().optional(),
    duration: z.number().optional(),
    notes: z.string().optional(),
    lastUpdated: z.number().optional(),
  })
  .passthrough();

export type ActivityIntervalParsed = z.infer<typeof ActivityInterval>;

// One mode's timer entry (activities/{cid}.timer.{mode}). Whole-second
// `duration` (rounding: (ms+500)//1000); startTime/endTime in epoch ms.
export const ActivityTimerEntry = z
  .object({
    active: z.boolean().default(false),
    paused: z.boolean().default(false),
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    duration: z.number().optional(),
    notes: z.string().optional(),
    uuid: z.string().optional(),
    timestamp: z.object({ seconds: z.number() }).passthrough().optional(),
    local_timestamp: z.number().optional(),
  })
  .passthrough();

export type ActivityTimerEntryParsed = z.infer<typeof ActivityTimerEntry>;

// activities/{cid} parent document as the timer tools see it. `timer` is a map
// of mode → timer entry (only active or previously-run modes present).
export const ActivityDocument = z
  .object({
    timer: z.record(z.string(), ActivityTimerEntry).optional(),
    prefs: z.object({}).passthrough().optional(),
  })
  .passthrough();

export type ActivityDocumentParsed = z.infer<typeof ActivityDocument>;
