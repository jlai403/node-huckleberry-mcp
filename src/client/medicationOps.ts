import { addDoc, collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import type { HuckleberryClient } from "./HuckleberryClient.js";
import {
  MEDICATION_UNITS,
  MedicationEntry,
  MedicineType,
  type MedicationEntryParsed,
  type MedicationUnits,
  type MedicineTypeParsed,
} from "../models/index.js";
import { readHealthRows } from "./healthData.js";

const HEALTH = "health";

export interface LogMedicationOptions {
  /** When the dose was given (defaults to now). */
  time?: Date;
  /** Omitted for "gave the medicine" without a measured amount. */
  amount?: number;
  /** Required whenever `amount` is given. */
  units?: MedicationUnits;
  notes?: string;
}

export interface CreateMedicineTypeOptions {
  name: string;
}

/** Medicine types the app offers for this child, active only, sorted by name. */
export async function listMedicineTypes(
  client: HuckleberryClient,
  childUid: string,
): Promise<Array<MedicineTypeParsed & { _id: string }>> {
  await client.connect();
  const db = client.getFirestore();
  const snap = await getDocs(collection(db, HEALTH, childUid, "types"));
  return snap.docs
    .map((d) => {
      const type = MedicineType.parse(d.data());
      // The app writes `_id` inside the document, but the doc id is authoritative.
      return { ...type, _id: type._id ?? d.id };
    })
    .filter((type) => type.active)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** Creates a selectable medicine. Returns its id. */
export async function createMedicineType(
  client: HuckleberryClient,
  childUid: string,
  options: CreateMedicineTypeOptions,
): Promise<string> {
  const name = options.name.trim();
  if (!name) {
    throw new Error("createMedicineType requires a non-empty name");
  }

  await client.connect();
  const db = client.getFirestore();
  const typeId = `${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await setDoc(doc(db, HEALTH, childUid, "types", typeId), {
    _id: typeId,
    active: true,
    mode: "medication",
    name,
  });
  return typeId;
}

/**
 * Resolves a medicine by id or case-insensitive name. Never creates one: an
 * unmatched name is a typo far more often than a new medicine, and a silently
 * created type cannot be removed from the app.
 */
export async function resolveMedicineType(
  client: HuckleberryClient,
  childUid: string,
  medicine: string,
): Promise<MedicineTypeParsed & { _id: string }> {
  const wantedId = medicine.trim();
  const wantedName = wantedId.toLowerCase();
  const types = await listMedicineTypes(client, childUid);
  const match =
    types.find((type) => type._id === wantedId) ??
    types.find((type) => type.name.toLowerCase() === wantedName);
  if (!match) {
    const saved = types.map((type) => type.name).join(", ") || "(none saved)";
    throw new Error(
      `No saved medicine matches "${medicine}". Saved: ${saved}. Call create_medicine_type first.`,
    );
  }
  return match;
}

/**
 * Logs a dose to `health/{cid}/data`, stamps `lastTake` on the medicine type, and
 * moves `prefs.lastMedication` forward — but only when this dose is not older
 * than the one already summarised, so a late backfill cannot rewrite history.
 */
export async function logMedication(
  client: HuckleberryClient,
  childUid: string,
  medicine: string,
  options: LogMedicationOptions = {},
): Promise<{ entryId: string; medicineTypeId: string }> {
  if (options.amount !== undefined && options.units === undefined) {
    throw new Error(
      `logMedication requires units when an amount is given (one of: ${MEDICATION_UNITS.join(", ")})`,
    );
  }

  const medicineType = await resolveMedicineType(client, childUid, medicine);
  const eventDate = options.time ?? new Date();
  const start = eventDate.getTime() / 1000;
  const now = Date.now() / 1000;

  const entry: Record<string, unknown> = {
    mode: "medication",
    start,
    lastUpdated: now,
    offset: client.getOffsetMinutes(eventDate),
    medication_id: medicineType._id,
    medication_name: medicineType.name,
    amount: options.amount ?? 0,
    ...(options.units !== undefined && { units: options.units }),
    notes: options.notes ?? "",
  };

  const db = client.getFirestore();
  const healthRef = doc(db, HEALTH, childUid);
  const ref = await addDoc(collection(db, HEALTH, childUid, "data"), entry);

  await setDoc(
    doc(db, HEALTH, childUid, "types", medicineType._id),
    {
      lastTake: {
        amount: options.amount ?? null,
        reminderType: "at",
        units: options.units ?? null,
      },
    },
    { merge: true },
  );

  const existing = ((await getDoc(healthRef)).data()?.prefs ?? {}) as {
    lastMedication?: { start?: number; units?: MedicationUnits };
  };
  const previous = existing.lastMedication;
  const isNewest = previous?.start === undefined || start >= previous.start;
  if (isNewest) {
    const units = options.units ?? previous?.units;
    await setDoc(
      healthRef,
      {
        prefs: {
          lastMedication: {
            ...entry,
            _id: ref.id,
            type: "health",
            isNight: false,
            multientry_key: null,
            ...(units !== undefined && { units }),
          },
          timestamp: { seconds: now },
          local_timestamp: now,
        },
      },
      { merge: true },
    );
  }

  return { entryId: ref.id, medicineTypeId: medicineType._id };
}

/** Doses for a child, most recent first. Each row carries its Firestore `id`. */
export async function getMedicationHistory(
  client: HuckleberryClient,
  childUid: string,
  options: { limit?: number } = {},
): Promise<Array<MedicationEntryParsed & { id: string }>> {
  const rows = await readHealthRows(client, childUid, "medication", options.limit ?? 50);
  return rows.map((row) => ({ id: row.id, ...MedicationEntry.parse(row.data) }));
}
