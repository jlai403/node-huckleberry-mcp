// Activity timer + interval ops: port of py-huckleberry-api's activities path.
// Unlike the sleep/pump/feed timers, the "rack" is one doc — activities/{cid} —
// with a map `timer.{mode}`. Exactly one mode may be active; switching modes
// transfers the running timer instead of erroring.

import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  startAfter,
} from "firebase/firestore";
import { Timestamp as FirestoreTimestamp } from "firebase/firestore";
import type { HuckleberryClient } from "./HuckleberryClient.js";
import {
  ActivityDocument,
  ActivityModeSchema,
  ActivityInterval,
  ACTIVITY_LAST_FIELD_BY_MODE,
  type ActivityIntervalParsed,
  ActivityDocumentParsed,
  type ActivityMode,
  type ActivityTimerEntryParsed,
} from "../models/index.js";
import { writeIntervalWithPrefs } from "./prefs.js";

function newSessionUuid(len = 16): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

/** One mode's timer entry, or null. */
function modeTimer(
  activities: ActivityDocumentParsed,
  mode: ActivityMode,
): ActivityTimerEntryParsed | null {
  return activities.timer?.[mode] ?? null;
}

/** The (single) active mode across the rack, if any — port of _active_activity_mode. */
export function activeActivityMode(activities: ActivityDocumentParsed): ActivityMode | null {
  for (const mode of Object.keys(ACTIVITY_LAST_FIELD_BY_MODE) as ActivityMode[]) {
    const timer = modeTimer(activities, mode);
    if (timer?.active) return mode;
  }
  return null;
}

/** The app reuses one shared activity uuid across modes — port of _activity_uuid. */
export function sharedActivityUuid(activities: ActivityDocumentParsed): string {
  for (const mode of Object.keys(ACTIVITY_LAST_FIELD_BY_MODE) as ActivityMode[]) {
    const timer = modeTimer(activities, mode);
    if (timer?.uuid) return timer.uuid;
  }
  return newSessionUuid();
}

/** Whole-second elapsed like the app: (ms + 500) // 1000. */
function roundedDuration(startMs: number, endMs: number): number {
  const elapsed = endMs - startMs;
  if (elapsed < 0) throw new Error("Activity end time must not precede start time");
  return Math.floor((elapsed + 500) / 1000);
}

export async function getActivityDoc(
  client: HuckleberryClient,
  childUid: string,
): Promise<ActivityDocumentParsed> {
  await client.connect();
  const db = client.getFirestore();
  const snap = await getDoc(doc(db, "activities", childUid));
  if (!snap.exists()) return { timer: undefined } as ActivityDocumentParsed;
  return ActivityDocument.parse(snap.data());
}

export interface StartActivityOptions {
  time?: Date;
}

export async function startActivity(
  client: HuckleberryClient,
  childUid: string,
  mode: ActivityMode,
  options: StartActivityOptions = {},
): Promise<{ moved: boolean }> {
  mode = ActivityModeSchema.parse(mode);
  await client.connect();
  const db = client.getFirestore();
  const ref = doc(db, "activities", childUid);
  const activities = await getActivityDoc(client, childUid);
  const activeMode = activeActivityMode(activities);
  const nowMs = Date.now();
  const now = nowMs / 1000;
  const requestedMs = options.time ? options.time.getTime() : undefined;

  if (activeMode === mode) {
    if (requestedMs === undefined) return { moved: false };
    const timer = modeTimer(activities, mode);
    if (!timer) return { moved: false } as const;
    if (timer.paused && timer.endTime !== undefined && requestedMs > timer.endTime) {
      throw new Error("start must not be after the paused activity end time");
    }
    const updateData: Record<string, unknown> = {
      startTime: requestedMs,
      timestamp: { seconds: now },
      local_timestamp: now,
    };
    if (timer.paused && timer.endTime !== undefined) {
      updateData.duration = roundedDuration(requestedMs, timer.endTime);
    }
    await setDoc(ref, { timer: { [mode]: updateData } }, { merge: true });
    return { moved: true };
  }
  if (activeMode !== null) {
    throw new Error(`${activeMode} is already active; use switch_activity`);
  }

  await setDoc(
    ref,
    {
      timer: {
        [mode]: {
          active: true,
          paused: false,
          timestamp: { seconds: now },
          local_timestamp: now,
          startTime: requestedMs ?? nowMs,
          duration: 0,
          notes: "",
          uuid: sharedActivityUuid(activities),
        },
      },
    },
    { merge: true },
  );
  return { moved: false };
}

export async function pauseActivity(
  client: HuckleberryClient,
  childUid: string,
  mode: ActivityMode,
): Promise<void> {
  mode = ActivityModeSchema.parse(mode);
  await client.connect();
  const db = client.getFirestore();
  const ref = doc(db, "activities", childUid);
  const activities = await getActivityDoc(client, childUid);
  const timer = modeTimer(activities, mode);
  if (!timer?.active || timer.paused) return;
  if (timer.startTime === undefined) {
    throw new Error("Active activity timer is missing startTime");
  }

  const nowMs = Date.now();
  const duration = roundedDuration(timer.startTime, nowMs);
  await setDoc(
    ref,
    {
      timer: {
        [mode]: {
          active: true,
          paused: true,
          timestamp: { seconds: nowMs / 1000 },
          local_timestamp: nowMs / 1000,
          duration,
          endTime: timer.startTime + duration * 1000,
        },
      },
    },
    { merge: true },
  );
}

