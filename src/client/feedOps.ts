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
  FeedingInterval,
  FeedDocument,
  type FeedingIntervalParsed,
  type FeedTimerParsed,
  PumpDocument,
  type PumpTimerParsed,
  PumpInterval,
  type PumpIntervalParsed,
} from "../models/index.js";
import { writeIntervalWithPrefs } from "./prefs.js";

// ── Nursing ────────────────────────────────────────────────────────────────

export interface LogNursingOptions {
  start: number;
  leftDuration?: number;
  rightDuration?: number;
  lastSide?: "left" | "right";
  notes?: string;
  time?: Date;
}

/** Logs a nursing session. Returns the new interval ID. */
export async function logNursing(
  client: HuckleberryClient,
  childUid: string,
  options: LogNursingOptions,
): Promise<string> {
  const eventDate = options.time ?? new Date();
  const offset = client.getOffsetMinutes(eventDate);
  const lastUpdated = Date.now() / 1000;

  return writeIntervalWithPrefs(client, {
    collectionName: "feed",
    subcollection: "intervals",
    childUid,
    interval: {
      mode: "breast",
      start: options.start,
      offset,
      ...(options.leftDuration !== undefined && { leftDuration: options.leftDuration }),
      ...(options.rightDuration !== undefined && { rightDuration: options.rightDuration }),
      ...(options.lastSide !== undefined && { lastSide: options.lastSide }),
      ...(options.notes !== undefined && { notes: options.notes }),
      lastUpdated,
    },
    prefs: {
      lastNursing: {
        start: options.start,
        offset,
        mode: "breast",
        duration: (options.leftDuration ?? 0) + (options.rightDuration ?? 0),
        ...(options.leftDuration !== undefined && { leftDuration: options.leftDuration }),
        ...(options.rightDuration !== undefined && { rightDuration: options.rightDuration }),
      },
      ...(options.lastSide !== undefined && {
        lastSide: { lastSide: options.lastSide, start: options.start },
      }),
    },
  });
}

// ── Live nursing timer ────────────────────────────────────────────────────────
// Port of py-huckleberry-api's nursing path. Unlike sleep (ms), the feed timer
// counts in SECONDS; side durations accumulate on the timer; the saved interval
// id matches the app's `{ms}-{20hex}` format.

export async function getFeedDoc(
  client: HuckleberryClient,
  childUid: string,
): Promise<{ timer: FeedTimerParsed | null }> {
  await client.connect();
  const db = client.getFirestore();
  const snap = await getDoc(doc(db, "feed", childUid));
  if (!snap.exists()) return { timer: null };
  const parsed = FeedDocument.parse(snap.data());
  return { timer: parsed.timer ?? null };
}

function newSessionUuid(len = 16): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

interface NowResult {
  sec: number;
  ms: number;
  ts: { seconds: number };
}

function nowParts(): NowResult {
  const ms = Date.now();
  const sec = ms / 1000;
  return { sec, ms, ts: { seconds: sec } };
}

/** Resolves the currently-tracked side, mirroring the port's fallback order. */
function currentSide(timer: FeedTimerParsed): "left" | "right" {
  const side = timer.activeSide ?? timer.lastSide ?? "left";
  return side === "right" ? "right" : "left";
}

function sideDurations(timer: FeedTimerParsed): { left: number; right: number } {
  return { left: timer.leftDuration ?? 0, right: timer.rightDuration ?? 0 };
}

/** Elapsed bounded to >= 0. */
function elapsedSince(timer: FeedTimerParsed, untilSec?: number): number {
  const start = timer.timerStartTime ?? nowParts().sec;
  const elapsed = (untilSec ?? nowParts().sec) - start;
  return Math.max(0, elapsed);
}

export interface StartNursingOptions {
  side?: "left" | "right";
  time?: Date;
}

