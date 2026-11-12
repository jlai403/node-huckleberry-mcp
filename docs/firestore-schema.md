# Firestore schema catalog

The living map of Huckleberry's Firestore layout — every collection/document
shape we've **confirmed against a real account**, plus candidates still to
confirm. This is the reconcile-and-record output of `docs/discovery-plan.md`
(Track E). Regenerate evidence with `npm run inspect:schema` (gated on creds);
update this file with anything newly confirmed.

> Conventions (live-confirmed): all time values are **plain numbers, not Firestore
> `Timestamp`** — `start`/`lastUpdated` are epoch **seconds** (float, sub-second
> precision in real app writes — see the deviation note below), `duration` is
> **seconds**, `offset` is timezone minutes **negated** (UTC+8 → `-480`). Each
> tracker is `{collection}/{cid}` (parent doc holding a `prefs` summary) with
> entries in a subcollection.

## Status legend

- ✅ **confirmed** — shape captured from a real document.
- 🟡 **partial** — path confirmed, but some fields/variants not yet captured.
- ❓ **candidate** — guessed (from the app UI or the Python reference); not yet
  probed/confirmed. Probe with `PROBE_PATHS=...` (see the inspector).

## Account / child

| Path           | Status | Shape (key fields)                                                           |
| -------------- | ------ | ---------------------------------------------------------------------------- |
| `users/{uid}`  | ✅     | `{ childList: [{ cid, … }], lastChild, email, … }` — child resolution source |
| `childs/{cid}` | ✅     | `{ childsName, gender ("M"/…), birthdate, … }` — permissive (passthrough)    |

## Trackers (confirmed)

| Tracker        | Entry path               | Parent summary                                      |
| -------------- | ------------------------ | --------------------------------------------------- |
| Sleep          | `sleep/{cid}/intervals`  | `prefs.lastSleep`                                   |
| Feed           | `feed/{cid}/intervals`   | `prefs.lastFeed`, `prefs.lastSide`, `prefs.bottle*` |
| Diaper + potty | `diaper/{cid}/intervals` | `prefs.lastDiaper` / `prefs.lastPotty`              |
| Pump           | `pump/{cid}/intervals`   | `prefs.lastPump`                                    |
| Growth         | `health/{cid}/data`      | **none** — growth does NOT update parent `prefs`    |
| Custom foods   | `types/{cid}/custom`     | n/a (subcollection only; parent doc may be absent)  |

Confirmed entry shapes (`mode`/`type` is the in-collection discriminator):

- **Sleep** ✅ — `{ start, duration, offset, lastUpdated }`; `prefs.lastSleep = { start, offset, duration }`.
  Also has a `timer` field on the **parent** `sleep/{cid}` doc, sibling to `prefs`
  — see the deviation + open-question notes below (BUG1).
- **Feed / nursing** ✅ — `{ mode:"breast", leftDuration, rightDuration, lastSide, start, offset, lastUpdated }`.
- **Feed / bottle** ✅ — `{ mode:"bottle", amount, bottleType, units, start, offset, lastUpdated }`.
- **Feed / solids** 🟡 — `{ mode:"solids", start, offset, lastUpdated }`. The meal's
  `foods` map / `reactions` / `foodNoteImage` are **not yet captured live** — see
  the deviation note below (B5).
- **Diaper / potty** ✅ — `{ mode:"poo"|…, color?, consistency?, quantity?, isPotty?, start, offset, lastUpdated }`.
- **Pump** ✅ — `{ entryMode:"total"|"leftright", leftAmount, rightAmount, duration?, units, start, offset, lastUpdated }`.
- **Growth** ✅ — `{ mode:"growth", start, offset, lastUpdated, weight?, weightUnits, height?, heightUnits, head?, headUnits }` (metric `kg`/`cm`/`hcm`, imperial `lbs.oz`/`ft.in`/`hin`).
- **Custom food** 🟡 — we currently read leniently; the **write** shape is unconfirmed (see deviation note).

