import { z } from "zod";
import { registerTool } from "../server/server.js";
import { getClient } from "../server/auth.js";
import {
  createMedicineType,
  getMedicationHistory,
  listMedicineTypes,
  logMedication,
} from "../client/index.js";
import { MEDICATION_UNITS, type MedicationUnits } from "../models/index.js";

// Medication lives in health/{cid} alongside growth: selectable medicines in
// `types`, doses in `data` with mode "medication".

function asResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const UnitsSchema = z.enum(MEDICATION_UNITS as unknown as [MedicationUnits, ...MedicationUnits[]]);

// list_medicine_types — the medicines a parent can log against
registerTool(
  "list_medicine_types",
  "List the medicines saved for a child that can be logged (active only), with their last recorded dose",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    return asResult(await listMedicineTypes(client, input.child_uid));
  },
);

// create_medicine_type — add a selectable medicine
registerTool(
  "create_medicine_type",
  "Add a medicine to a child's saved list so doses can be logged against it. Ask before creating one: it cannot be removed from the app.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    name: z.string().min(1, "name is required, e.g. Tylenol"),
  }),
  async (input) => {
    const client = await getClient();
    const id = await createMedicineType(client, input.child_uid, { name: input.name });
    return asResult({ medicine_type_id: id });
  },
);

// log_medication — record a dose against a saved medicine
registerTool(
  "log_medication",
  "Log a dose of a saved medicine. `medicine` is a medicine type id or its name (case-insensitive); it must already exist — call list_medicine_types, then create_medicine_type if it is missing. Give `units` whenever you pass `amount` (ml, oz, tsp, drops).",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    medicine: z.string().min(1, "medicine is required (id or name)"),
    start: z.number().min(0, "start in epoch seconds (defaults to now)").optional(),
    amount: z.number().min(0).optional(),
    units: UnitsSchema.optional(),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    const logged = await logMedication(client, input.child_uid, input.medicine, {
      time: input.start !== undefined ? new Date(input.start * 1000) : undefined,
      amount: input.amount,
      units: input.units,
      notes: input.notes,
    });
    return asResult(logged);
  },
);

// get_medication_history — doses ordered by most recent
registerTool(
  "get_medication_history",
  "Get medication doses for a child, most recent first. Each entry includes its id, the medicine name, amount and units.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    limit: z.number().min(1).optional(),
  }),
  async (input) => {
    const client = await getClient();
    return asResult(await getMedicationHistory(client, input.child_uid, { limit: input.limit }));
  },
);