/** Starts the nursing timer; on an active timer with explicit `time`, shifts its start. */
export async function startNursing(
  client: HuckleberryClient,
  childUid: string,
  options: StartNursingOptions = {},
): Promise<{ moved: boolean }> {
  await client.connect();
  const db = client.getFirestore();
  const feedRef = doc(db, "feed", childUid);
  const side = options.side ?? "left";
  const { ts, sec } = nowParts();
  const sessionStart = options.time ? options.time.getTime() / 1000 : sec;

  const { timer } = await getFeedDoc(client, childUid);
  if (timer?.active) {
    if (!options.time) return { moved: false };
    const previousStart = timer.feedStartTime ?? timer.timerStartTime ?? sessionStart;
    const shift = sessionStart - previousStart;
    let segmentStart = (timer.timerStartTime ?? previousStart) + shift;
    if (!timer.paused && segmentStart > sec) {
      // Moving the session start later must not push the running segment
      // into the future — keep the segment start instead (upstream parity).
      segmentStart = timer.timerStartTime ?? previousStart;
    }
    await updateDoc(feedRef, {
      "timer.feedStartTime": sessionStart,
      "timer.timerStartTime": segmentStart,
      "timer.timestamp": ts,
      "timer.local_timestamp": sec,
    });
    return { moved: true };
  }

  const timerPatch = {
    active: true,
    paused: false,
    timestamp: ts,
    local_timestamp: sec,
    feedStartTime: sessionStart,
    timerStartTime: sessionStart,
    uuid: timer?.uuid ?? newSessionUuid(),
    leftDuration: 0,
    rightDuration: 0,
    lastSide: "left",
    activeSide: side,
  };
  await setDoc(feedRef, { timer: timerPatch }, { merge: true });
  return { moved: false };
}

/** Pause: bank elapsed time into the active side, memoize side, clear activeSide. */
export async function pauseNursing(client: HuckleberryClient, childUid: string): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const feedRef = doc(db, "feed", childUid);
  const { timer } = await getFeedDoc(client, childUid);
  if (!timer?.active || timer.paused) return;

  const { ts, sec } = nowParts();
  const { left, right } = sideDurations(timer);
  const side0 = currentSide(timer);
  const elapsed = elapsedSince(timer, sec);
  const leftDuration = side0 === "left" ? left + elapsed : left;
  const rightDuration = side0 === "right" ? right + elapsed : right;

  await updateDoc(feedRef, {
    "timer.paused": true,
    "timer.active": true,
    "timer.timestamp": ts,
    "timer.local_timestamp": sec,
    "timer.leftDuration": leftDuration,
    "timer.rightDuration": rightDuration,
    "timer.lastSide": side0,
    "timer.activeSide": deleteField(),
  });
}

export interface ResumeNursingOptions {
  side?: "left" | "right";
}

export async function resumeNursing(
  client: HuckleberryClient,
  childUid: string,
  options: ResumeNursingOptions = {},
): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const feedRef = doc(db, "feed", childUid);
  const { timer } = await getFeedDoc(client, childUid);
  if (!timer?.active || !timer.paused) return;

  const side =
    options.side ??
    (timer.lastSide !== undefined && timer.lastSide !== "none"
      ? timer.lastSide === "right"
        ? "right"
        : "left"
      : "left");
  const { ts, sec } = nowParts();
  await updateDoc(feedRef, {
    "timer.paused": false,
    "timer.active": true,
    "timer.timestamp": ts,
    "timer.local_timestamp": sec,
    "timer.timerStartTime": sec,
    "timer.activeSide": side,
    "timer.lastSide": "none",
  });
}

export interface SwitchNursingSideOptions {
  side?: "left" | "right";
}

/** Switches L↔R (or to an explicit side); banking elapsed time when running. */
export async function switchNursingSide(
  client: HuckleberryClient,
  childUid: string,
  options: SwitchNursingSideOptions = {},
): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const feedRef = doc(db, "feed", childUid);
  const { timer } = await getFeedDoc(client, childUid);
  if (!timer?.active) return;

  const side0 = currentSide(timer);
  const newSide = options.side ? options.side : side0 === "left" ? "right" : "left";
  const { ts, sec } = nowParts();
  let { left, right } = sideDurations(timer);

  // Only accumulate if actively running (switching always un-pauses).
  if (!timer.paused) {
    const elapsed = elapsedSince(timer, sec);
    if (side0 === "left") left += elapsed;
    else right += elapsed;
  }

  await updateDoc(feedRef, {
    "timer.paused": false,
    "timer.lastSide": "none",
    "timer.timestamp": ts,
    "timer.local_timestamp": sec,
    "timer.timerStartTime": sec,
    "timer.activeSide": newSide,
    "timer.leftDuration": left,
    "timer.rightDuration": right,
  });
}

