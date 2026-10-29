import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  deleteField,
  query,
  orderBy,
  limit,
} from "firebase/firestore";
import type { HuckleberryClient } from "./HuckleberryClient.js";
import {
  SleepInterval,
  SleepDocument,
  type SleepIntervalParsed,
  type SleepTimerParsed,
} from "../models/index.js";
import { writeIntervalWithPrefs } from "./prefs.js";

export interface LogSleepOptions {
  /** Override time (defaults to now). */
  time?: Date;
  /** Free-text note attached to the entry. */
  notes?: string;
}

/**
 * Logs a completed sleep session with explicit start and end times.
 * Returns the new document ID.
 */
export async function logSleep(
  client: HuckleberryClient,
  childUid: string,
  startDate: Date,
  endDate: Date,
  options: LogSleepOptions = {},
): Promise<string> {
  const eventDate = options.time ?? new Date();
  const start = startDate.getTime() / 1000;
  const end = endDate.getTime() / 1000;
  const duration = end - start;
  const offset = client.getOffsetMinutes(eventDate);
  const lastUpdated = Date.now() / 1000;

  return writeIntervalWithPrefs(client, {
    collectionName: "sleep",
    subcollection: "intervals",
    childUid,
    interval: {
      start,
      duration,
      offset,
      ...(options.notes !== undefined && { notes: options.notes }),
      lastUpdated,
    },
    prefs: {
      lastSleep: {
        start,
        offset,
        duration,
      },
    },
  });
}

export interface SleepHistoryOptions {
  /** Maximum number of records to return (default: 50). */
  limit?: number;
}

/**
 * Returns sleep intervals for a child, ordered by start descending. Each entry
 * includes its Firestore doc `id` so it can be referenced by `editSleep`.
 */
export async function getSleepHistory(
  client: HuckleberryClient,
  childUid: string,
  options: SleepHistoryOptions = {},
): Promise<(SleepIntervalParsed & { id: string })[]> {
  await client.connect();
  const db = client.getFirestore();
  const col = collection(db, "sleep", childUid, "intervals");
  const q = query(col, orderBy("start", "desc"), limit(options.limit ?? 50));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...SleepInterval.parse(d.data()) }));
}

// ── Edit sleep ───────────────────────────────────────────────────────────────

export interface EditSleepOptions {
  /** Event start (epoch seconds). */
  start?: number;
  /** Duration in seconds. */
  duration?: number;
  notes?: string;
}

/**
 * Updates fields on an existing sleep interval (`sleep/{cid}/intervals/{id}`).
 * Only the provided fields are changed; `lastUpdated` is bumped. The interval id
 * comes from `getSleepHistory`. Does not touch the parent `prefs` summary.
 */
export async function editSleep(
  client: HuckleberryClient,
  childUid: string,
  intervalId: string,
  updates: EditSleepOptions,
): Promise<void> {
  const patch: Record<string, unknown> = {
    ...(updates.start !== undefined && { start: updates.start }),
    ...(updates.duration !== undefined && { duration: updates.duration }),
    ...(updates.notes !== undefined && { notes: updates.notes }),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error("editSleep requires at least one field to update");
  }
  patch.lastUpdated = Date.now() / 1000;

  await client.connect();
  const db = client.getFirestore();
  await updateDoc(doc(db, "sleep", childUid, "intervals", intervalId), patch);
}

// ── Delete sleep ─────────────────────────────────────────────────────────────
/**
 * Permanently deletes a sleep interval (`sleep/{cid}/intervals/{id}`). The id
 * comes from `getSleepHistory`. Does **not** recompute the parent `prefs.lastSleep`
 * summary, so it may briefly still reference a deleted entry until the next write.
 */
export async function deleteSleep(
  client: HuckleberryClient,
  childUid: string,
  intervalId: string,
): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  await deleteDoc(doc(db, "sleep", childUid, "intervals", intervalId));
}

// ── Live sleep timer ─────────────────────────────────────────────────────────
// Port of py-huckleberry-api's sleep timer path: the "timer" is a document
// field; completing writes an interval doc + resets the timer to inactive,
// mirroring what the Huckleberry app does on its stop action.

/** Loads sleep/{childUid} and validates its timer state (missing doc → null timer). */
export async function getSleepDoc(
  client: HuckleberryClient,
  childUid: string,
): Promise<{ timer: SleepTimerParsed | null }> {
  await client.connect();
  const db = client.getFirestore();
  const snap = await getDoc(doc(db, "sleep", childUid));
  if (!snap.exists()) return { timer: null };
  const parsed = SleepDocument.parse(snap.data());
  return { timer: parsed.timer ?? null };
}

