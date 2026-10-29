import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server/server.js";
import "../tools/sleep.js";
import { HuckleberryClient } from "../client/HuckleberryClient.js";
import {
  getUser,
  getDefaultChildUid,
  logSleep,
  getSleepHistory,
  editSleep,
  logNursing,
  logBottle,
  logSolids,
  getFeedHistory,
  editFeed,
  logPump,
  listPumpIntervals,
  editPump,
  logDiaper,
  logPotty,
  getDiaperHistory,
  editDiaper,
  logGrowth,
  getGrowthHistory,
  editGrowth,
} from "../client/index.js";

/**
 * Resolves the child to operate on for live tests.
 *
 * Safety: with multiple children on one account, `getDefaultChildUid`'
 * default (lastChild / childList[0]) could select a REAL child. When
 * HUCKLEBERRY_TEST_CHILD_UID is set we pin all live (especially write)
 * tests to that child explicitly.
 */
async function resolveLiveChildUid(client: HuckleberryClient): Promise<string> {
  const pinned = process.env.HUCKLEBERRY_TEST_CHILD_UID?.trim();
  if (pinned) {
    const { childUids } = await getUser(client);
    if (!childUids.includes(pinned)) {
      throw new Error(`HUCKLEBERRY_TEST_CHILD_UID ${pinned} is not in this account's childList`);
    }
    return pinned;
  }
  return getDefaultChildUid(client);
}
/**
 * T3.2 — Live WRITE round-trip suite. For each tracker it logs a real entry
 * (with a unique `notes`), reads it back to prove the write landed in Firestore
 * AND that `notes` round-trips, then edits the note via the tracker's `edit_*`
 * op and reads it back again to prove the edit landed, then deletes it to
 * exercise the delete path. Unlike the read-only `live.integration.test.ts`,
 * this MUTATES the account, so it is double-gated:
 *
 *   - HUCKLEBERRY_EMAIL + HUCKLEBERRY_PASSWORD must be set (as for all live tests), and
 *   - HUCKLEBERRY_ALLOW_WRITES=1 must be set as an explicit opt-in.
 *
 * Run against a TEST account only:
 *
 *   HUCKLEBERRY_EMAIL=… HUCKLEBERRY_PASSWORD=… HUCKLEBERRY_ALLOW_WRITES=1 \
 *     npm run test:integration
 *
 * Each `log*` op returns the new doc id, so cleanup is deterministic via
 * client.deleteDoc(...). If an assertion fails mid-test the entry is still
 * deleted in `finally`. Note: writes also bump the parent `prefs.last*` summary;
 * that is left as-is (harmless, just reflects the most recent entry).
 */
const email = process.env.HUCKLEBERRY_EMAIL;
const password = process.env.HUCKLEBERRY_PASSWORD;
const allowWrites = process.env.HUCKLEBERRY_ALLOW_WRITES === "1";
const enabled = Boolean(email && password) && allowWrites;

// Distinct, slightly-in-the-past epoch seconds per call so each test's entry is
// uniquely identifiable by `start` even when several run within the same second.
let seq = 0;
function uniqueStart(): number {
  return Math.floor(Date.now() / 1000) - seq++ * 1000;
}

function makeClient(): HuckleberryClient {
  return new HuckleberryClient({ credentials: { email: email!, password: password! } });
}

/** An entry as surfaced by the read/history ops, narrowed to what we assert on. */
type ReadEntry = { start: number; notes?: string };

/** An optional edit step: mutate the entry, then assert the new notes value. */
interface EditStep {
  run: (client: HuckleberryClient, cid: string, id: string) => Promise<void>;
  expectedNotes: string;
}

/**
 * write → read-back (present + notes) → [edit → read-back (new notes)] →
 * delete → read-back (gone). The entry is matched by its unique `start`, which
 * the edit step must not change. `deleteSegments` builds the doc path to delete.
 */
