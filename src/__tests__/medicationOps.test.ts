import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HuckleberryClient } from "../client/HuckleberryClient.js";

const { mockAddDoc, mockSetDoc, mockGetDoc, mockGetDocs, mockCollection, mockDoc } = vi.hoisted(
  () => ({
    mockAddDoc: vi.fn(),
    mockSetDoc: vi.fn(async () => undefined),
    mockGetDoc: vi.fn(),
    mockGetDocs: vi.fn(),
    mockCollection: vi.fn((_db: unknown, ...seg: string[]) => ({ path: seg.join("/") })),
    mockDoc: vi.fn((_db: unknown, ...seg: string[]) => ({ path: seg.join("/") })),
  }),
);

vi.mock("firebase/firestore", () => ({
  collection: mockCollection,
  doc: mockDoc,
  addDoc: mockAddDoc,
  setDoc: mockSetDoc,
  getDoc: mockGetDoc,
  getDocs: mockGetDocs,
  query: (col: unknown) => col,
  orderBy: () => ({}),
  limit: () => ({}),
}));

import {
  createMedicineType,
  getMedicationHistory,
  listMedicineTypes,
  logMedication,
  resolveMedicineType,
} from "../client/medicationOps.js";

const OFFSET = -360;
const client = {
  connect: vi.fn(async () => ({})),
  getFirestore: () => ({}),
  getOffsetMinutes: () => OFFSET,
} as unknown as HuckleberryClient;

const TYPES = [
  {
    id: "type-tylenol",
    data: { _id: "type-tylenol", active: true, mode: "medication", name: "Tylenol" },
  },
  {
    id: "type-vitd",
    data: { _id: "type-vitd", active: true, mode: "medication", name: "vitamin D" },
  },
  {
    id: "type-old",
    data: { _id: "type-old", active: false, mode: "medication", name: "Amoxicillin" },
  },
];

function snapshot(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  return { docs: rows.map((row) => ({ id: row.id, data: () => row.data })) };
}

function setDocCall(path: string) {
  return mockSetDoc.mock.calls.find(([ref]) => (ref as { path: string }).path === path);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDocs.mockResolvedValue(snapshot(TYPES));
  mockGetDoc.mockResolvedValue({ data: () => ({ prefs: {} }) });
  mockAddDoc.mockResolvedValue({ id: "dose-id" });
});