function newSessionUuid(): string {
  // App-shaped session id: 16 hex chars.
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 16; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

function nowSeconds(): { ts: { seconds: number }; local: number } {
  const now = Date.now() / 1000;
  return { ts: { seconds: now }, local: now };
}

/** Starts the sleep timer; on an active timer with explicit start moves its start. */
export async function startSleep(
  client: HuckleberryClient,
  childUid: string,
  options: { time?: Date } = {},
): Promise<{ moved: boolean }> {
  await client.connect();
  const db = client.getFirestore();
  const sleepRef = doc(db, "sleep", childUid);
  const { timer } = await getSleepDoc(client, childUid);
  const { ts, local } = nowSeconds();
  const startMs = options.time ? options.time.getTime() : Date.now();

  if (timer?.active) {
    if (!options.time) return { moved: false };
    if (timer.paused && timer.timerEndTime != null && startMs > timer.timerEndTime) {
      throw new Error("start must not be after the paused sleep end time");
    }
    await updateDoc(sleepRef, {
      "timer.timerStartTime": startMs,
      "timer.timestamp": ts,
      "timer.local_timestamp": local,
    });
    return { moved: true };
  }

  // App default details: all-false condition/location flags (presence, not
  // truth, is what the app UI expects).
  const timerPatch = {
    active: true,
    paused: false,
    timestamp: ts,
    local_timestamp: local,
    timerStartTime: startMs,
    uuid: timer?.uuid ?? newSessionUuid(),
    details: timer?.details ?? {
      startSleepCondition: {
        happy: false,
        longTimeToFallAsleep: false,
        "10-20_minutes": false,
        upset: false,
        under_10_minutes: false,
      },
      sleepLocations: {
        car: false,
        nursing: false,
        wornOrHeld: false,
        stroller: false,
        coSleep: false,
        nextToCarer: false,
        onOwnInBed: false,
        bottle: false,
        swing: false,
      },
      endSleepCondition: { happy: false, wokeUpChild: false, upset: false },
    },
  };
  await setDoc(sleepRef, { timer: timerPatch }, { merge: true });
  return { moved: false };
}

/** Pauses the active sleep timer by stamping timerEndTime (epoch ms). */
export async function pauseSleep(client: HuckleberryClient, childUid: string): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const sleepRef = doc(db, "sleep", childUid);
  const { timer } = await getSleepDoc(client, childUid);
  if (!timer?.active || timer.paused) return;

  const now = Date.now();
  await updateDoc(sleepRef, {
    "timer.paused": true,
    "timer.active": true,
    "timer.timerEndTime": now,
    "timer.timestamp": { seconds: now / 1000 },
    "timer.local_timestamp": now / 1000,
  });
}

/** Resumes a paused sleep timer (leaves timerEndTime for resume app parity). */
export async function resumeSleep(client: HuckleberryClient, childUid: string): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const sleepRef = doc(db, "sleep", childUid);
  const { timer } = await getSleepDoc(client, childUid);
  if (!timer?.active || !timer.paused) return;

  const { ts, local } = nowSeconds();
  await updateDoc(sleepRef, {
    "timer.paused": false,
    "timer.active": true,
    "timer.timestamp": ts,
    "timer.local_timestamp": local,
  });
}

/** Cancels without saving an interval; keeps the timer doc (app expects it to remain). */
export async function cancelSleep(client: HuckleberryClient, childUid: string): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const sleepRef = doc(db, "sleep", childUid);
  const { timer } = await getSleepDoc(client, childUid);
  const { ts, local } = nowSeconds();

  await updateDoc(sleepRef, {
    timer: {
      active: false,
      paused: false,
      timestamp: ts,
      timerStartTime: null,
      uuid: timer?.uuid ?? newSessionUuid(),
      local_timestamp: local,
    },
  });
}

export interface CompleteSleepOptions {
  /** Replaces the timer's start in the saved interval. */
  start?: Date;
  /** Replaces the end; defaults to paused timerEnd, else now. */
  end?: Date;
  /** Replaces the timer's app details block on the saved interval. */
  details?: Record<string, unknown>;
}

/**
 * Completes the active sleep timer: writes the interval to
 * sleep/{cid}/intervals (seconds-based) and resets the timer to inactive.
 * An inactive/missing timer is a no-op (duplicate-complete safe).
 */
export async function completeSleep(
  client: HuckleberryClient,
  childUid: string,
  options: CompleteSleepOptions = {},
): Promise<{ startSec: number; durationSec: number } | null> {
  await client.connect();
  const db = client.getFirestore();
  const sleepRef = doc(db, "sleep", childUid);
  const { timer } = await getSleepDoc(client, childUid);
  if (!timer?.active) return null;

  let startMs = timer.timerStartTime ?? undefined;
  if (options.start) startMs = options.start.getTime();
  if (startMs === undefined) {
    const sec = timer.timestamp?.seconds;
    if (sec) {
      startMs = sec * 1000;
    } else {
      // App parity: drop a broken timer rather than saving a garbage interval.
      await updateDoc(sleepRef, { timer: deleteField() });
      return null;
    }
  }

  const pausedEnd = timer.paused && timer.timerEndTime != null ? timer.timerEndTime : undefined;
  const endMs = options.end ? options.end.getTime() : (pausedEnd ?? Date.now());
  if (endMs < startMs) {
    throw new Error("end must not precede start");
  }

  const startSec = Math.floor(startMs / 1000);
  const durationSec = Math.floor((endMs - startMs) / 1000);
  const offset = client.getOffsetMinutes(new Date());
  const { ts, local } = nowSeconds();

  const interval = {
    start: startSec,
    duration: durationSec,
    offset,
    end_offset: offset,
    ...(options.details !== undefined
      ? { details: options.details }
      : timer.details !== undefined
        ? { details: timer.details }
        : {}),
    lastUpdated: local,
  };

  const intervalId = await writeIntervalWithPrefs(client, {
    collectionName: "sleep",
    subcollection: "intervals",
    childUid,
    interval,
    prefs: { lastSleep: { start: startSec, duration: durationSec, offset } },
  });

  // Timer reset matches the app's stop action: inactive and unusable, uuid retained.
  await updateDoc(sleepRef, {
    timer: {
      active: false,
      paused: false,
      timestamp: ts,
      timerStartTime: null,
      uuid: timer.uuid ?? newSessionUuid(),
      local_timestamp: local,
    },
  });

  void intervalId;
  return { startSec, durationSec };
}