export async function cancelNursing(client: HuckleberryClient, childUid: string): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const feedRef = doc(db, "feed", childUid);
  const { timer } = await getFeedDoc(client, childUid);
  const { ts, sec } = nowParts();

  await updateDoc(feedRef, {
    timer: {
      active: false,
      paused: false,
      timestamp: ts,
      timerStartTime: null,
      uuid: timer?.uuid ?? newSessionUuid(),
      local_timestamp: sec,
      leftDuration: 0,
      rightDuration: 0,
      lastSide: "left",
    },
  });
}

export interface CompleteNursingOptions {
  /** Replaces the session start (epoch seconds) of the saved interval. */
  start?: number;
  /** End of the running segment; defaults to now. */
  end?: Date;
}

/**
 * Completes the active nursing timer: banks the current segment, trims
 * over-accumulated durations to fit the corrected session span, writes an
 * app-shaped interval (`{ms}-{20hex}` id), updates prefs summaries, resets
 * the timer. Inactive timer → no-op.
 */
export async function completeNursing(
  client: HuckleberryClient,
  childUid: string,
  options: CompleteNursingOptions = {},
): Promise<{ startSec: number; left: number; right: number; total: number } | null> {
  await client.connect();
  const db = client.getFirestore();
  const feedRef = doc(db, "feed", childUid);
  const { timer } = await getFeedDoc(client, childUid);
  if (!timer?.active) return null;

  if (!timer.timerStartTime) {
    throw new Error("Missing timerStartTime on active nursing timer");
  }

  const { ts, sec, ms } = nowParts();
  const endTimestamp = options.end ? options.end.getTime() / 1000 : sec;

  let { left, right } = sideDurations(timer);
  const side0 = currentSide(timer);
  if (!timer.paused) {
    const elapsed = endTimestamp - timer.timerStartTime;
    if (elapsed < 0) throw new Error("end must not precede the current nursing segment start");
    if (side0 === "left") left += elapsed;
    else right += elapsed;
  }

  const feedStartSec = options.start ?? timer.feedStartTime ?? timer.timerStartTime;
  if (feedStartSec > endTimestamp) {
    throw new Error("start must not be after end");
  }

  // A corrected start can make the accumulated side durations exceed the
  // corrected span — trim the active side first, then the other (upstream).
  const maxDuration = Math.max(0, endTimestamp - feedStartSec);
  let total = left + right;
  if (total > maxDuration) {
    let excess = total - maxDuration;
    const trimPrimary = Math.min(excess, side0 === "left" ? left : right);
    if (side0 === "left") {
      left -= trimPrimary;
    } else {
      right -= trimPrimary;
    }
    excess -= trimPrimary;
    if (excess > 0) {
      if (side0 === "left") right = Math.max(0, right - excess);
      else left = Math.max(0, left - excess);
    }
    total = left + right;
  }

  // Last side for history: resolve "none" by majority of durations (upstream).
  let lastSide: "left" | "right" = side0;
  if (timer.lastSide === "none" || timer.activeSide === undefined) {
    lastSide = right >= left ? "right" : "left";
  }

  const offset = client.getOffsetMinutes(new Date());
  const intervalId = `${Math.floor(ms)}-${newSessionUuid(20)}`;
  const interval = {
    mode: "breast",
    start: feedStartSec,
    lastSide,
    leftDuration: left,
    rightDuration: right,
    offset,
    end_offset: offset,
    lastUpdated: sec,
  };

  await setDoc(doc(db, "feed", childUid, "intervals", intervalId), interval);

  // prefs summaries (matches the repo's logNursing convention) + timer reset.
  await updateDoc(feedRef, {
    "timer.active": false,
    "timer.paused": true,
    "timer.timestamp": ts,
    "timer.local_timestamp": sec,
    "timer.lastSide": lastSide,
    "timer.leftDuration": deleteField(),
    "timer.rightDuration": deleteField(),
    "timer.activeSide": deleteField(),
    "prefs.lastNursing": {
      mode: "breast",
      start: feedStartSec,
      offset,
      duration: total,
      leftDuration: left,
      rightDuration: right,
    },
    "prefs.lastSide": { lastSide, start: feedStartSec },
    "prefs.timestamp": { seconds: sec },
    "prefs.local_timestamp": sec,
  });

  void intervalId;
  return { startSec: feedStartSec, left, right, total };
}

