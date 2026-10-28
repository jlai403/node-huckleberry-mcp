import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HuckleberryClient } from "../client/HuckleberryClient.js";

// Mock firebase/firestore so we can assert the exact document bodies written.
// collection()/doc() return the path so we can verify the right collection.
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
  mockAddDoc: vi.fn(async () => ({ id: "new-id" })),
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
  logNursing,
  logBottle,
  logSolids,
  logPump,
  listPumpIntervals,
  getFeedHistory,
  editFeed,
  editPump,
  deleteFeed,
  deletePump,
  getFeedDoc,
  startNursing,
  pauseNursing,
  resumeNursing,
  switchNursingSide,
  cancelNursing,
  completeNursing,
} from "../client/feedOps.js";

const OFFSET = -480;
const client = {
  connect: vi.fn(async () => ({})),
  getFirestore: () => ({}),
  getOffsetMinutes: () => OFFSET,
} as unknown as HuckleberryClient;

function lastInterval() {
  return mockAddDoc.mock.calls[0][1] as Record<string, unknown>;
}
function lastIntervalPath() {
  return (mockAddDoc.mock.calls[0][0] as { path: string }).path;
}
function lastPrefs() {
  return (mockSetDoc.mock.calls[0][1] as { prefs: Record<string, unknown> }).prefs;
}

beforeEach(() => vi.clearAllMocks());

describe("feedOps writes", () => {
  it("logNursing writes to feed/intervals with seconds-duration prefs (no /1000)", async () => {
    await logNursing(client, "cid", {
      start: 1000,
      leftDuration: 600,
      rightDuration: 600,
      lastSide: "left",
    });
    expect(lastIntervalPath()).toBe("feed/cid/intervals");
    expect(lastInterval()).toMatchObject({
      mode: "breast",
      start: 1000,
      offset: OFFSET,
      leftDuration: 600,
      rightDuration: 600,
      lastSide: "left",
    });
    const prefs = lastPrefs() as { lastFeed: { duration: number }; lastSide: unknown };
    // Regression: durations are seconds already → 600+600 = 1200, not 1.2.
    expect(prefs.lastFeed.duration).toBe(1200);
    expect(prefs.lastSide).toEqual({ lastSide: "left", start: 1000 });
  });

  it("logBottle writes feed/intervals + bottle prefs (with optional notes)", async () => {
    await logBottle(client, "cid", {
      start: 5,
      amount: 177,
      bottleType: "Breast Milk",
      units: "ml",
      notes: "took it well",
    });
    expect(lastIntervalPath()).toBe("feed/cid/intervals");
    expect(lastInterval()).toMatchObject({
      mode: "bottle",
      amount: 177,
      bottleType: "Breast Milk",
      units: "ml",
      notes: "took it well",
    });
    expect(lastPrefs()).toMatchObject({
      bottleAmount: 177,
      bottleUnits: "ml",
      bottleType: "Breast Milk",
    });
  });

  it("logBottle omits notes when not provided", async () => {
    await logBottle(client, "cid", { start: 5, amount: 90, bottleType: "Formula", units: "ml" });
    expect(lastInterval().notes).toBeUndefined();
  });

  it("logSolids writes feed/intervals with mode solids", async () => {
    await logSolids(client, "cid", { start: 9 });
    expect(lastIntervalPath()).toBe("feed/cid/intervals");
    expect(lastInterval()).toMatchObject({ mode: "solids", start: 9, offset: OFFSET });
    expect(lastInterval().notes).toBeUndefined();
  });

  it("logNursing, logSolids and logPump write notes when provided", async () => {
    await logNursing(client, "cid", { start: 1, notes: "sleepy feed" });
    expect(lastInterval().notes).toBe("sleepy feed");
    vi.clearAllMocks();
    await logSolids(client, "cid", { start: 2, notes: "avocado" });
    expect(lastInterval().notes).toBe("avocado");
    vi.clearAllMocks();
    await logPump(client, "cid", {
      start: 3,
      leftAmount: 30,
      rightAmount: 30,
      units: "ml",
      notes: "morning pump",
    });
    expect(lastInterval().notes).toBe("morning pump");
  });

  it("logPump writes to the pump collection and splits totalAmount", async () => {
    await logPump(client, "cid", {
      start: 1,
      leftAmount: 0,
      rightAmount: 0,
      units: "oz",
      totalAmount: 12,
      duration: 480,
    });
    expect(lastIntervalPath()).toBe("pump/cid/intervals");
    expect(lastInterval()).toMatchObject({
      entryMode: "total",
      leftAmount: 6,
      rightAmount: 6,
      units: "oz",
      duration: 480,
    });
  });
});