export async function resumeActivity(
  client: HuckleberryClient,
  childUid: string,
  mode: ActivityMode,
): Promise<void> {
  mode = ActivityModeSchema.parse(mode);
  await client.connect();
  const db = client.getFirestore();
  const ref = doc(db, "activities", childUid);
  const activities = await getActivityDoc(client, childUid);
  const timer = modeTimer(activities, mode);
  if (!timer?.active || !timer.paused) return;
  if (timer.startTime === undefined) {
    throw new Error("Active activity timer is missing startTime");
  }

  const nowMs = Date.now();
  await setDoc(
    ref,
    {
      timer: {
        [mode]: {
          active: true,
          paused: false,
          timestamp: { seconds: nowMs / 1000 },
          local_timestamp: nowMs / 1000,
          duration: roundedDuration(timer.startTime, nowMs),
        },
      },
    },
    { merge: true },
  );
}

export interface CompleteActivityResult {
  startSec: number;
  duration: number;
}

export interface CompleteActivityOptions {
  /** Corrects the saved interval start. */
  start?: Date;
  /** Corrects the end (derived to whole-second duration). Mutually exclusive with `duration`. */
  end?: Date;
  /** Explicit duration in seconds. Mutually exclusive with `end`. */
  duration?: number;
  notes?: string;
}

export async function completeActivity(
  client: HuckleberryClient,
  childUid: string,
  mode: ActivityMode,
  options: CompleteActivityOptions = {},
): Promise<CompleteActivityResult | null> {
  mode = ActivityModeSchema.parse(mode);
  if (options.end !== undefined && options.duration !== undefined) {
    throw new Error("Provide either end or duration, not both");
  }
  if (options.duration !== undefined && (!Number.isFinite(options.duration) || options.duration < 0)) {
    throw new Error("duration must be a non-negative finite number");
  }

  await client.connect();
  const db = client.getFirestore();
  const ref = doc(db, "activities", childUid);
  const activities = await getActivityDoc(client, childUid);
  const timer = modeTimer(activities, mode);
  if (!timer?.active) return null;

  const nowMs = Date.now();
  const resolvedStartSec = options.start
    ? options.start.getTime() / 1000
    : timer.startTime !== undefined
      ? timer.startTime / 1000
      : undefined;
  if (resolvedStartSec === undefined) {
    throw new Error("Active activity timer is missing startTime");
  }
  const resolvedStartMs = resolvedStartSec * 1000;

  let resolvedDuration: number;
  if (options.end !== undefined) {
    resolvedDuration = roundedDuration(resolvedStartMs, options.end.getTime());
  } else if (options.duration !== undefined) {
    resolvedDuration = options.duration;
  } else if (timer.paused) {
    resolvedDuration = timer.duration ?? 0;
  } else {
    resolvedDuration = roundedDuration(resolvedStartMs, nowMs);
  }

  await logActivity(client, childUid, {
    mode,
    start: resolvedStartSec,
    duration: resolvedDuration,
    notes: options.notes,
  });

  // Inactive reset retains the frozen timeline (upstream _reset_activity_timer).
  const resetStartMs = timer.startTime ?? resolvedStartMs;
  await setDoc(
    ref,
    {
      timer: {
        [mode]: {
          active: false,
          paused: false,
          timestamp: { seconds: nowMs / 1000 },
          local_timestamp: nowMs / 1000,
          startTime: nowMs,
          endTime: resetStartMs + resolvedDuration * 1000,
          duration: resolvedDuration,
          notes: timer.notes ?? "",
          uuid: timer.uuid,
        },
      },
    },
    { merge: true },
  );

  return { startSec: resolvedStartSec, duration: resolvedDuration };
}

export async function switchActivity(
  client: HuckleberryClient,
  childUid: string,
  mode: ActivityMode,
): Promise<{ switched: boolean }> {
  mode = ActivityModeSchema.parse(mode);

  await client.connect();
  const db = client.getFirestore();
  const ref = doc(db, "activities", childUid);
  const activities = await getActivityDoc(client, childUid);
  const sourceMode = activeActivityMode(activities);
  if (sourceMode === null || sourceMode === mode) return { switched: false };

  const source = modeTimer(activities, sourceMode);
  if (!source) return { switched: false };
  if (source.startTime === undefined) {
    throw new Error("Active activity timer is missing startTime");
  }

  const nowMs = Date.now();
  const now = nowMs / 1000;
  const duration =
    source.paused
      ? (source.duration ?? 0)
      : roundedDuration(source.startTime, nowMs);
  const target: Record<string, unknown> = {
    active: true,
    paused: source.paused,
    timestamp: { seconds: now },
    local_timestamp: now,
    startTime: source.startTime,
    duration,
    notes: source.notes ?? "",
    uuid: source.uuid,
  };
  if (source.paused && source.endTime !== undefined) {
    target.endTime = source.endTime;
  }

  await setDoc(
    ref,
    {
      timer: {
        [sourceMode]: {
          active: false,
          paused: false,
          timestamp: { seconds: now },
          local_timestamp: now,
          startTime: nowMs,
        },
        [mode]: target,
      },
    },
    { merge: true },
  );
  return { switched: true };
}