// ── Bottle ─────────────────────────────────────────────────────────────────

export interface LogBottleOptions {
  start: number;
  amount: number;
  bottleType: string;
  units: "ml" | "oz";
  notes?: string;
  time?: Date;
}

/** Logs a bottle feeding. Returns the new interval ID. */
export async function logBottle(
  client: HuckleberryClient,
  childUid: string,
  options: LogBottleOptions,
): Promise<string> {
  const eventDate = options.time ?? new Date();
  const offset = client.getOffsetMinutes(eventDate);
  const lastUpdated = Date.now() / 1000;

  return writeIntervalWithPrefs(client, {
    collectionName: "feed",
    subcollection: "intervals",
    childUid,
    interval: {
      mode: "bottle",
      start: options.start,
      offset,
      amount: options.amount,
      bottleType: options.bottleType,
      units: options.units,
      ...(options.notes !== undefined && { notes: options.notes }),
      lastUpdated,
    },
    prefs: {
      lastBottle: {
        mode: "bottle",
        start: options.start,
        offset,
        bottleType: options.bottleType,
        bottleAmount: options.amount,
        bottleUnits: options.units,
      },
      bottleAmount: options.amount,
      bottleUnits: options.units,
      bottleType: options.bottleType,
      lastBottleUuid: newSessionUuid(),
    },
  });
}

// ── Solids ─────────────────────────────────────────────────────────────────

export interface LogSolidsOptions {
  start: number;
  notes?: string;
  time?: Date;
}

/** Logs a solids feeding. Returns the new interval ID. */
export async function logSolids(
  client: HuckleberryClient,
  childUid: string,
  options: LogSolidsOptions,
): Promise<string> {
  const eventDate = options.time ?? new Date();
  const offset = client.getOffsetMinutes(eventDate);
  const lastUpdated = Date.now() / 1000;

  return writeIntervalWithPrefs(client, {
    collectionName: "feed",
    subcollection: "intervals",
    childUid,
    interval: {
      mode: "solids",
      start: options.start,
      offset,
      ...(options.notes !== undefined && { notes: options.notes }),
      lastUpdated,
    },
    prefs: {
      // Ground-truth: the feed prefs key for solids is lastSolid (observed key
      // in the schema dump; shape inferred analogous to lastNursing — revisit
      // if a phone-created solids entry shows different fields).
      lastSolid: {
        mode: "solids",
        start: options.start,
        offset,
      },
    },
  });
}

// ── Feed History ───────────────────────────────────────────────────────────

export interface FeedHistoryOptions {
  limit?: number;
}

/** Returns feed intervals for a child, ordered by start descending. Each entry
 * includes its Firestore doc `id` so it can be referenced by `editFeed`. */
export async function getFeedHistory(
  client: HuckleberryClient,
  childUid: string,
  options: FeedHistoryOptions = {},
): Promise<(FeedingIntervalParsed & { id: string })[]> {
  await client.connect();
  const db = client.getFirestore();
  const col = collection(db, "feed", childUid, "intervals");
  const q = query(col, orderBy("start", "desc"), limit(options.limit ?? 50));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...FeedingInterval.parse(d.data()) }));
}

// ── Edit feed ────────────────────────────────────────────────────────────────

export interface EditFeedOptions {
  /** Event time (epoch seconds). */
  start?: number;
  // bottle
  amount?: number;
  bottleType?: string;
  units?: "ml" | "oz";
  // nursing
  leftDuration?: number;
  rightDuration?: number;
  lastSide?: "left" | "right";
  notes?: string;
}

/**
 * Updates fields on an existing feed interval (`feed/{cid}/intervals/{id}`).
 * Only the provided fields are changed; `lastUpdated` is bumped. The interval id
 * comes from `getFeedHistory`. Does not touch the parent `prefs` summary.
 */
