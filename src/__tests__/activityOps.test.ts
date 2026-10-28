import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HuckleberryClient } from "../client/HuckleberryClient.js";

// Mock firebase/firestore; doc()/collection() return path objects.
const {
  mockAddDoc,
  mockSetDoc,
  mockUpdateDoc,
  mockGetDocs,
  mockGetDoc,
  mockQuery,
  mockWhere,
  mockOrderBy,
  mockCollection,
  mockDoc,
} = vi.hoisted(() => ({
  mockAddDoc: vi.fn(async () => ({ id: "act-id" })),
  mockSetDoc: vi.fn(async () => undefined),
  mockUpdateDoc: vi.fn(async () => undefined),
  mockGetDocs: vi.fn(async () => ({ docs: [] })),
  mockGetDoc: vi.fn(async () => ({ exists: () => false, data: () => undefined })),
  mockQuery: vi.fn((col: unknown) => col),
  mockWhere: vi.fn(() => ({ __where: true })),
  mockOrderBy: vi.fn(() => ({ __orderBy: true })),
  mockCollection: vi.fn((_db: unknown, ...seg: string[]) => ({ path: seg.join("/") })),
  mockDoc: vi.fn((_db: unknown, ...seg: string[]) => ({ path: seg.join("/") })),
}));

vi.mock("firebase/firestore", () => ({
  collection: mockCollection,
  doc: mockDoc,
  addDoc: mockAddDoc,
  setDoc: mockSetDoc,
  updateDoc: mockUpdateDoc,
  getDocs: mockGetDocs,
  getDoc: mockGetDoc,
  query: mockQuery,
  where: mockWhere,
  orderBy: mockOrderBy,
  startAfter: vi.fn(),
  deleteField: () => ({ __sentinel: "DELETE_FIELD" }),
}));

import {
  startActivity,
  pauseActivity,
  resumeActivity,
  switchActivity,
  cancelActivity,
  completeActivity,
  logActivity,
  listActivityIntervals,
  getActivityDoc,
  activeActivityMode,
} from "../client/activityOps.js";

const OFFSET = -480;
const client = {
  connect: vi.fn(async () => ({})),
  getFirestore: () => ({}),
  getOffsetMinutes: () => OFFSET,
} as unknown as HuckleberryClient;

// Drain once-queues between tests and restore the default (missing doc).
beforeEach(() => {
  vi.clearAllMocks();
  mockGetDoc.mockReset();
  mockGetDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
});

function docFor(timer: Record<string, Record<string, unknown>>, prefs?: Record<string, unknown>) {
  return { exists: () => true, data: () => ({ timer, ...(prefs ? { prefs } : {}) }) };
}

function lastSetCall(): { path: string; patch: Record<string, unknown>; opts: unknown } {
  const [ref, patch] = mockSetDoc.mock.calls.at(-1) as [{ path: string }, Record<string, unknown>];
  return { path: ref.path, patch, opts: mockSetDoc.mock.calls.at(-1)?.[2] };
}

describe("activity rack helpers", () => {
  it("activeActivityMode finds the single active mode", () => {
    expect(activeActivityMode({})).toBeNull();
    expect(
      activeActivityMode({
        timer: {
          bath: { active: true, paused: false },
          tummyTime: { active: false, paused: false },
        },
      }),
    ).toBe("bath");
  });

  it("getActivityDoc parses a rack doc", async () => {
    mockGetDoc.mockResolvedValueOnce(docFor({ bath: { active: true } }));
    const doc = await getActivityDoc(client, "cid");
    expect(doc.timer?.bath?.active).toBe(true);
  });
});