describe("feedOps reads", () => {
  it("listPumpIntervals parses pump-shaped docs (no `mode` field)", async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        {
          id: "pump-1",
          data: () => ({
            entryMode: "total",
            start: 1,
            offset: OFFSET,
            leftAmount: 6,
            rightAmount: 6,
            units: "oz",
            duration: 480,
            lastUpdated: 2,
          }),
        },
      ],
    });
    // Regression: parsing pump docs with the FeedingInterval union threw (no `mode`).
    const res = await listPumpIntervals(client, "cid");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: "pump-1", entryMode: "total", leftAmount: 6, units: "oz" });
  });

  it("getFeedHistory includes the doc id (needed for editFeed)", async () => {
    mockGetDocs.mockResolvedValue({
      docs: [
        { id: "feed-123", data: () => ({ mode: "bottle", start: 1, amount: 90, units: "ml" }) },
      ],
    });
    const res = await getFeedHistory(client, "cid");
    expect(res[0]).toMatchObject({ id: "feed-123", mode: "bottle", amount: 90 });
  });
});

describe("editFeed", () => {
  it("updates only provided fields on feed/{cid}/intervals/{id} + bumps lastUpdated", async () => {
    await editFeed(client, "cid", "feed-123", { amount: 150, units: "ml" });
    const [ref, patch] = mockUpdateDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(ref.path).toBe("feed/cid/intervals/feed-123");
    expect(patch).toMatchObject({ amount: 150, units: "ml" });
    expect(typeof patch.lastUpdated).toBe("number");
    expect(patch.bottleType).toBeUndefined();
  });

  it("throws when no fields are provided", async () => {
    await expect(editFeed(client, "cid", "feed-123", {})).rejects.toThrow("at least one");
  });
});

describe("editPump", () => {
  it("updates only provided fields on pump/{cid}/intervals/{id} + bumps lastUpdated", async () => {
    await editPump(client, "cid", "pump-1", { leftAmount: 50, units: "ml" });
    const [ref, patch] = mockUpdateDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    expect(ref.path).toBe("pump/cid/intervals/pump-1");
    expect(patch).toMatchObject({ leftAmount: 50, units: "ml" });
    expect(typeof patch.lastUpdated).toBe("number");
    expect(patch.rightAmount).toBeUndefined();
  });

  it("throws when no fields are provided", async () => {
    await expect(editPump(client, "cid", "pump-1", {})).rejects.toThrow("at least one");
  });
});

describe("deleteFeed / deletePump", () => {
  it("deleteFeed deletes feed/{cid}/intervals/{id}", async () => {
    await deleteFeed(client, "cid", "feed-123");
    expect((mockDeleteDoc.mock.calls[0][0] as { path: string }).path).toBe(
      "feed/cid/intervals/feed-123",
    );
  });

  it("deletePump deletes pump/{cid}/intervals/{id}", async () => {
    await deletePump(client, "cid", "pump-1");
    expect((mockDeleteDoc.mock.calls[0][0] as { path: string }).path).toBe(
      "pump/cid/intervals/pump-1",
    );
  });
});

// ── Live nursing timer ────────────────────────────────────────────────────────

function feedTimerDoc(timer: Record<string, unknown>) {
  return { exists: () => true, data: () => ({ timer }) };
}

function lastUpdateCall(): { path: string; patch: Record<string, unknown> } {
  const [ref, patch] = mockUpdateDoc.mock.calls.at(-1) as [
    { path: string },
    Record<string, unknown>,
  ];
  return { path: ref.path, patch };
}