export async function editFeed(
  client: HuckleberryClient,
  childUid: string,
  intervalId: string,
  updates: EditFeedOptions,
): Promise<void> {
  const patch: Record<string, unknown> = {
    ...(updates.start !== undefined && { start: updates.start }),
    ...(updates.amount !== undefined && { amount: updates.amount }),
    ...(updates.bottleType !== undefined && { bottleType: updates.bottleType }),
    ...(updates.units !== undefined && { units: updates.units }),
    ...(updates.leftDuration !== undefined && { leftDuration: updates.leftDuration }),
    ...(updates.rightDuration !== undefined && { rightDuration: updates.rightDuration }),
    ...(updates.lastSide !== undefined && { lastSide: updates.lastSide }),
    ...(updates.notes !== undefined && { notes: updates.notes }),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error("editFeed requires at least one field to update");
  }
  patch.lastUpdated = Date.now() / 1000;

  await client.connect();
  const db = client.getFirestore();
  await updateDoc(doc(db, "feed", childUid, "intervals", intervalId), patch);
}

// ── Delete feed ──────────────────────────────────────────────────────────────

/**
 * Permanently deletes a feed interval (`feed/{cid}/intervals/{id}`) — nursing,
 * bottle, or solids. The id comes from `getFeedHistory`. Does **not** recompute
 * the parent `prefs.lastSolid` summary.
 */
export async function deleteFeed(
  client: HuckleberryClient,
  childUid: string,
  intervalId: string,
): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  await deleteDoc(doc(db, "feed", childUid, "intervals", intervalId));
}

// ── Pump ───────────────────────────────────────────────────────────────────

export interface LogPumpOptions {
  start: number;
  leftAmount: number;
  rightAmount: number;
  units: "ml" | "oz";
  duration?: number;
  totalAmount?: number;
  notes?: string;
  time?: Date;
}

/** Logs a pumping session. Returns the new interval ID. */
export async function logPump(
  client: HuckleberryClient,
  childUid: string,
  options: LogPumpOptions,
): Promise<string> {
  const eventDate = options.time ?? new Date();
  const offset = client.getOffsetMinutes(eventDate);
  const lastUpdated = Date.now() / 1000;

  let entryMode: "total" | "leftright";
  let leftAmount: number;
  let rightAmount: number;

  if (options.totalAmount !== undefined) {
    entryMode = "total";
    leftAmount = options.totalAmount / 2;
    rightAmount = options.totalAmount / 2;
  } else {
    entryMode = "leftright";
    leftAmount = options.leftAmount;
    rightAmount = options.rightAmount;
  }

  return writeIntervalWithPrefs(client, {
    collectionName: "pump",
    subcollection: "intervals",
    childUid,
    interval: {
      entryMode,
      start: options.start,
      offset,
      leftAmount,
      rightAmount,
      units: options.units,
      ...(options.duration !== undefined && { duration: options.duration }),
      ...(options.notes !== undefined && { notes: options.notes }),
      lastUpdated,
    },
    prefs: {
      lastPump: {
        start: options.start,
        offset,
        leftAmount,
        rightAmount,
        units: options.units,
        entryMode,
        ...(options.duration !== undefined && { duration: options.duration }),
      },
    },
  });
}

export interface PumpHistoryOptions {
  limit?: number;
}

/** Returns pump intervals for a child, ordered by start descending. Each entry
 * includes its Firestore doc `id` so it can be referenced by `editPump`. */
export async function listPumpIntervals(
  client: HuckleberryClient,
  childUid: string,
  options: PumpHistoryOptions = {},
): Promise<(PumpIntervalParsed & { id: string })[]> {
  await client.connect();
  const db = client.getFirestore();
  const col = collection(db, "pump", childUid, "intervals");
  const q = query(col, orderBy("start", "desc"), limit(options.limit ?? 50));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...PumpInterval.parse(d.data()) }));
}

// ── Edit pump ────────────────────────────────────────────────────────────────

export interface EditPumpOptions {
  /** Event time (epoch seconds). */
  start?: number;
  leftAmount?: number;
  rightAmount?: number;
  units?: "ml" | "oz";
  duration?: number;
  notes?: string;
}

/**
 * Updates fields on an existing pump interval (`pump/{cid}/intervals/{id}`).
 * Only the provided fields are changed; `lastUpdated` is bumped. The interval id
 * comes from `listPumpIntervals`. Does not touch the parent `prefs` summary.
 */
