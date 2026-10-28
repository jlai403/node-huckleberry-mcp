// Data models for Huckleberry Firestore documents
// Zod-based validation schemas per docs/schema-port-spec.md

export { FirebaseUserDocument, ChildListEntry } from "./user.js";
export type { FirebaseUserDocumentParsed, ChildListEntryParsed } from "./user.js";

export { ChildDocument } from "./child.js";
export type { ChildDocumentParsed } from "./child.js";

export { SleepInterval, SleepTimer, SleepDocument } from "./sleep.js";
export type { SleepIntervalParsed, SleepTimerParsed, SleepDocumentParsed } from "./sleep.js";

export {
  NursingInterval,
  BottleInterval,
  SolidsInterval,
  FeedingInterval,
  FeedTimer,
  FeedDocument,
} from "./feed.js";
export type {
  NursingIntervalParsed,
  BottleIntervalParsed,
  SolidsIntervalParsed,
  FeedingIntervalParsed,
  FeedTimerParsed,
  FeedDocumentParsed,
} from "./feed.js";

export { PumpInterval, PumpTimer, PumpDocument } from "./pump.js";
export type { PumpIntervalParsed, PumpTimerParsed, PumpDocumentParsed } from "./pump.js";

export {
  ACTIVITY_MODES,
  ACTIVITY_LAST_FIELD_BY_MODE,
  ActivityModeSchema,
  ActivityInterval,
  ActivityTimerEntry,
  ActivityDocument,
} from "./activity.js";
export type {
  ActivityMode,
  ActivityIntervalParsed,
  ActivityTimerEntryParsed,
  ActivityDocumentParsed,
} from "./activity.js";

export { DiaperInterval } from "./diaper.js";
export type { DiaperIntervalParsed } from "./diaper.js";

export { GrowthEntry } from "./growth.js";
export type { GrowthEntryParsed } from "./growth.js";

export { CustomFood } from "./food.js";
export type { CustomFoodParsed } from "./food.js";