describe("getFeedDoc", () => {
  it("returns null timer for a missing feed doc", async () => {
    const got = await getFeedDoc(client, "cid");
    expect(got.timer).toBeNull();
  });

  it("parses the timer (seconds-based)", async () => {
    mockGetDoc.mockResolvedValueOnce(feedTimerDoc({ active: true, timerStartTime: 1000 }));
    const got = await getFeedDoc(client, "cid");
    expect(got.timer).toMatchObject({ active: true, timerStartTime: 1000 });
  });
});

describe("startNursing", () => {
  it("starts fresh with zeroed durations and defaults", async () => {
    await startNursing(client, "cid", { side: "right", time: new Date(Date.now()) });

    const [ref, patch] = mockSetDoc.mock.calls[0] as [
      { path: string },
      { timer: Record<string, unknown> },
    ];
    expect(ref.path).toBe("feed/cid");
    expect(patch.timer).toMatchObject({
      active: true,
      paused: false,
      leftDuration: 0,
      rightDuration: 0,
      lastSide: "left",
      activeSide: "right",
    });
    expect(patch.timer.uuid).toHaveLength(16);
  });

  it("moves the session start on repeat start with explicit time", async () => {
    mockGetDoc.mockResolvedValueOnce(
      feedTimerDoc({ active: true, paused: false, feedStartTime: 1000, timerStartTime: 1000 }),
    );
    const result = await startNursing(client, "cid", { time: new Date(Date.now()) });

    expect(result).toEqual({ moved: true });
    const { patch } = lastUpdateCall();
    expect(patch["timer.feedStartTime"]).toStrictEqual(expect.any(Number));
    expect(patch["timer.timestamp"]).toEqual({ seconds: expect.any(Number) });
  });

  it("keeps the segment start when the shift would push it into the future", async () => {
    mockGetDoc.mockResolvedValueOnce(
      feedTimerDoc({
        active: true,
        paused: false,
        feedStartTime: 1000,
        timerStartTime: Date.now() / 1000 - 30,
      }),
    );
    const result = await startNursing(client, "cid", { time: new Date(Date.now() + 3600_000) });

    expect(result).toEqual({ moved: true });
    const { patch } = lastUpdateCall();
    // segment start ≈ unchanged (kept); session start moved forward
    expect(patch["timer.timerStartTime"]).toBeLessThan(Date.now() / 1000);
    expect(patch["timer.feedStartTime"]).toBeGreaterThan(Date.now() / 1000);
  });
});

describe("pauseNursing / resumeNursing / switchNursingSide", () => {
  it("pause banks elapsed into activeSide and clears activeSide", async () => {
    mockGetDoc.mockResolvedValueOnce(
      feedTimerDoc({
        active: true,
        paused: false,
        timerStartTime: Date.now() / 1000 - 60,
        leftDuration: 10,
        rightDuration: 20,
        activeSide: "right",
      }),
    );
    await pauseNursing(client, "cid");

    const { patch } = lastUpdateCall();
    expect(patch["timer.paused"]).toBe(true);
    expect(patch["timer.leftDuration"]).toBe(10);
    expect(patch["timer.rightDuration"]).toBeGreaterThanOrEqual(79); // ~60s banked
    expect(patch["timer.lastSide"]).toBe("right");
    expect(patch["timer.activeSide"]).toEqual({ __sentinel: "DELETE_FIELD" });
  });

  it("resume resets segment start and marks transition lastSide none", async () => {
    mockGetDoc.mockResolvedValueOnce(
      feedTimerDoc({
        active: true,
        paused: true,
        lastSide: "right",
        leftDuration: 5,
        rightDuration: 8,
      }),
    );
    await resumeNursing(client, "cid");

    const { patch } = lastUpdateCall();
    expect(patch["timer.paused"]).toBe(false);
    expect(patch["timer.activeSide"]).toBe("right"); // back to lastSide
    expect(patch["timer.lastSide"]).toBe("none");
    expect(typeof patch["timer.timerStartTime"]).toBe("number");
  });

  it("switch banks the running side and flips", async () => {
    mockGetDoc.mockResolvedValueOnce(
      feedTimerDoc({
        active: true,
        paused: false,
        timerStartTime: Date.now() / 1000 - 30,
        leftDuration: 0,
        rightDuration: 0,
        activeSide: "left",
      }),
    );
    await switchNursingSide(client, "cid");

    const { patch } = lastUpdateCall();
    expect(patch["timer.activeSide"]).toBe("right");
    expect(patch["timer.leftDuration"]).toBeGreaterThanOrEqual(29);
    expect(patch["timer.rightDuration"]).toBe(0);
  });

  it("switch without elapsed banks nothing when paused", async () => {
    mockGetDoc.mockResolvedValueOnce(
      feedTimerDoc({
        active: true,
        paused: true,
        timerStartTime: Date.now() / 1000 - 999,
        leftDuration: 12,
        rightDuration: 34,
        lastSide: "left",
      }),
    );
    await switchNursingSide(client, "cid");

    const { patch } = lastUpdateCall();
    expect(patch["timer.leftDuration"]).toBe(12);
    expect(patch["timer.rightDuration"]).toBe(34);
  });
});

