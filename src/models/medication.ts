import { z } from "zod";

// Medication is stored under `health/{cid}` — the same document as growth — with
// the rows discriminated by `mode`. Shapes mirror py-huckleberry-api, which is
// the implementation the Huckleberry app itself has been verified against.
export const MEDICATION_UNITS = ["ml", "oz", "tsp", "drops"] as const;

export type MedicationUnits = (typeof MEDICATION_UNITS)[number];

/** A dose logged at `health/{cid}/data/{id}`. */
export const MedicationEntry = z
  .object({
    mode: z.literal("medication"),
    start: z.number(),
    lastUpdated: z.number().optional(),
    offset: z.number().optional(),
    medication_id: z.string(),
    medication_name: z.string(),
    amount: z.number(),
    // Absent when no amount was recorded; the app treats that as "amount 0".
    units: z.enum(MEDICATION_UNITS).optional(),
    notes: z.string().optional(),
  })
  .passthrough();

export type MedicationEntryParsed = z.infer<typeof MedicationEntry>;

/** `lastTake` the app writes onto a medicine type once it has been used. */
export const MedicineLastTake = z
  .object({
    amount: z.number().nullable().optional(),
    reminderType: z.literal("at").optional(),
    units: z.enum(MEDICATION_UNITS).nullable().optional(),
  })
  .passthrough();

export type MedicineLastTakeParsed = z.infer<typeof MedicineLastTake>;

/** A selectable medicine at `health/{cid}/types/{id}`. `_id` is optional so a
 * document whose field is missing still parses; the doc id is authoritative. */
export const MedicineType = z
  .object({
    _id: z.string().optional(),
    active: z.boolean(),
    mode: z.literal("medication"),
    name: z.string(),
    lastTake: MedicineLastTake.optional(),
  })
  .passthrough();

export type MedicineTypeParsed = z.infer<typeof MedicineType>;