describe("medicationOps", () => {
  describe("listMedicineTypes", () => {
    it("keeps active medicines only, sorted by name case-insensitively", async () => {
      const types = await listMedicineTypes(client, "cid");
      expect(types.map((t) => t.name)).toEqual(["Tylenol", "vitamin D"]);
    });

    it("falls back to the document id when the _id field is missing", async () => {
      mockGetDocs.mockResolvedValue(
        snapshot([
          { id: "type-no-field", data: { active: true, mode: "medication", name: "Zinc" } },
        ]),
      );
      const [type] = await listMedicineTypes(client, "cid");
      expect(type._id).toBe("type-no-field");
    });
  });

  describe("createMedicineType", () => {
    it("writes an active medication type carrying its own id", async () => {
      const id = await createMedicineType(client, "cid", { name: "  Tylenol  " });
      const [ref, body] = setDocCall(`health/cid/types/${id}`)! as [
        { path: string },
        Record<string, unknown>,
      ];
      expect(ref.path).toBe(`health/cid/types/${id}`);
      expect(body).toEqual({ _id: id, active: true, mode: "medication", name: "Tylenol" });
    });

    it("refuses a blank name", async () => {
      await expect(createMedicineType(client, "cid", { name: "   " })).rejects.toThrow(/non-empty/);
    });
  });

  describe("resolveMedicineType", () => {
    it("matches a name case-insensitively", async () => {
      expect((await resolveMedicineType(client, "cid", "tylenol"))._id).toBe("type-tylenol");
    });

    it("refuses an unknown medicine and names what is saved", async () => {
      await expect(resolveMedicineType(client, "cid", "Tylonol")).rejects.toThrow(
        /No saved medicine matches "Tylonol"\. Saved: Tylenol, vitamin D/,
      );
    });

    it("never matches an inactive medicine", async () => {
      await expect(resolveMedicineType(client, "cid", "Amoxicillin")).rejects.toThrow(/No saved/);
    });
  });

  describe("logMedication", () => {
    it("writes the dose, the type's lastTake, and moves prefs.lastMedication", async () => {
      await logMedication(client, "cid", "Tylenol", {
        time: new Date(1_800_000_000 * 1000),
        amount: 2.5,
        units: "ml",
        notes: "for teething",
      });

      const [dataRef, entry] = mockAddDoc.mock.calls[0] as [
        { path: string },
        Record<string, unknown>,
      ];
      expect(dataRef.path).toBe("health/cid/data");
      expect(entry).toEqual({
        mode: "medication",
        start: 1_800_000_000,
        lastUpdated: expect.any(Number),
        offset: OFFSET,
        medication_id: "type-tylenol",
        medication_name: "Tylenol",
        amount: 2.5,
        units: "ml",
        notes: "for teething",
      });

      const [, lastTake] = setDocCall("health/cid/types/type-tylenol")! as [
        { path: string },
        Record<string, unknown>,
      ];
      expect(lastTake).toEqual({
        lastTake: { amount: 2.5, reminderType: "at", units: "ml" },
      });

      const [, health] = setDocCall("health/cid")! as [{ path: string }, any];
      expect(health.prefs.lastMedication).toEqual({
        mode: "medication",
        start: 1_800_000_000,
        lastUpdated: expect.any(Number),
        offset: OFFSET,
        medication_id: "type-tylenol",
        medication_name: "Tylenol",
        amount: 2.5,
        units: "ml",
        notes: "for teething",
        _id: "dose-id",
        type: "health",
        isNight: false,
        multientry_key: null,
      });
      expect(typeof health.prefs.local_timestamp).toBe("number");
    });

    it("stores amount 0.0 and omits units when no amount was measured", async () => {
      await logMedication(client, "cid", "vitamin D");
      const [, entry] = mockAddDoc.mock.calls[0] as [{ path: string }, Record<string, unknown>];
      expect(entry.amount).toBe(0);
      expect(entry).not.toHaveProperty("units");
      expect(entry.notes).toBe("");
    });

    it("requires units when an amount is given", async () => {
      await expect(logMedication(client, "cid", "Tylenol", { amount: 2.5 })).rejects.toThrow(
        /requires units/,
      );
      expect(mockAddDoc).not.toHaveBeenCalled();
    });

    it("keeps the previous summary's units when a dose carries none", async () => {
      mockGetDoc.mockResolvedValue({
        data: () => ({
          prefs: { lastMedication: { start: 1_799_000_000, units: "ml" } },
        }),
      });
      await logMedication(client, "cid", "Tylenol", { time: new Date(1_800_000_000 * 1000) });
      const [, health] = setDocCall("health/cid")! as [{ path: string }, any];
      expect(health.prefs.lastMedication.units).toBe("ml");
    });

    it("does not move prefs.lastMedication for a backfilled older dose", async () => {
      mockGetDoc.mockResolvedValue({
        data: () => ({ prefs: { lastMedication: { start: 1_800_000_000 } } }),
      });
      await logMedication(client, "cid", "Tylenol", {
        time: new Date(1_700_000_000 * 1000),
        amount: 1,
        units: "ml",
      });
      expect(mockAddDoc).toHaveBeenCalledTimes(1);
      expect(setDocCall("health/cid")).toBeUndefined();
    });

    it("logs an unknown medicine nowhere at all", async () => {
      await expect(logMedication(client, "cid", "Nope")).rejects.toThrow(/create_medicine_type/);
      expect(mockAddDoc).not.toHaveBeenCalled();
      expect(mockSetDoc).not.toHaveBeenCalled();
    });
  });

  describe("getMedicationHistory", () => {
    it("returns medication rows newest-first, never growth rows", async () => {
      mockGetDocs.mockResolvedValue(
        snapshot([
          {
            id: "dose-2",
            data: {
              mode: "medication",
              start: 300,
              medication_id: "t",
              medication_name: "Tylenol",
              amount: 2,
              units: "ml",
            },
          },
          { id: "growth-1", data: { mode: "growth", start: 250, weight: 7 } },
          {
            id: "dose-1",
            data: {
              mode: "medication",
              start: 200,
              medication_id: "t",
              medication_name: "Tylenol",
              amount: 0,
            },
          },
        ]),
      );
      const history = await getMedicationHistory(client, "cid");
      expect(history.map((h) => h.id)).toEqual(["dose-2", "dose-1"]);
      expect(history[0].units).toBe("ml");
    });
  });
});