export async function cancelActivity(
  client: HuckleberryClient,
  childUid: string,
  mode: ActivityMode,
): Promise<void> {
  mode = ActivityModeSchema.parse(mode);
  await client.connect();
  const db = client.getFirestore();
  const ref = doc(db, "activities", childUid);
  const activities = await getActivityDoc(client, childUid);
  const timer = modeTimer(activities, mode);
  if (!timer?.active) return;
  if (timer.startTime === undefined) {
    throw new Error("Active activity timer is missing startTime");
  }

  const nowMs = Date.now();
  const duration = timer.paused
    ? Math.floor(timer.duration ?? 0)
    : roundedDuration(timer.startTime, nowMs);

  // Same inactive shape as complete (frozen timeline, original uuid kept).
  const resetStartMs = timer.startTime;
  await setDoc(
    ref,
    {
      timer: {
        [mode]: {
          active: false,
          paused: false,
          timestamp: { seconds: nowMs / 1000 },
          local_timestamp: nowMs / 1000,
          startTime: nowMs,
          endTime: resetStartMs + duration * 1000,
          duration,
          notes: timer.notes ?? "",
          uuid: timer.uuid,
        },
      },
    },
    { merge: true },
  );
}

export interface LogActivityOptions {
  mode: ActivityMode;
  start: number;
  duration?: number;
  notes?: string;
  /** Only fires from complete (no timer reset needed). Internal. */
  skipTimerReset?: boolean;
}

/**
 * Logs an activity entry. When a timer for that mode is active, resets it after
 * logging (matching the py `update_timer=True` default path).
 */
export async function logActivity(
  client: HuckleberryClient,
  childUid: string,
  options: LogActivityOptions,
): Promise<string> {
  const mode = ActivityModeSchema.parse(options.mode);
  if (options.duration !== undefined && (!Number.isFinite(options.duration) || options.duration < 0)) {
    throw new Error("duration must be a non-negative finite number");
  }

  const eventDate = new Date();
  const offset = client.getOffsetMinutes(eventDate);
  const lastUpdated = Date.now() / 1000;
  const lastField = ACTIVITY_LAST_FIELD_BY_MODE[options.mode];

  const result = await writeIntervalWithPrefs(client, {
    collectionName: "activities",
    subcollection: "intervals",
    childUid,
    interval: {
      mode: options.mode,
      start: options.start,
      offset,
      end_offset: offset,
      ...(options.duration !== undefined && { duration: options.duration }),
      ...(options.notes !== undefined && { notes: options.notes }),
      lastUpdated,
    },
    prefs: {
      [lastField]: {
        start: options.start,
        offset,
        ...(options.duration !== undefined && { duration: options.duration }),
        end_offset: offset,
      },
    },
  });

  // Timer-driven logs reset their rack entry (py update_timer=True).
  const activities = await getActivityDoc(client, childUid);
  const timer = modeTimer(activities, options.mode);
  if (timer?.active && options.skipTimerReset !== true) {
    const nowMs = Date.now();
    const now = nowMs / 1000;
    await setDoc(
      doc(client.getFirestore(), "activities", childUid),
      {
        timer: {
          [options.mode]: {
            active: false,
            paused: false,
            timestamp: { seconds: now },
            local_timestamp: now,
            startTime: nowMs,
            duration: options.duration ?? 0,
            notes: "",
            uuid: sharedActivityUuid(activities),
          },
        },
      },
      { merge: true },
    );
  }

  void mode;
  return result;
}

export interface ActivityHistoryOptions {
  /** Range start (epoch seconds, inclusive). */
  start: number;
  /** Range end (epoch seconds, exclusive). */
  end: number;
}

/**
 * Activity intervals in a date range; `multi` container docs are skipped
 * (upstream behavior). Timestamps come back epoch seconds.
 */
export async function listActivityIntervals(
  client: HuckleberryClient,
  childUid: string,
  options: ActivityHistoryOptions,
): Promise<(ActivityIntervalParsed & { id: string })[]> {
  await client.connect();
  const db = client.getFirestore();
  const intervals = collection(db, "activities", childUid, "intervals");
  const regular = await getDocs(
    query(
      intervals,
      where("start", ">=", options.start),
      where("start", "<", options.end),
      orderBy("start", "asc"),
    ),
  );

  const events: (ActivityIntervalParsed & { id: string })[] = [];
  for (const snap of regular.docs) {
    const data = snap.data();
    if (!data || data.multi) continue;
    events.push({ id: snap.id, ...ActivityInterval.parse(data) });
  }

  // Multi-doc entries (interval groups) are skipped, matching upstream.
  void startAfter;
  void FirestoreTimestamp;
  return events;
}