Every parent `prefs` also carries `timestamp:{ seconds:<float> }` and
`local_timestamp:<float>`, set to "now" on each write.

## Deviations from the Python reference (live wins)

- **Diaper `quantity`** ✅ — a **scalar** (`0/50/100` = little/medium/big), _not_ the
  `{pee,poo}` map the Python source uses. Live wins.
- **Solids food tracking** 🟡 (B5) — the Python API's `log_solids` stores a `foods`
  map (`{id:{id,created_name,source,amount}}`), `reactions` (`{LOVED|MEH|HATED|ALLERGIC:true}`),
  and `foodNoteImage`; its `create_solids_custom_food` writes
  `{type:"solids", source:"custom", archived, image, id, created_at, updated_at}`
  (ISO strings). Our current `log_solids`/`create_custom_food` write neither shape.
  **Confirm the real docs before porting** — act in app, then inspect the
  `feed/{cid}/intervals` and `types/{cid}/custom` documents.
- **Interval doc IDs and timestamp precision** 🟡 — a real app-authored sleep
  interval, captured 2026-08-15, has id `1786784022604-d6e50389f25c29176743`: a
  **client-generated `{epochMs}-{hex}` string**, not a Firestore auto-ID. Its
  `start`/`duration` also carry **sub-second float precision**
  (`1786761149.657`, `22868.438`), not rounded integers. Our writes use
  Firestore's `addDoc` auto-ID and integer/whole-float seconds — functionally
  fine (reads/deletes work either way by id), but a real, uninvestigated shape
  difference. Not yet known whether it matters for anything (e.g. BUG1) — noted
  here so it isn't lost; revisit if it turns out to matter.

## Probe findings (run 2026-07-26, prober sweep)

First real prober sweep. What it settled:

