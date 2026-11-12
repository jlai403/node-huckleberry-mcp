---
name: huckleberry
description: >-
  Log and read baby-tracking data (sleep, feeds, nursing, bottle, pump, solids,
  diapers, potty, growth, medication) through the Huckleberry MCP server. Use whenever the
  user wants to record a baby event or ask about their baby's history/patterns.
---

# Huckleberry baby tracking

This skill drives the **Huckleberry MCP** tools. Follow these rules so tool calls
are correct on the first try.

## 1. Resolve the child first

Most tools need a `child_uid`. At the start of a session (or if unknown), call
**`get_user`** — it returns the child list and `lastChild`. Reuse that uid for
subsequent calls. If the account has exactly one child, use it without asking.
Only ask the user which child if there are several and it's ambiguous.

## 2. Times are epoch seconds, in the configured timezone

Every `start`/`end` argument is a **Unix timestamp in seconds** (not ms, not a
date string). The server applies the timezone from `HUCKLEBERRY_TIMEZONE`.

Convert the user's natural language to epoch seconds:

- "just now" / no time given → now
- "a 40-minute nap that ended 20 minutes ago" → end = now − 20min, start = end − 40min
- "at 2pm" → 2pm **today** in the user's timezone

## 3. Units & enums

| Tool                     | Field                              | Allowed                                                         |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------- |
| `log_bottle`, `log_pump` | `units`                            | `ml` or `oz`                                                    |
| `log_bottle`             | `bottle_type`                      | free text: "Breast Milk", "Formula", "Cow Milk"                 |
| `log_growth`             | `units`                            | `metric` or `imperial`                                          |
| `log_diaper`             | `mode`                             | `pee` / `poo` / `both` / `dry`                                  |
| `log_diaper`             | `pee_amount` / `poo_amount`        | `little` / `medium` / `big`                                     |
| `log_diaper`             | `color`                            | `yellow` `brown` `green` `black` `red` `white` `orange` `other` |
| `log_diaper`             | `consistency`                      | `hard` `normal` `soft` `runny` `watery` `formed` `mucousy`      |
| `log_potty`              | `mode`                             | `pee` / `poo`                                                   |
| `log_nursing`            | `left_duration` / `right_duration` | seconds                                                         |
| `log_pump`               | amounts                            | give `total_amount`, or `left_amount` + `right_amount`          |

`color`/`consistency` are enforced server-side — a value outside the table is
rejected, not written (this closed a past bug where an unrecognized value
could crash the app; see `TASKS.md` → BUG2). Map what the user says to the
nearest value ("mustard" → `yellow`, "dark green" → `green`, `other` as a
fallback); put anything more specific in `notes`.

## 4. There are no live timers

You log **completed** events. `log_sleep` takes both `start` and `end`. There is
no start/pause/resume — if the user says "baby just went down", either wait until
they wake to log it, or ask for the expected end / log it when known.

## 5. Reads answer questions

Use the history tools for "how did baby sleep?", "how many feeds today?", etc.:
`get_sleep_history`, `get_feed_history`, `get_diaper_history`,
`list_pump_intervals`, `get_latest_growth`, `get_growth_history`. Each takes
`child_uid` and an optional `limit`, newest first.

## 6. Notes, and editing past entries

Every `log_*` tool takes an optional `notes` string (free text) — use it for any
qualitative detail the user mentions ("spit up after the bottle", "woke up
crying", "first solid food"). The note is saved on the entry and comes back in
the matching history/`get_*` read.

To **change** an existing entry, every tracker has an `edit_*` tool: `edit_sleep`,
`edit_feed` (nursing/bottle/solids), `edit_pump`, `edit_diaper` (diaper + potty),
`edit_growth`. To **remove** one, there's a matching `delete_*`: `delete_sleep`,
`delete_feed`, `delete_pump`, `delete_diaper`, `delete_growth`. The flow is always:
read first to get the entry's `id` (every history/`get_*` result includes it), then
call the `edit_*`/`delete_*` tool with that id (`interval_id` for
sleep/feed/pump/diaper, `entry_id` for growth). Editing never requires re-logging.

`delete_*` is **permanent** — confirm the specific entry with the user before
deleting (echo back what it is), the same way you confirm before writing.

## 7. Medication is a two-step write

Medicines are saved per child before they can be logged. Call
**`list_medicine_types`** to see them; **`log_medication`** takes a saved type's
`id` or its name (case-insensitive) and **fails** if it matches nothing — it never
creates one implicitly, because a typo would become a permanent medicine.

If the user names something that isn't saved, ask before adding it, then call
**`create_medicine_type`** and log against the returned id.

- `amount` requires `units` (`ml`, `oz`, `tsp`, `drops`). Omit both when the user
  just says "gave her the medicine".
- Never calculate or suggest a dose — record only what the user states, and send
  dosing questions to a doctor, pharmacist, or the product label.
- "When was the last dose?" → `get_medication_history` and read the newest entry.

## 8. Confirm before writing

Writes go to the user's **real** Huckleberry account. Before any `log_*` call,
echo back the child, the resolved time, and the values, then make the call.

## Examples

- "Log a 30-min nap that ended at 3pm" → `log_sleep` with start = 14:30, end = 15:00 (epoch s).
- "120ml formula bottle just now" → `log_bottle` { amount: 120, units: "ml", bottle_type: "Formula", start: now }.
- "Poo diaper, medium, yellow" → `log_diaper` { mode: "poo", poo_amount: "medium", color: "yellow", start: now }.
- "Weighed 3.4 kg today" → `log_growth` { weight: 3.4, units: "metric", start: now }.
- "Gave her 2.5ml of Tylenol just now" → `log_medication` { medicine: "Tylenol", amount: 2.5, units: "ml", start: now }.
- "How much did she sleep yesterday?" → `get_sleep_history`, filter to yesterday, sum durations.

The server also exposes MCP **prompts** for the same flows: `huckleberry_usage`,
`daily_summary`, and `log_event`.