async function roundTrip(
  write: (client: HuckleberryClient, cid: string) => Promise<string>,
  readEntries: (client: HuckleberryClient, cid: string) => Promise<ReadEntry[]>,
  deleteSegments: (cid: string, id: string) => [string, ...string[]],
  expectedStart: number,
  expectedNotes: string,
  edit: EditStep,
): Promise<void> {
  const client = makeClient();
  try {
    const cid = await resolveLiveChildUid(client);
    const id = await write(client, cid);
    let cleaned = false;
    try {
      const before = await readEntries(client, cid);
      const entry = before.find((e) => e.start === expectedStart);
      expect(entry, `entry with start=${expectedStart} should have been written`).toBeDefined();
      expect(entry?.notes).toBe(expectedNotes);

      await edit.run(client, cid, id);
      const afterEdit = await readEntries(client, cid);
      const edited = afterEdit.find((e) => e.start === expectedStart);
      expect(edited?.notes, "edit_* should have updated notes").toBe(edit.expectedNotes);

      const [path, ...segments] = deleteSegments(cid, id);
      await client.deleteDoc(path, ...segments);
      cleaned = true;

      const after = await readEntries(client, cid);
      expect(after.find((e) => e.start === expectedStart)).toBeUndefined();
    } finally {
      if (!cleaned) {
        const [path, ...segments] = deleteSegments(cid, id);
        await client.deleteDoc(path, ...segments).catch(() => undefined);
      }
    }
  } finally {
    await client.signOut();
  }
}