describe("cancelNursing / completeNursing", () => {
  it("cancel resets to the inactive zeroed timer, keeping uuid", async () => {
    mockGetDoc.mockResolvedValueOnce(feedTimerDoc({ active: true, uuid: "sess" }));
    await cancelNursing(client, "cid");

    const { patch } = lastUpdateCall();
    expect(patch.timer).toMatchObject({
      active: false,
      paused: false,
      timerStartTime: null,
      leftDuration: 0,
      rightDuration: 0,
      lastSide: "left",
    });
    expect((patch.timer as Record<string, unknown>).uuid).toBe("sess");
  });

  it("complete banks the running segment, writes a breast interval + prefs, resets timer", async () => {
    mockGetDoc.mockResolvedValueOnce(
      feedTimerDoc({
        active: true,
        paused: false,
        feedStartTime: Date.now() / 1000 - 120,
        timerStartTime: Date.now() / 1000 - 60,
        leftDuration: 60,
        rightDuration: 20,
        activeSide: "left",
        uuid: "sess",
      }),
    );
    const saved = await completeNursing(client, "cid");

    expect(saved).not.toBeNull();
    // Total was trimmed to the corrected span (upstream semantics): 60+20+~60
    // accumulated > 120s span → left side trimmed to fit.
    expect(saved?.total).toBeLessThanOrEqual(125);
    expect(saved?.total).toBeGreaterThanOrEqual(115);
    expect(saved?.right).toBe(20);

    const [ref, interval] = mockSetDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
    const id = ref.path.split("/").at(-1) ?? "";
    expect(ref.path).toBe(`feed/cid/intervals/${id}`);
    expect(interval).toMatchObject({
      mode: "breast",
      lastSide: "left",
      offset: OFFSET,
      end_offset: OFFSET,
    });
    expect(id.length).toBeGreaterThan(20); // "{ms}-{20hex}" shape

    const { patch } = lastUpdateCall();
    expect(patch["timer.active"]).toBe(false);
    expect(patch["prefs.lastFeed"]).toMatchObject({ mode: "breast", duration: saved?.total });
    expect(patch["prefs.lastSide"]).toMatchObject({ lastSide: "left" });
    expect(patch["timer.leftDuration"]).toEqual({ __sentinel: "DELETE_FIELD" });
  });

  it("is a no-op when the timer is inactive", async () => {
    mockGetDoc.mockResolvedValueOnce(feedTimerDoc({ active: false }));
    const saved = await completeNursing(client, "cid");
    expect(saved).toBeNull();
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it("throws when end precedes the running segment start", async () => {
    mockGetDoc.mockResolvedValueOnce(
      feedTimerDoc({
        active: true,
        paused: false,
        timerStartTime: Date.now() / 1000,
        leftDuration: 0,
        rightDuration: 0,
        activeSide: "left",
        feedStartTime: Date.now() / 1000,
      }),
    );
    await expect(
      completeNursing(client, "cid", { end: new Date(Date.now() - 10_000) }),
    ).rejects.toThrow("end must not precede");
  });
});
