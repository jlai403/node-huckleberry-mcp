import { z } from "zod";
import { registerTool } from "../server/server.js";
import { getClient } from "../server/auth.js";
import {
  listActivityIntervals,
  getActivityDoc,
  startActivity,
  pauseActivity,
  resumeActivity,
  switchActivity,
  cancelActivity,
  completeActivity,
  logActivity,
} from "../client/index.js";
import { ACTIVITY_MODES } from "../models/index.js";

type Mode = (typeof ACTIVITY_MODES)[number];

const modeSchema = z.enum(ACTIVITY_MODES, {
  errorMap: () => ({ message: "mode must be one of the app activities" }),
});

// get_activities — rack overview (which mode is active, per-mode states)
registerTool(
  "get_activities",
  "Get the child's activity timer rack: per-mode timer states (active/paused/start/duration)",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    const doc = await getActivityDoc(client, input.child_uid);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ timer: doc.timer ?? {} }, null, 2),
        },
      ],
    };
  },
);

// start_activity — start (or move) a mode timer
registerTool(
  "start_activity",
  "Start an activity timer (mode: bath/brushTeeth/indoorPlay/outdoorPlay/screenTime/skinToSkin/storyTime/tummyTime). On same-mode-active, moves its start; another mode active → use switch_activity.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    mode: modeSchema,
    start: z.number().min(0).optional(),
  }),
  async (input) => {
    const client = await getClient();
    const result = await startActivity(client, input.child_uid, input.mode as Mode, {
      time: input.start !== undefined ? new Date(input.start * 1000) : undefined,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            result.moved
              ? { status: "moved", message: "Activity timer already active — start moved" }
              : { status: "started", mode: input.mode },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// pause_activity
registerTool(
  "pause_activity",
  "Pause the active activity timer; elapsed banks into the entry's whole-second duration",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    mode: modeSchema,
  }),
  async (input) => {
    const client = await getClient();
    await pauseActivity(client, input.child_uid, input.mode as Mode);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "paused", mode: input.mode }, null, 2),
        },
      ],
    };
  },
);

// resume_activity
registerTool(
  "resume_activity",
  "Resume a paused activity timer",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    mode: modeSchema,
  }),
  async (input) => {
    const client = await getClient();
    await resumeActivity(client, input.child_uid, input.mode as Mode);
    return {
      content: [
        { type: "text", text: JSON.stringify({ status: "resumed", mode: input.mode }, null, 2) },
      ],
    };
  },
);

// switch_activity — reassign the running timer to another mode
registerTool(
  "switch_activity",
  "Reassociate the ACTIVE activity timer with another activity mode (start/durations carry over)",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    mode: modeSchema,
  }),
  async (input) => {
    const client = await getClient();
    const result = await switchActivity(client, input.child_uid, input.mode as Mode);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            result.switched
              ? { status: "switched", mode: input.mode }
              : { status: "noop", message: "No active activity timer, or same mode" },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// cancel_activity — discard without saving
registerTool(
  "cancel_activity",
  "Cancel the active activity timer WITHOUT saving an entry",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    mode: modeSchema,
  }),
  async (input) => {
    const client = await getClient();
    await cancelActivity(client, input.child_uid, input.mode as Mode);
    return {
      content: [
        { type: "text", text: JSON.stringify({ status: "cancelled", mode: input.mode }, null, 2) },
      ],
    };
  },
);

// complete_activity — save + frozen reset (end/duration mutually exclusive)
registerTool(
  "complete_activity",
  "Complete the activity timer and save an entry. Corrections: `end` (epoch seconds) or `duration` (seconds) — mutually exclusive — and `start`.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    mode: modeSchema,
    start: z.number().min(0).optional(),
    end: z.number().min(0).optional(),
    duration: z.number().min(0).optional(),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    const saved = await completeActivity(client, input.child_uid, input.mode as Mode, {
      start: input.start !== undefined ? new Date(input.start * 1000) : undefined,
      end: input.end !== undefined ? new Date(input.end * 1000) : undefined,
      duration: input.duration,
      notes: input.notes,
    });
    if (!saved) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "noop", message: "No active activity timer to complete" },
              null,
              2,
            ),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { status: "completed", start: saved.startSec, duration: saved.duration },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// log_activity — direct log without running a timer
registerTool(
  "log_activity",
  "Log an activity entry directly without a timer run (`duration` in seconds; whole-second)",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    mode: modeSchema,
    start: z.number().min(0, "start is required (epoch seconds)"),
    duration: z.number().min(0).optional(),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    const id = await logActivity(client, input.child_uid, {
      mode: input.mode as Mode,
      start: input.start,
      duration: input.duration,
      notes: input.notes,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ activity_id: id }, null, 2) }],
    };
  },
);

// list_activity_intervals — range query (multi docs skipped)
registerTool(
  "list_activity_intervals",
  "List activity history entries within a time range (start inclusive, end exclusive; epoch seconds)",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0, "range start is required (epoch seconds)"),
    end: z.number().min(0, "range end is required (epoch seconds)"),
  }),
  async (input) => {
    const client = await getClient();
    const events = await listActivityIntervals(client, input.child_uid, {
      start: input.start,
      end: input.end,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ events }, null, 2) }],
    };
  },
);
