// WHO growth-percentile tools: read-only computed views over the child's own
// earlier growth entries + the WHO/Child-Growth-Standards LMS tables (bundled,
// offline). Reference output; the prompt rails already frame it as
// informational, never a clinical judgment.

import { z } from "zod";
import { registerTool } from "../server/server.js";
import { getClient } from "../server/auth.js";
import { getChild, getGrowthHistory } from "../client/index.js";
import { ageInDays, calculateZScore, type ZScoreResult } from "@pedi-growth/core";

// ── helpers ────────────────────────────────────────────────────────────────

type Sex = "male" | "female";

function normalizeSex(gender: string | undefined): Sex | null {
  if (!gender) return null;
  const g = gender.trim().toLowerCase();
  if (g.startsWith("m") || g === "boy") return "male";
  if (g.startsWith("f") || g === "girl") return "female";
  return null;
}

// ── indicators across the 4 supported WHO views (async: pedi loads tables) ──

type IndicatorsInput = {
  weight?: number;
  height?: number;
  head?: number;
};

type IndicatorsResult = {
  wfa?: ZScoreResult;
  lhfa?: ZScoreResult;
  hcfa?: ZScoreResult;
  wfl?: ZScoreResult;
};

async function indicators(
  input: IndicatorsInput,
  sex: Sex,
  ageDays: number,
): Promise<IndicatorsResult> {
  const out: IndicatorsResult = {};
  const results = await Promise.allSettled([
    input.weight !== undefined
      ? calculateZScore({
          indicator: "weight-for-age",
          sex,
          ageInDays: ageDays,
          measurement: input.weight,
          chartSet: "who-standard",
        })
      : null,
    input.height !== undefined
      ? calculateZScore({
          indicator: "length-height-for-age",
          sex,
          ageInDays: ageDays,
          measurement: input.height,
          chartSet: "who-standard",
        })
      : null,
    input.head !== undefined
      ? calculateZScore({
          indicator: "head-circumference-for-age",
          sex,
          ageInDays: ageDays,
          measurement: input.head,
          chartSet: "who-standard",
        })
      : null,
    input.weight !== undefined && input.height !== undefined
      ? calculateZScore({
          indicator: "weight-for-length",
          sex,
          lengthHeight: input.height,
          measurement: input.weight,
          chartSet: "who-standard",
        })
      : null,
  ]);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      const key =
        r.value.indicator === "weight-for-age"
          ? "wfa"
          : r.value.indicator === "length-height-for-age"
            ? "lhfa"
            : r.value.indicator === "head-circumference-for-age"
              ? "hcfa"
              : "wfl";
      out[key] = r.value;
    }
  }
  return out;
}

// ── get_growth_percentiles ─────────────────────────────────────────────────

registerTool(
  "get_growth_percentiles",
  "Compute WHO growth-standard z-scores and percentiles for the child's latest (or all) recorded growth entries. Uses the child's birthdate + gender. Reference math only — not a clinical judgment.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe("How many recent entries to evaluate (1-5)."),
  }),
  async (input) => {
    const client = await getClient();
    const child = await getChild(client, input.child_uid);
    if (!child) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: `child ${input.child_uid} not found` }) },
        ],
        isError: true,
      };
    }
    const sex = normalizeSex(child.gender);
    const birth = child.birthdate
      ? new Date(`${String(child.birthdate).slice(0, 10)}T00:00:00Z`)
      : null;
    if (!sex || !birth || Number.isNaN(birth.getTime())) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error:
                "WHO percentiles need the child's birthdate (YYYY-MM-DD) and gender (starts with m/f) set in the Huckleberry app",
              got: { birthdate: child.birthdate ?? null, gender: child.gender ?? null },
            }),
          },
        ],
        isError: true,
      };
    }

    const entries = await getGrowthHistory(client, input.child_uid, { limit: input.limit });
    const resultsPromise = entries.map(async (e) => {
      const at = new Date((e.start ?? 0) * 1000);
      let ageDays: number | null = null;
      try {
        const birthDate = new Date(`${String(child.birthdate).slice(0, 10)}T00:00:00Z`);
        ageDays = ageInDays(birthDate, at);
      } catch {
        ageDays = null;
      }
      if (ageDays === null || Number.isNaN(ageDays)) return null;
      const out: Record<string, unknown> = {
        date: at.toISOString().slice(0, 10),
        age_days: ageDays,
      };
      out.percentiles = await indicators(
        { weight: e.weight, height: e.height, head: e.head },
        sex,
        ageDays as number,
      );
      return out;
    });
    const results = (await Promise.all(resultsPromise)).filter(Boolean);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ child: child.childsName ?? null, entries: results }, null, 2),
        },
      ],
    };
  },
);

// ── get_growth_trend ───────────────────────────────────────────────────────

registerTool(
  "get_growth_trend",
  "Trend view: the child's growth entries with WHO z-scores over time, plus first→last deltas per indicator. Reference math only.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    const child = await getChild(client, input.child_uid);
    const sex = child ? normalizeSex(child.gender) : null;
    const birth = child?.birthdate
      ? new Date(`${String(child.birthdate).slice(0, 10)}T00:00:00Z`)
      : null;
    if (!sex || !birth || Number.isNaN(birth.getTime())) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "birthdate + gender required — set them in the Huckleberry app",
            }),
          },
        ],
        isError: true,
      };
    }

    const entries = [...(await getGrowthHistory(client, input.child_uid, { limit: 25 }))].sort(
      (a, b) => a.start - b.start,
    );
    const series: Array<{
      date: string;
      age_days: number;
      wfa_z?: number;
      lhfa_z?: number;
      hcfa_z?: number;
    }> = [];
    for (const e of entries) {
      const at = new Date((e.start ?? 0) * 1000);
      let ageDays: number | null = null;
      try {
        ageDays = ageInDays(new Date(`${String(child!.birthdate).slice(0, 10)}T00:00:00Z`), at);
      } catch {
        continue;
      }
      if (Number.isNaN(ageDays)) continue;
      const row: {
        date: string;
        age_days: number;
        wfa_z?: number;
        lhfa_z?: number;
        hcfa_z?: number;
      } = {
        date: at.toISOString().slice(0, 10),
        age_days: ageDays,
      };
      const r = await indicators(
        { weight: e.weight, height: e.height, head: e.head },
        sex,
        ageDays,
      );
      if (r.wfa) row.wfa_z = r.wfa.zScore;
      if (r.lhfa) row.lhfa_z = r.lhfa.zScore;
      if (r.hcfa) row.hcfa_z = r.hcfa.zScore;
      series.push(row);
    }

    const first = series[0];
    const last = series[series.length - 1]!;
    const delta =
      first && last && first !== last
        ? {
            wfa_z_delta:
              first.wfa_z !== undefined && last.wfa_z !== undefined
                ? +(last.wfa_z - first.wfa_z).toFixed(3)
                : undefined,
            lhfa_z_delta:
              first.lhfa_z !== undefined && last.lhfa_z !== undefined
                ? +(last.lhfa_z - first.lhfa_z).toFixed(3)
                : undefined,
            hcfa_z_delta:
              first.hcfa_z !== undefined && last.hcfa_z !== undefined
                ? +(last.hcfa_z - first.hcfa_z).toFixed(3)
                : undefined,
          }
        : null;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ series, delta, note: "reference math only" }, null, 2),
        },
      ],
    };
  },
);