describe("startActivity", () => {
  it("starts fresh with duration 0 and the shared uuid", async () => {
    mockGetDoc.mockResolvedValueOnce(docFor({ tummyTime: { active: false, uuid: "shared-uuid" } }));
    const result = await startActivity(client, "cid", "bath", { time: new Date(Date.now()) });

    expect(result).toEqual({ moved: false });
    const { patch, opts } = lastSetCall();
    expect(opts).toEqual({ merge: true });
    const bath = (patch.timer as Record<string, Record<string, unknown>>).bath;
    expect(bath).toMatchObject({ active: true, paused: false, duration: 0, notes: "" });
    expect(bath.uuid).toBe("shared-uuid"); // shared uuid reuse across modes
  });

  it("rejects a second mode with a different active timer", async () => {
    mockGetDoc.mockResolvedValueOnce(
      docFor({ bath: { active: true, paused: false, startTime: Date.now() } }),
    );
    await expect(startActivity(client, "cid", "tummyTime")).rejects.toThrow("use switch_activity");
  });

  it("moves the start on same-mode repeat with explicit time", async () => {
    mockGetDoc.mockResolvedValueOnce(
      docFor({ bath: { active: true, paused: false, startTime: 1000, uuid: "u" } }),
    );
    const result = await startActivity(client, "cid", "bath", { time: new Date(Date.now()) });

    expect(result).toEqual({ moved: true });
    const { patch } = lastSetCall();
    const bath = (patch.timer as Record<string, Record<string, unknown>>).bath;
    expect(bath.startTime as number).toEqual(expect.any(Number));
  });

  it("throws when a moved start lands after a paused endTime", async () => {
    mockGetDoc.mockResolvedValueOnce(
      docFor({
        bath: {
          active: true,
          paused: true,
          startTime: 1000,
          endTime: Date.now() + 60_000,
          duration: 5,
        },
      }),
    );
    await expect(
      startActivity(client, "cid", "bath", { time: new Date(Date.now() + 120_000) }),
    ).rejects.toThrow("paused activity end time");
  });
});