export async function editPump(
  client: HuckleberryClient,
  childUid: string,
  intervalId: string,
  updates: EditPumpOptions,
): Promise<void> {
  const patch: Record<string, unknown> = {
    ...(updates.start !== undefined && { start: updates.start }),
    ...(updates.leftAmount !== undefined && { leftAmount: updates.leftAmount }),
    ...(updates.rightAmount !== undefined && { rightAmount: updates.rightAmount }),
    ...(updates.units !== undefined && { units: updates.units }),
    ...(updates.duration !== undefined && { duration: updates.duration }),
    ...(updates.notes !== undefined && { notes: updates.notes }),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error("editPump requires at least one field to update");
  }
  patch.lastUpdated = Date.now() / 1000;

  await client.connect();
  const db = client.getFirestore();
  await updateDoc(doc(db, "pump", childUid, "intervals", intervalId), patch);
}

// ── Delete pump ──────────────────────────────────────────────────────────────

/**
 * Permanently deletes a pump interval (`pump/{cid}/intervals/{id}`). The id comes
 * from `listPumpIntervals`. Does **not** recompute the parent `prefs.lastPump`.
 */
export async function deletePump(
  client: HuckleberryClient,
  childUid: string,
  intervalId: string,
): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  await deleteDoc(doc(db, "pump", childUid, "intervals", intervalId));
}

// ── Live pump timer ──────────────────────────────────────────────────────────
// Port of py-huckleberry-api's pump path (ms timestamps like sleep). Completion
// validates amounts, reuses the logPump interval shape, and resets the timer to
// the app's minimal inactive shape.

export async function getPumpDoc(
  client: HuckleberryClient,
  childUid: string,
): Promise<{ timer: PumpTimerParsed | null }> {
  await client.connect();
  const db = client.getFirestore();
  const snap = await getDoc(doc(db, "pump", childUid));
  if (!snap.exists()) return { timer: null };
  const parsed = PumpDocument.parse(snap.data());
  return { timer: parsed.timer ?? null };
}

// Session uuid helper is shared with the nursing ops (newSessionUuid above).

export interface StartPumpOptions {
  time?: Date;
}

export async function startPump(
  client: HuckleberryClient,
  childUid: string,
  options: StartPumpOptions = {},
): Promise<{ moved: boolean }> {
  await client.connect();
  const db = client.getFirestore();
  const pumpRef = doc(db, "pump", childUid);
  const { timer } = await getPumpDoc(client, childUid);
  const nowMs = Date.now();
  const requested = options.time ? options.time.getTime() : nowMs;

  if (timer?.active) {
    if (!options.time) return { moved: false };
    if (timer.paused && timer.endTime != null && requested > timer.endTime) {
      throw new Error("start must not be after the paused pump end time");
    }
    await updateDoc(pumpRef, {
      "timer.startTime": requested,
      "timer.timestamp": { seconds: nowMs / 1000 },
      "timer.local_timestamp": nowMs / 1000,
    });
    return { moved: true };
  }

  await updateDoc(pumpRef, {
    timer: {
      active: true,
      paused: false,
      timestamp: { seconds: nowMs / 1000 },
      local_timestamp: nowMs / 1000,
      startTime: requested,
      uuid: timer?.uuid ?? newSessionUuid(),
    },
  });
  return { moved: false };
}

export async function pausePump(client: HuckleberryClient, childUid: string): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const pumpRef = doc(db, "pump", childUid);
  const { timer } = await getPumpDoc(client, childUid);
  if (!timer?.active || timer.paused) return;

  const nowMs = Date.now();
  await updateDoc(pumpRef, {
    "timer.active": true,
    "timer.paused": true,
    "timer.endTime": nowMs,
    "timer.timestamp": { seconds: nowMs / 1000 },
    "timer.local_timestamp": nowMs / 1000,
  });
}

export async function resumePump(client: HuckleberryClient, childUid: string): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const pumpRef = doc(db, "pump", childUid);
  const { timer } = await getPumpDoc(client, childUid);
  if (!timer?.active || !timer.paused) return;

  const nowMs = Date.now();
  await updateDoc(pumpRef, {
    "timer.active": true,
    "timer.paused": false,
    "timer.endTime": deleteField(),
    "timer.timestamp": { seconds: nowMs / 1000 },
    "timer.local_timestamp": nowMs / 1000,
  });
}

