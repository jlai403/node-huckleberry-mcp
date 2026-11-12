import { collection, getDocs, limit, orderBy, query } from "firebase/firestore";
import type { HuckleberryClient } from "./HuckleberryClient.js";

/**
 * `health/{cid}/data` holds growth and medication rows side by side, told apart
 * by `mode`. Firestore rejects where+orderBy without a composite index, and this
 * project's indexes are not ours to create, so a read pulls a wider page and
 * filters in memory.
 */
const WINDOW_FACTOR = 5;
const MAX_WINDOW = 500;

/** Newest-first rows of one `mode`, capped at `wanted`. */
export async function readHealthRows(
  client: HuckleberryClient,
  childUid: string,
  mode: string,
  wanted: number,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  await client.connect();
  const db = client.getFirestore();
  const window = Math.min(Math.max(wanted, 1) * WINDOW_FACTOR, MAX_WINDOW);
  const snap = await getDocs(
    query(collection(db, "health", childUid, "data"), orderBy("start", "desc"), limit(window)),
  );
  return snap.docs
    .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    .filter((row) => row.data.mode === mode)
    .slice(0, wanted);
}
