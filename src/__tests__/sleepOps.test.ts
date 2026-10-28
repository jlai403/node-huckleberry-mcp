import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HuckleberryClient } from "../client/HuckleberryClient.js";

const {
  mockAddDoc,
  mockSetDoc,
  mockUpdateDoc,
  mockDeleteDoc,
  mockGetDocs,
  mockGetDoc,
  mockCollection,
  mockDoc,
} = vi.hoisted(() => ({
  mockAddDoc: vi.fn(async () => ({ id: "sleep-id" })),
  mockSetDoc: vi.fn(async () => undefined),
  mockUpdateDoc: vi.fn(async () => undefined),
  mockDeleteDoc: vi.fn(async () => undefined),
  mockGetDocs: vi.fn(),
  mockGetDoc: vi.fn(async () => ({ exists: () => false, data: () => undefined })),
  mockCollection: vi.fn((_db: unknown, ...seg: string[]) => ({ path: seg.join("/") })),
  mockDoc: vi.fn((_db: unknown, ...seg: string[]) => ({ path: seg.join("/") })),
}));

vi.mock("firebase/firestore", () => ({
  collection: mockCollection,
  doc: mockDoc,
  addDoc: mockAddDoc,
  setDoc: mockSetDoc,
  updateDoc: mockUpdateDoc,
  deleteDoc: mockDeleteDoc,
  getDocs: mockGetDocs,
  getDoc: mockGetDoc,
  deleteField: () => ({ __sentinel: "DELETE_FIELD" }),
  query: (col: unknown) => col,
  orderBy: () => ({}),
  limit: () => ({}),
}));

import {
  logSleep,
  getSleepHistory,
  editSleep,
  deleteSleep,
  getSleepDoc,
  startSleep,
  pauseSleep,
  resumeSleep,
  cancelSleep,
  completeSleep,
} from "../client/sleepOps.js";

const OFFSET = -480;
const client = {
  connect: vi.fn(async () => ({})),
  getFirestore: () => ({}),
  getOffsetMinutes: () => OFFSET,
} as unknown as HuckleberryClient;

beforeEach(() => vi.clearAllMocks());

describe("sleepOps", () => {
  it("logSleep writes interval + prefs.lastSleep with seconds duration", async () => {
    await logSleep(client, "cid", new Date(1000 * 1000), new Date(1300 * 1000));

    const [colRef, body] = mockAddDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(colRef.path).toBe("sleep/cid/intervals");
    expect(body).toMatchObject({ start: 1000, duration: 300, offset: OFFSET });
    expect(typeof body.lastUpdated).toBe("number");
    expect(body.notes).toBeUndefined();

    const prefs = (mockSetDoc.mock.calls[0][1] as { prefs: { lastSleep: unknown } }).prefs;
    expect(prefs.lastSleep).toEqual({ start: 1000, offset: OFFSET, duration: 300 });
  });

  it("logSleep writes notes when provided", async () => {
    await logSleep(client, "cid", new Date(1000 * 1000), new Date(1300 * 1000), {
      notes: "fussy bedtime",
    });
    const body = mockAddDoc.mock.calls[0][1] as Record<string, unknown>;
    expect(body.notes).toBe("fussy bedtime");
  });

  it("getSleepHistory reads sleep/intervals and includes the doc id", async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        { id: "sleep-7", data: () => ({ start: 5, duration: 10, offset: OFFSET, lastUpdated: 6 }) },
      ],
    });
    const items = await getSleepHistory(client, "cid", { limit: 3 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "sleep-7", start: 5, duration: 10, offset: OFFSET });
  });
});

describe("editSleep", () => {
  it("updates only provided fields on sleep/{cid}/intervals/{id} + bumps lastUpdated", async () => {
    await editSleep(client, "cid", "sleep-7", { duration: 1800, notes: "moved nap" });
    const [ref, patch] = mockUpdateDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(ref.path).toBe("sleep/cid/intervals/sleep-7");
    expect(patch).toMatchObject({ duration: 1800, notes: "moved nap" });
    expect(typeof patch.lastUpdated).toBe("number");
    expect(patch.start).toBeUndefined();
  });

  it("throws when no fields are provided", async () => {
    await expect(editSleep(client, "cid", "sleep-7", {})).rejects.toThrow("at least one");
  });
});