- **Medication lives in `health/{cid}/data` with `mode: "medication"`** ✅ —
  confirmed 2026-11-12 by a written round-trip against the ZZ Test child, matching
  `py-huckleberry-api`'s implementation. Not a separate `medication/` collection.
  The shapes are under [Medication](#medication) below.
- **`types/{cid}` parent doc is absent and `types/{cid}/custom` is empty** ✅ — the
  account has no custom foods. Confirms the parent doc is a "phantom parent" (the
  subcollection is what matters), and means the B5 custom-food shape is still
  unconfirmed against an **app-created** doc.
- **Candidate collections are denied, not empty** ⛔ — `medication/`, `temperature/`
  etc. return `permission-denied` rather than an empty read. Security rules only
  permit the collections the app actually uses, so **⛔ is itself a signal**: those
  top-level collections most likely don't exist for this project. Combined with
  `lastMedication` above, the picture is that extra trackers live inside
  `health/{cid}/data` behind `mode`, not in sibling top-level collections.

## Open questions (unresolved shapes we depend on)

- **How is an _in-progress_ session represented?** ❓ Narrowed, not yet answered.
  `TASKS.md` → BUG1 tracks the investigation; summary of what a live capture
  (2026-08-15) has shown so far:
  - The original hypothesis — that `log_sleep` clobbers an in-progress marker
    living inside `prefs.lastSleep` — is **not supported**. A baseline vs.
    during-session capture showed `sleep/{cid}.prefs.lastSleep` completely
    unchanged (`{}` before and during), and a real `log_sleep` write landing on
    `prefs.lastSleep` while a session was live in the app did **not** end that
    session.
  - `sleep/{cid}` has a **`timer` field sibling to `prefs`** on the parent doc —
    present on every capture taken so far, but its _value_ was invisible until
    now: the inspector only ever dumped `prefs`, listing other field names
    without their contents. Fixed in this change (`other.*` in the dump/diff) —
    `timer` is the leading suspect for where in-progress state actually lives.
  - **Next capture needed** (now that the tooling can see it): `OUT=before.json
npm run inspect:schema` → start a sleep in the app, leave it running → `DIFF_AGAINST=before.json npm run inspect:schema` → read the `other.timer.*`
    diff lines.

- **What are the allowed diaper `color` / `consistency` values?** 🟡 Adopted, not
  yet live-confirmed. `src/client/diaperOps.ts` now constrains both to a fixed
  set (`DIAPER_COLORS`/`DIAPER_CONSISTENCIES`) at the MCP tool boundary to close
  BUG2 (an unrecognized value could crash the app on that entry). **This is a
  deliberate exception to verify-first**, taken on explicit user instruction: the
  set is ported from the legacy `src/client/healthOps.ts` union
  (yellow/brown/green/black/red/white/orange/other;
  hard/normal/soft/runny/watery/formed/mucousy), not captured from real
  Firestore data — casing and enum-key-vs-display-name are still unconfirmed. If
  it ever mismatches the app, capture it properly: log one diaper per
  color/consistency from the app, dump `diaper/{cid}/intervals`, and update this
  entry + `DIAPER_COLORS`/`DIAPER_CONSISTENCIES` from the observed strings.

## Medication

Confirmed 2026-11-12 (written through `logMedication`, read back through the
prober). Mirrors `py-huckleberry-api`, which the app has been verified against.

Selectable medicines — `health/{cid}/types/{type_id}`:

```json
{
  "_id": "<type_id>",
  "active": true,
  "mode": "medication",
  "name": "Tylenol",
  "lastTake": { "amount": 2.5, "reminderType": "at", "units": "ml" }
}
```

`lastTake` is merged on after the type's first dose; the type doc itself is
created with only `_id`, `active`, `mode`, `name`.

A dose — `health/{cid}/data/{entry_id}`:

```json
{
  "mode": "medication",
  "start": 1794519383.613,
  "lastUpdated": 1794519383.62,
  "offset": -360,
  "medication_id": "<type_id>",
  "medication_name": "Tylenol",
  "amount": 2.5,
  "units": "ml",
  "notes": ""
}
```

- `units` is one of `ml | oz | tsp | drops`, and is **omitted** when no amount was
  measured (`amount` is then `0`). `notes` is `""`, not null.
- `health/{cid}.prefs.lastMedication` mirrors the newest dose plus
  `_id`, `type: "health"`, `isNight`, `multientry_key` — and only moves when the
  logged dose is not older than the one already summarised.

Because growth and medication share `health/{cid}/data`, both readers filter on
`mode` after fetching a page: Firestore refuses `where` + `orderBy` on different
fields without a composite index, and this project's indexes are not ours to
create.

## Candidates to confirm (❓)

Guessed from the app's features / the Python reference; **not yet probed**. The
inspector sweeps these by default and reports exists/empty/absent — but a guessed
sub being empty is **not** proof the feature doesn't exist (it may live under a
different path, e.g. inside `health/{cid}/data` behind a `mode`). Confirm the real
path/sub before trusting.

| Candidate path                             | Hypothesis                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `health/{cid}/data` (other `mode`s)        | Medication ✅ confirmed (`mode: "medication"`). Temperature / symptom are guessed to live here too — log one of each in the app, then re-probe. |
| `medication/{cid}`                         | ⛔ denied in the sweep — probably not a real top-level collection (see findings)                                                                |
| `temperature/{cid}`                        | ⛔ denied — same                                                                                                                                |
| `measurement/{cid}`                        | ⛔ denied — same                                                                                                                                |
| `milestone/{cid}`                          | ⛔ denied — same                                                                                                                                |
| `activity/{cid}`                           | ⛔ denied — same                                                                                                                                |
| `symptom/{cid}`                            | ⛔ denied — same                                                                                                                                |
| `journal`/`note`/`photo`/`vaccine`/`teeth` | other app sections — paths unknown; likely also `mode`s rather than collections                                                                 |

When one is confirmed, move it up into the tables above with its captured shape.