describe.skipIf(!enabled)("live write round-trip (log_* + edit_* + delete)", () => {
  it("sleep: log, read, edit_sleep, delete", { timeout: 30000 }, async () => {
    // logSleep stores the sleep START (startDate), not the end — match on that.
    const end = uniqueStart();
    const sleepStart = end - 3600;
    const notes = "sleep round-trip note";
    const edited = `${notes} (edited)`;
    await roundTrip(
      (client, cid) =>
        logSleep(client, cid, new Date(sleepStart * 1000), new Date(end * 1000), { notes }),
      async (client, cid) => getSleepHistory(client, cid, { limit: 50 }),
      (cid, id) => ["sleep", cid, "intervals", id],
      sleepStart,
      notes,
      {
        run: (client, cid, id) => editSleep(client, cid, id, { notes: edited }),
        expectedNotes: edited,
      },
    );
  });

  // BUG1 regression: log_sleep's tool schema used to treat start/end as
  // milliseconds and skip the seconds->ms conversion, collapsing any real
  // window down to ~a millisecond of duration. The ops-layer round-trip above
  // calls `logSleep` directly and would never have caught this — it bypasses
  // the tool boundary where the bug actually lived. This goes through the
  // real `log_sleep` MCP tool against production to prove the fix holds there.
  it(
    "sleep: log via the log_sleep MCP tool records the real window (BUG1)",
    { timeout: 30000 },
    async () => {
      const end = uniqueStart();
      const sleepStart = end - 1800; // 30-minute window
      const client = makeClient();
      let id: string | undefined;
      let cid: string | undefined;
      try {
        cid = await resolveLiveChildUid(client);

        const server = createServer();
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const mcpClient = new Client({ name: "test", version: "0" }, { capabilities: {} });
        await mcpClient.connect(clientTransport);

        const result = await mcpClient.callTool({
          name: "log_sleep",
          arguments: { child_uid: cid, start: sleepStart, end },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const text =
          result.content?.[0]?.type === "text"
            ? (result.content[0] as { text: string }).text
            : "{}";
        id = (JSON.parse(text) as { sleep_id: string }).sleep_id;

        const entries = await getSleepHistory(client, cid, { limit: 50 });
        const entry = entries.find((e) => e.start === sleepStart);
        expect(entry, `entry with start=${sleepStart} should have been written`).toBeDefined();
        expect(entry?.duration).toBe(1800);
      } finally {
        if (id && cid) await client.deleteDoc("sleep", cid, "intervals", id);
        await client.signOut();
      }
    },
  );

  it("nursing: log, read, edit_feed, delete", { timeout: 30000 }, async () => {
    const start = uniqueStart();
    const notes = "nursing round-trip note";
    const edited = `${notes} (edited)`;
    await roundTrip(
      (client, cid) =>
        logNursing(client, cid, {
          start,
          leftDuration: 300,
          rightDuration: 300,
          lastSide: "left",
          notes,
        }),
      async (client, cid) => getFeedHistory(client, cid, { limit: 50 }),
      (cid, id) => ["feed", cid, "intervals", id],
      start,
      notes,
      {
        run: (client, cid, id) => editFeed(client, cid, id, { notes: edited }),
        expectedNotes: edited,
      },
    );
  });

  it("bottle: log, read, edit_feed, delete", { timeout: 30000 }, async () => {
    const start = uniqueStart();
    const notes = "bottle round-trip note";
    const edited = `${notes} (edited)`;
    await roundTrip(
      (client, cid) =>
        logBottle(client, cid, { start, amount: 120, bottleType: "Formula", units: "ml", notes }),
      async (client, cid) => getFeedHistory(client, cid, { limit: 50 }),
      (cid, id) => ["feed", cid, "intervals", id],
      start,
      notes,
      {
        run: (client, cid, id) => editFeed(client, cid, id, { notes: edited }),
        expectedNotes: edited,
      },
    );
  });

  it("solids: log, read, edit_feed, delete", { timeout: 30000 }, async () => {
    const start = uniqueStart();
    const notes = "solids round-trip note";
    const edited = `${notes} (edited)`;
    await roundTrip(
      (client, cid) => logSolids(client, cid, { start, notes }),
      async (client, cid) => getFeedHistory(client, cid, { limit: 50 }),
      (cid, id) => ["feed", cid, "intervals", id],
      start,
      notes,
      {
        run: (client, cid, id) => editFeed(client, cid, id, { notes: edited }),
        expectedNotes: edited,
      },
    );
  });

  it("pump: log, read, edit_pump, delete", { timeout: 30000 }, async () => {
    const start = uniqueStart();
    const notes = "pump round-trip note";
    const edited = `${notes} (edited)`;
    await roundTrip(
      (client, cid) =>
        logPump(client, cid, {
          start,
          leftAmount: 60,
          rightAmount: 60,
          units: "ml",
          duration: 600,
          notes,
        }),
      async (client, cid) => listPumpIntervals(client, cid, { limit: 50 }),
      (cid, id) => ["pump", cid, "intervals", id],
      start,
      notes,
      {
        run: (client, cid, id) => editPump(client, cid, id, { notes: edited }),
        expectedNotes: edited,
      },
    );
  });

  it("diaper: log, read, edit_diaper, delete", { timeout: 30000 }, async () => {
    const start = uniqueStart();
    const notes = "diaper round-trip note";
    const edited = `${notes} (edited)`;
    await roundTrip(
      (client, cid) =>
        logDiaper(client, cid, {
          mode: "both",
          start,
          peeAmount: "little",
          pooAmount: "medium",
          color: "yellow",
          notes,
        }),
      async (client, cid) => getDiaperHistory(client, cid, { limit: 50 }),
      (cid, id) => ["diaper", cid, "intervals", id],
      start,
      notes,
      {
        run: (client, cid, id) => editDiaper(client, cid, id, { notes: edited }),
        expectedNotes: edited,
      },
    );
  });

  it("potty: log, read, edit_diaper, delete", { timeout: 30000 }, async () => {
    const start = uniqueStart();
    const notes = "potty round-trip note";
    const edited = `${notes} (edited)`;
    await roundTrip(
      (client, cid) => logPotty(client, cid, { mode: "pee", start, notes }),
      async (client, cid) => getDiaperHistory(client, cid, { limit: 50 }),
      (cid, id) => ["diaper", cid, "intervals", id],
      start,
      notes,
      {
        run: (client, cid, id) => editDiaper(client, cid, id, { notes: edited }),
        expectedNotes: edited,
      },
    );
  });

  it("growth: log, read, edit_growth, delete", { timeout: 30000 }, async () => {
    const start = uniqueStart();
    const notes = "growth round-trip note";
    const edited = `${notes} (edited)`;
    await roundTrip(
      (client, cid) =>
        logGrowth(client, cid, {
          weight: 5.5,
          units: "metric",
          time: new Date(start * 1000),
          notes,
        }),
      async (client, cid) => getGrowthHistory(client, cid, { limit: 50 }),
      (cid, id) => ["health", cid, "data", id],
      start,
      notes,
      {
        run: (client, cid, id) => editGrowth(client, cid, id, { notes: edited }),
        expectedNotes: edited,
      },
    );
  });
});