describe("deleteSleep", () => {
  it("deletes sleep/{cid}/intervals/{id}", async () => {
    await deleteSleep(client, "cid", "sleep-7");
    const ref = mockDeleteDoc.mock.calls[0][0] as { path: string };
    expect(ref.path).toBe("sleep/cid/intervals/sleep-7");
  });
});

// ── Live sleep timer ──────────────────────────────────────────────────────────

function timerDoc(timer: Record<string, unknown>) {
  return { exists: () => true, data: () => ({ timer }) };
}

describe("getSleepDoc", () => {
  it("returns null timer for a missing document", async () => {
    const got = await getSleepDoc(client, "cid");
    expect(got.timer).toBeNull();
  });

  it("parses the timer from sleep/{cid}", async () => {
    mockGetDoc.mockResolvedValueOnce(
      timerDoc({ active: true, paused: false, timerStartTime: 1000 }),
    );
    const got = await getSleepDoc(client, "cid");
    expect(got.timer).toMatchObject({ active: true, paused: false, timerStartTime: 1000 });
  });
});

describe("startSleep", () => {
  it("starts a fresh timer with app-shaped default details", async () => {
    const result = await startSleep(client, "cid", { time: new Date(Date.now()) });

    expect(result).toEqual({ moved: false });
    const [ref, patch] = mockSetDoc.mock.calls[0] as [
      { path: string },
      { timer: Record<string, unknown> },
    ];
    expect(ref.path).toBe("sleep/cid");
    expect(patch.timer).toMatchObject({ active: true, paused: false });
    expect(patch.timer.timerStartTime).toEqual(expect.any(Number));
    expect(patch.timer.uuid).toEqual(expect.any(String));
    expect(patch.timer.uuid).toHaveLength(16);
    expect((patch.timer.details as Record<string, unknown>).sleepLocations).toBeTruthy();
    expect(mockSetDoc.mock.calls[0][2]).toEqual({ merge: true });
  });

  it("moves the start when the timer is already active and start is explicit", async () => {
    mockGetDoc.mockResolvedValueOnce(
      timerDoc({ active: true, paused: false, timerStartTime: 1000, uuid: "sess" }),
    );
    const result = await startSleep(client, "cid", { time: new Date(Date.now()) });

    expect(result).toEqual({ moved: true });
    const [ref, patch] = mockUpdateDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(ref.path).toBe("sleep/cid");
    expect(patch["timer.timerStartTime"]).toBeGreaterThan(1000);
    expect(patch["timer.timestamp"]).toEqual({ seconds: expect.any(Number) });
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it("is a no-op when already active without an explicit start", async () => {
    mockGetDoc.mockResolvedValueOnce(
      timerDoc({ active: true, paused: false, timerStartTime: 1000 }),
    );
    const result = await startSleep(client, "cid");

    expect(result).toEqual({ moved: false });
    expect(mockSetDoc).not.toHaveBeenCalled();
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });

  it("throws when the moved start precedes a paused end time", async () => {
    mockGetDoc.mockResolvedValueOnce(
      timerDoc({
        active: true,
        paused: true,
        timerStartTime: 1000,
        timerEndTime: Date.now() + 60_000,
      }),
    );
    await expect(
      startSleep(client, "cid", { time: new Date(Date.now() + 120_000) }),
    ).rejects.toThrow("paused sleep end time");
  });
});

describe("pauseSleep / resumeSleep", () => {
  it("pause stamps timerEndTime on an active unpaused timer", async () => {
    mockGetDoc.mockResolvedValueOnce(
      timerDoc({ active: true, paused: false, timerStartTime: 1000 }),
    );
    await pauseSleep(client, "cid");

    const [ref, patch] = mockUpdateDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(ref.path).toBe("sleep/cid");
    expect(patch["timer.paused"]).toBe(true);
    expect(patch["timer.timerEndTime"]).toEqual(expect.any(Number));
  });

  it("pause is a no-op when not active", async () => {
    mockGetDoc.mockResolvedValueOnce(timerDoc({ active: false, paused: false }));
    await pauseSleep(client, "cid");
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });

  it("resume clears paused without touching timerEndTime", async () => {
    mockGetDoc.mockResolvedValueOnce(
      timerDoc({ active: true, paused: true, timerEndTime: 42, timerStartTime: 10 }),
    );
    await resumeSleep(client, "cid");

    const [, patch] = mockUpdateDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(patch["timer.paused"]).toBe(false);
    expect(patch["timer.timerEndTime"]).toBeUndefined();
  });
});

describe("cancelSleep", () => {
  it("resets to an inactive timer and keeps the session uuid", async () => {
    mockGetDoc.mockResolvedValueOnce(
      timerDoc({ active: true, paused: true, timerStartTime: 5, uuid: "sess" }),
    );
    await cancelSleep(client, "cid");

    const [ref, patch] = mockUpdateDoc.mock.calls[0] as [
      { path: string },
      { timer: Record<string, unknown> },
    ];
    expect(ref.path).toBe("sleep/cid");
    expect(patch.timer).toMatchObject({
      active: false,
      paused: false,
      timerStartTime: null,
      uuid: "sess",
    });
  });
});

describe("completeSleep", () => {
  const ACTIVE = (startMs: number, extra: Record<string, unknown> = {}) =>
    timerDoc({ active: true, paused: false, timerStartTime: startMs, uuid: "sess", ...extra });

  it("writes a seconds-based interval + prefs.lastSleep and resets the timer", async () => {
    const startMs = Date.now() - 300_000;
    mockGetDoc.mockResolvedValueOnce(ACTIVE(startMs));

    const saved = await completeSleep(client, "cid");
    expect(saved).not.toBeNull();
    expect(saved?.durationSec).toBeGreaterThanOrEqual(295);
    expect(saved?.durationSec).toBeLessThanOrEqual(305);

    const [colRef, body] = mockAddDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(colRef.path).toBe("sleep/cid/intervals");
    expect(body.start).toBe(Math.floor(startMs / 1000));
    expect(body.offset).toBe(OFFSET);
    expect(body.end_offset).toBe(OFFSET);

    const [parent, prefsPatch] = mockSetDoc.mock.calls[0] as [
      { path: string },
      { prefs: Record<string, unknown> },
    ];
    expect(parent.path).toBe("sleep/cid");
    expect(prefsPatch.prefs).toMatchObject({
      lastSleep: { start: Math.floor(startMs / 1000), offset: OFFSET },
    });

    const [, resetPatch] = mockUpdateDoc.mock.calls.at(-1) as [
      { path: string },
      { timer: Record<string, unknown> },
    ];
    expect(resetPatch.timer).toMatchObject({ active: false, paused: false, timerStartTime: null });
  });

  it("uses the paused timerEndTime as the default end", async () => {
    const startMs = Date.now() - 600_000;
    const pausedEnd = Date.now() - 100_000;
    mockGetDoc.mockResolvedValueOnce(ACTIVE(startMs, { paused: true, timerEndTime: pausedEnd }));

    const saved = await completeSleep(client, "cid");
    expect(saved?.durationSec).toBeGreaterThanOrEqual(495);
    expect(saved?.durationSec).toBeLessThanOrEqual(505);
  });

  it("honors explicit end overrides over the paused timerEnd", async () => {
    const startMs = Date.now() - 600_000;
    mockGetDoc.mockResolvedValueOnce(
      ACTIVE(startMs, { paused: true, timerEndTime: Date.now() - 500_000 }),
    );

    const explicitEnd = Date.now() - 1000;
    const saved = await completeSleep(client, "cid", { end: new Date(explicitEnd) });
    expect(saved?.durationSec).toBeGreaterThanOrEqual(590);
  });

  it("throws when end precedes start", async () => {
    mockGetDoc.mockResolvedValueOnce(ACTIVE(Date.now() - 1000));
    await expect(
      completeSleep(client, "cid", { end: new Date(Date.now() - 10_000) }),
    ).rejects.toThrow("end must not precede start");
  });

  it("is a no-op when the timer is already inactive", async () => {
    mockGetDoc.mockResolvedValueOnce(timerDoc({ active: false, paused: false }));
    const saved = await completeSleep(client, "cid");
    expect(saved).toBeNull();
    expect(mockAddDoc).not.toHaveBeenCalled();
  });

  it("drops a broken timer lacking startTime instead of logging garbage", async () => {
    mockGetDoc.mockResolvedValueOnce(timerDoc({ active: true, paused: false }));
    const saved = await completeSleep(client, "cid");
    expect(saved).toBeNull();
    const [, patch] = mockUpdateDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(patch.timer).toEqual({ __sentinel: "DELETE_FIELD" });
  });
});
