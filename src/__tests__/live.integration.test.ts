import { describe, it, expect } from "vitest";
import { HuckleberryClient } from "../client/HuckleberryClient.js";
import {
  getUser,
  getChildren,
  getDefaultChildUid,
  getSleepHistory,
  getFeedHistory,
  listPumpIntervals,
  getDiaperHistory,
  getGrowthHistory,
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
 * T3.2 — Live integration suite. Runs against a REAL Huckleberry account and is
 * skipped unless HUCKLEBERRY_EMAIL and HUCKLEBERRY_PASSWORD are set, so CI (which
 * has no credentials) skips it by default.
 *
 *   HUCKLEBERRY_EMAIL=… HUCKLEBERRY_PASSWORD=… npm run test:integration
 *
 * Read-only. The tracker read-back tests below pull real entries and parse them
 * with the ported Zod models — a parse failure means the model/schema is wrong.
 * They require that the account has at least one entry per tracker (log them in
 * the app first; see docs/integration-testing.md).
 */
const email = process.env.HUCKLEBERRY_EMAIL;
const password = process.env.HUCKLEBERRY_PASSWORD;
const hasCreds = Boolean(email && password);

describe.skipIf(!hasCreds)("live integration (real account)", () => {
  function makeClient(): HuckleberryClient {
    return new HuckleberryClient({ credentials: { email: email!, password: password! } });
  }

  it(
    "authenticates and reads the user document with a child list",
    { timeout: 20000 },
    async () => {
      const client = makeClient();
      try {
        const { user, childUids } = await getUser(client);
        expect(user).toBeTruthy();
        expect(Array.isArray(childUids)).toBe(true);
      } finally {
        await client.signOut();
      }
    },
  );

  it("reads child profiles for the account", { timeout: 20000 }, async () => {
    const client = makeClient();
    try {
      const children = await getChildren(client);
      expect(Array.isArray(children)).toBe(true);
    } finally {
      await client.signOut();
    }
  });
});

// Reads each tracker and parses it with the ported models. If a real document
// doesn't match the model, the read function's Zod .parse() throws and the test
// fails — validating the schema port against real data with zero writes.
describe.skipIf(!hasCreds)("live schema read-back", () => {
  it(
    "sleep intervals parse and carry numeric start/duration/offset",
    { timeout: 20000 },
    async () => {
      const client = new HuckleberryClient({ credentials: { email: email!, password: password! } });
      try {
        const cid = await resolveLiveChildUid(client);
        const items = await getSleepHistory(client, cid, { limit: 5 });
        expect(Array.isArray(items)).toBe(true);
        if (items.length > 0) {
          expect(typeof items[0].start).toBe("number");
          expect(typeof items[0].duration).toBe("number");
          expect(typeof items[0].offset).toBe("number");
        }
      } finally {
        await client.signOut();
      }
    },
  );

  it("feed intervals parse with a mode discriminator", { timeout: 20000 }, async () => {
    const client = new HuckleberryClient({ credentials: { email: email!, password: password! } });
    try {
      const cid = await resolveLiveChildUid(client);
      const items = await getFeedHistory(client, cid, { limit: 10 });
      expect(Array.isArray(items)).toBe(true);
      if (items.length > 0) {
        expect(["breast", "bottle", "solids"]).toContain(items[0].mode);
        expect(typeof items[0].start).toBe("number");
      }
    } finally {
      await client.signOut();
    }
  });

  it("pump intervals parse with entryMode + amounts", { timeout: 20000 }, async () => {
    const client = new HuckleberryClient({ credentials: { email: email!, password: password! } });
    try {
      const cid = await resolveLiveChildUid(client);
      const items = await listPumpIntervals(client, cid, { limit: 5 });
      expect(Array.isArray(items)).toBe(true);
      if (items.length > 0) {
        expect(["total", "leftright"]).toContain(items[0].entryMode);
        expect(typeof items[0].leftAmount).toBe("number");
      }
    } finally {
      await client.signOut();
    }
  });

  it("diaper intervals parse with mode + numeric start", { timeout: 20000 }, async () => {
    const client = new HuckleberryClient({ credentials: { email: email!, password: password! } });
    try {
      const cid = await resolveLiveChildUid(client);
      const items = await getDiaperHistory(client, cid, { limit: 5 });
      expect(Array.isArray(items)).toBe(true);
      if (items.length > 0) {
        expect(["pee", "poo", "both", "dry"]).toContain(items[0].mode);
        expect(typeof items[0].start).toBe("number");
      }
    } finally {
      await client.signOut();
    }
  });

  it("growth entries parse with mode growth + numeric start", { timeout: 20000 }, async () => {
    const client = new HuckleberryClient({ credentials: { email: email!, password: password! } });
    try {
      const cid = await resolveLiveChildUid(client);
      const items = await getGrowthHistory(client, cid, { limit: 5 });
      expect(Array.isArray(items)).toBe(true);
      if (items.length > 0) {
        expect(items[0].mode).toBe("growth");
        expect(typeof items[0].start).toBe("number");
      }
    } finally {
      await client.signOut();
    }
  });
});