export async function cancelPump(client: HuckleberryClient, childUid: string): Promise<void> {
  await client.connect();
  const db = client.getFirestore();
  const pumpRef = doc(db, "pump", childUid);
  const { timer } = await getPumpDoc(client, childUid);
  if (!timer?.active) return;

  const nowMs = Date.now();
  await updateDoc(pumpRef, {
    timer: {
      active: false,
      paused: false,
      timestamp: { seconds: nowMs / 1000 },
      local_timestamp: nowMs / 1000,
      startTime: nowMs,
      entryMode: timer.entryMode ?? "total",
      uuid: timer.uuid ?? newSessionUuid(),
    },
  });
}

export interface CompletePumpOptions {
  /** Corrects the saved interval start (overrides timer startTime). */
  start?: Date;
  /** Corrects the end; defaults to paused endTime, else now. */
  end?: Date;
  /** Left amount (requires rightAmount) for letright entries. */
  leftAmount?: number;
  /** Right amount (requires leftAmount) for letright entries. */
  rightAmount?: number;
  /** Total for total entries (split evenly; mutually exclusive with left/right). */
  totalAmount?: number;
  units: "ml" | "oz";
  notes?: string;
}

/**
 * Completes the active pump timer: validates the amounts, saves an interval
 * via the logPump shape, and resets the timer to the minimal inactive shape.
 * Inactive → no-op.
 */
export async function completePump(
  client: HuckleberryClient,
  childUid: string,
  options: CompletePumpOptions,
): Promise<{ startSec: number; durationSec: number; entryMode: "total" | "leftright" } | null> {
  // Amount validation mirrors py's _resolve_pump_amounts.
  if (options.totalAmount !== undefined) {
    if (options.leftAmount !== undefined || options.rightAmount !== undefined) {
      throw new Error("Provide either totalAmount or left/right amounts, not both");
    }
    if (!Number.isFinite(options.totalAmount) || options.totalAmount < 0) {
      throw new Error("totalAmount must be a non-negative finite number");
    }
  } else if (options.leftAmount === undefined || options.rightAmount === undefined) {
    throw new Error("leftright pump entries require both leftAmount and rightAmount");
  } else if (!Number.isFinite(options.leftAmount) || options.leftAmount < 0) {
    throw new Error("leftAmount must be a non-negative finite number");
  } else if (!Number.isFinite(options.rightAmount) || options.rightAmount < 0) {
    throw new Error("rightAmount must be a non-negative finite number");
  }

  await client.connect();
  const db = client.getFirestore();
  const pumpRef = doc(db, "pump", childUid);
  const { timer } = await getPumpDoc(client, childUid);
  if (!timer?.active) return null;

  const startMs = options.start
    ? options.start.getTime()
    : timer.startTime != null
      ? timer.startTime
      : undefined;
  if (startMs === undefined) {
    throw new Error("Active pump timer is missing startTime");
  }

  const pausedEnd = timer.paused && timer.endTime != null ? timer.endTime : undefined;
  const endMs = options.end ? options.end.getTime() : (pausedEnd ?? Date.now());
  const durationSec = (endMs - startMs) / 1000;
  if (durationSec < 0) {
    throw new Error("end must not precede start");
  }

  const units = options.units ?? (timer.units as "ml" | "oz" | undefined) ?? "ml";
  const { totalAmount, leftAmount, rightAmount, notes } = options;

  // Write the interval via logPump's shape. Documented deviation from upstream:
  // py's complete path skips prefs.lastPump; we keep it (matches logPump) until
  // live verification says otherwise (flagged in PR).
  await logPump(client, childUid, {
    start: startMs / 1000,
    leftAmount: leftAmount ?? 0,
    rightAmount: rightAmount ?? 0,
    units,
    duration: durationSec,
    totalAmount,
    notes,
  });

  const nowMs = Date.now();
  await updateDoc(pumpRef, {
    timer: {
      active: false,
      paused: false,
      timestamp: { seconds: nowMs / 1000 },
      local_timestamp: nowMs / 1000,
      startTime: nowMs,
      entryMode: totalAmount !== undefined ? "total" : "leftright",
      uuid: timer.uuid ?? newSessionUuid(),
    },
  });

  return {
    startSec: startMs / 1000,
    durationSec,
    entryMode: totalAmount !== undefined ? "total" : "leftright",
  };
}