describe("pauseActivity / resumeActivity", () => {
  const ACTIVE = {
    active: true,
    paused: false,
    startTime: Date.now() - 65_000,
    uuid: "u",
  };

  it("pause banks a whole-second duration + endTime = start + duration*1000", async () => {
    mockGetDoc.mockResolvedValueOnce(docFor({ bath: { ...ACTIVE } }));
    await pauseActivity(client, "cid", "bath");

    const { patch } = lastSetCall();
    const bath = (patch.timer as Record<string, Record<string, unknown>>).bath;
    expect(bath.paused).toBe(true);
    expect(bath.duration as number).toBeGreaterThanOrEqual(64);
    expect(bath.duration as number).toBeLessThanOrEqual(66);
    // Merge semantics: the patch carries duration+endTime; start stays in the doc.
    expect(bath.endTime as number).toBe(ACTIVE.startTime + (bath.duration as number) * 1000);
  });

  it("pause is a no-op when paused already", async () => {
    mockGetDoc.mockResolvedValueOnce(docFor({ bath: { ...ACTIVE, paused: true } }));
    await pauseActivity(client, "cid", "bath");
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it("resume un-pauses with refreshed rounded duration, no endTime", async () => {
    mockGetDoc.mockResolvedValueOnce(
      docFor({ bath: { ...ACTIVE, paused: true, duration: 10, endTime: Date.now() - 30_000 } }),
    );
    await resumeActivity(client, "cid", "bath");

    const { patch } = lastSetCall();
    const bath = (patch.timer as Record<string, Record<string, unknown>>).bath;
    expect(bath.paused).toBe(false);
    expect(bath.duration as number).toBeGreaterThanOrEqual(0);
    expect(bath.endTime).toBeUndefined();
  });
});

describe("switchActivity", () => {
  it("transfers the running timer to the new mode and resets the source", async () => {
    mockGetDoc.mockResolvedValueOnce(
      docFor({
        bath: {
          active: true,
          paused: false,
          startTime: Date.now() - 30_000,
          duration: 0,
          notes: "",
          uuid: "u",
        },
      }),
    );
    const result = await switchActivity(client, "cid", "tummyTime");

    expect(result).toEqual({ switched: true });
    const { patch } = lastSetCall();
    const rack = patch.timer as Record<string, Record<string, unknown>>;
    expect(rack.bath).toMatchObject({ active: false, paused: false });
    expect(rack.tummyTime).toMatchObject({
      active: true,
      uuid: "u",
      startTime: expect.any(Number),
    });
  });

  it("is a no-op when nothing is active", async () => {
    await switchActivity(client, "cid", "tummyTime");
    expect(mockSetDoc).not.toHaveBeenCalled();
  });
});

describe("cancelActivity / completeActivity", () => {
  it("cancel writes the frozen inactive shape", async () => {
    const startMs = Date.now() - 45_000;
    mockGetDoc.mockResolvedValueOnce(
      docFor({
        bath: {
          active: true,
          paused: false,
          startTime: startMs,
          duration: 0,
          notes: "",
          uuid: "u",
        },
      }),
    );
    await cancelActivity(client, "cid", "bath");

    const { patch } = lastSetCall();
    const bath = (patch.timer as Record<string, Record<string, unknown>>).bath;
    expect(bath).toMatchObject({ active: false, paused: false, uuid: "u" });
    expect(bath.duration as number).toBeGreaterThanOrEqual(44);
  });

  it("complete defaults duration from the timer and resets; supports duration override", async () => {
    const startMs = Date.now() - 120_000;
    mockGetDoc.mockResolvedValueOnce(
      docFor({
        bath: {
          active: true,
          paused: false,
          startTime: startMs,
          duration: 0,
          notes: "",
          uuid: "u",
        },
      }),
    );
    const saved = await completeActivity(client, "cid", "bath", { duration: 90 });

    expect(saved).toEqual({ startSec: startMs / 1000, duration: 90 });
    const { patch } = lastSetCall();
    const bath = (patch.timer as Record<string, Record<string, unknown>>).bath;
    expect(bath).toMatchObject({ active: false, duration: 90, uuid: "u" });
  });

  it("complete is a no-op when inactive", async () => {
    mockGetDoc.mockResolvedValueOnce(
      docFor({ bath: { active: false, paused: false, startTime: 5, duration: 0 } }),
    );
    const saved = await completeActivity(client, "cid", "bath");
    expect(saved).toBeNull();
  });

  it("rejects end + duration together", async () => {
    await expect(
      completeActivity(client, "cid", "bath", { end: new Date(), duration: 10 }),
    ).rejects.toThrow("not both");
  });

  it("rejects a negative duration", async () => {
    await expect(completeActivity(client, "cid", "bath", { duration: -5 })).rejects.toThrow(
      "non-negative",
    );
  });
});

describe("logActivity", () => {
  it("writes the interval + per-mode prefs field, resetting an active rack entry", async () => {
    const startSec = Math.floor(Date.now() / 1000) - 60;
    mockGetDoc.mockResolvedValueOnce(
      docFor({ storyTime: { active: true, startTime: Date.now(), uuid: "u" } }),
    );

    const id = await logActivity(client, "cid", {
      mode: "storyTime",
      start: startSec,
      duration: 60,
    });
    void id;

    const [colRef, body] = mockAddDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(colRef.path).toBe("activities/cid/intervals");
    expect(body).toMatchObject({
      mode: "storyTime",
      start: startSec,
      duration: 60,
      offset: OFFSET,
      end_offset: OFFSET,
    });

    const [, prefsPatch] = mockSetDoc.mock.calls[0] as [
      { path: string },
      { prefs: Record<string, unknown> },
    ];
    expect(prefsPatch.prefs.lastStoryTime).toMatchObject({ start: startSec, duration: 60 });

    const resets = mockSetDoc.mock.calls.filter(
      (c) =>
        (c[0] as { path: string }).path === "activities/cid" &&
        (c[1] as { timer?: Record<string, unknown> }).timer !== undefined,
    );
    expect(resets.length).toBeGreaterThanOrEqual(1);
    const lastPatch = resets.at(-1)?.[1] as { timer: Record<string, Record<string, unknown>> };
    const last = lastPatch.timer.storyTime;
    expect(last).toMatchObject({ active: false, paused: false });
  });

  it("skips the reset when no rack entry is active", async () => {
    const startSec = Math.floor(Date.now() / 1000) - 60;
    mockGetDoc.mockResolvedValueOnce(docFor({}));

    await logActivity(client, "cid", { mode: "bath", start: startSec });
    expect(mockSetDoc).toHaveBeenCalledTimes(1); // prefs only
  });

  it("rejects negative durations", async () => {
    await expect(
      logActivity(client, "cid", { mode: "bath", start: Date.now() / 1000, duration: -1 }),
    ).rejects.toThrow("non-negative");
  });
});

describe("listActivityIntervals", () => {
  it("queries the range and skips multi container docs", async () => {
    const start = Date.now() / 1000 - 3600;
    const end = Date.now() / 1000;
    const snap = {
      docs: [
        { id: "a", id2: null, data: () => ({ mode: "bath", start }) },
        { id: "b", data: () => ({ multi: true }) },
      ],
    };
    mockGetDocs.mockResolvedValueOnce(snap as never);

    const events = await listActivityIntervals(client, "cid", { start, end });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "a", mode: "bath" });
    // range query built via where(start>=) + where(start<)
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });
});
