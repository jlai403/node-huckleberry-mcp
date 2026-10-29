import { z } from "zod";
import { registerTool } from "../server/server.js";
import { getClient } from "../server/auth.js";
import {
  logNursing,
  logBottle,
  logSolids,
  logPump,
  listPumpIntervals,
  getFeedHistory,
  editFeed,
  editPump,
  deleteFeed,
  deletePump,
  getFeedDoc,
  startNursing,
  pauseNursing,
  resumeNursing,
  switchNursingSide,
  cancelNursing,
  completeNursing,
  getPumpDoc,
  startPump,
  pausePump,
  resumePump,
  cancelPump,
  completePump,
} from "../client/index.js";

const sideSchema = z.enum(["left", "right"]);
type Side = z.infer<typeof sideSchema>;

// T2.5: Feeding Tools (log/read/edit/delete + live nursing timer)

// get_feed — read the live feeding document and current nursing timer state
registerTool(
  "get_feed",
  "Get the child's feed document and current nursing timer state (active/paused/side/durations)",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    const { timer } = await getFeedDoc(client, input.child_uid);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              timer: timer
                ? {
                    active: timer.active,
                    paused: timer.paused,
                    session_start_epoch_sec: timer.feedStartTime ?? null,
                    segment_start_epoch_sec: timer.timerStartTime ?? null,
                    left_duration_sec: timer.leftDuration ?? null,
                    right_duration_sec: timer.rightDuration ?? null,
                    active_side: timer.activeSide ?? null,
                    last_side: timer.lastSide ?? null,
                    session_uuid: timer.uuid ?? null,
                  }
                : null,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// start_nursing — start the nursing timer (or move an active session's start)
registerTool(
  "start_nursing",
  "Start the breastfeeding timer. Pass `start` (epoch seconds) + `side`; on an already-running session this moves its start instead of starting a new one.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    side: sideSchema.default("left"),
    start: z.number().min(0).optional(),
  }),
  async (input) => {
    const client = await getClient();
    const result = await startNursing(client, input.child_uid, {
      side: input.side as Side,
      time: input.start !== undefined ? new Date(input.start * 1000) : undefined,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            result.moved
              ? { status: "moved", message: "Nursing already active — session start shifted" }
              : { status: "started", side: input.side },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// pause_nursing — bank elapsed into the active side and pause
registerTool(
  "pause_nursing",
  "Pause the nursing timer; elapsed time banks into the active side's duration",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    await pauseNursing(client, input.child_uid);
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "paused" }, null, 2) }],
    };
  },
);

// resume_nursing — resume on a side (defaults to lastUsed)
registerTool(
  "resume_nursing",
  "Resume a paused nursing timer, on `side` or the last used side",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    side: sideSchema.optional(),
  }),
  async (input) => {
    const client = await getClient();
    await resumeNursing(client, input.child_uid, { side: input.side as Side | undefined });
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "resumed" }, null, 2) }],
    };
  },
);

// switch_nursing_side — L↔R with banking
registerTool(
  "switch_nursing_side",
  "Switch the nursing side (left ⇄ right); running elapsed banks into the previous side",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    side: sideSchema.optional(), // override the natural L⇄R flip
  }),
  async (input) => {
    const client = await getClient();
    await switchNursingSide(client, input.child_uid, { side: input.side as Side | undefined });
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "switched" }, null, 2) }],
    };
  },
);

// cancel_nursing — discard without saving
registerTool(
  "cancel_nursing",
  "Cancel the running/paused nursing timer WITHOUT saving an entry",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    await cancelNursing(client, input.child_uid);
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "cancelled" }, null, 2) }],
    };
  },
);

// complete_nursing — save a breast interval + reset
registerTool(
  "complete_nursing",
  "Complete the nursing timer and save the session to history. `start` (epoch seconds) optionally corrects the saved interval start.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0).optional(),
    end: z.number().min(0).optional(),
  }),
  async (input) => {
    const client = await getClient();
    const saved = await completeNursing(client, input.child_uid, {
      start: input.start,
      end: input.end !== undefined ? new Date(input.end * 1000) : undefined,
    });
    if (!saved) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "noop", message: "No active nursing timer to complete" },
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
            {
              status: "completed",
              start: saved.startSec,
              left: saved.left,
              right: saved.right,
              total: saved.total,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// log_nursing — log a nursing session
registerTool(
  "log_nursing",
  "Log a nursing session",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0, "start is required (epoch seconds)"),
    left_duration: z.number().optional(),
    right_duration: z.number().optional(),
    last_side: z.enum(["left", "right"]).optional(),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    const id = await logNursing(client, input.child_uid, {
      start: input.start,
      leftDuration: input.left_duration,
      rightDuration: input.right_duration,
      lastSide: input.last_side,
      notes: input.notes,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ feed_id: id }, null, 2),
        },
      ],
    };
  },
);

// log_bottle — log a bottle feeding
registerTool(
  "log_bottle",
  "Log a bottle feeding",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0, "start is required (epoch seconds)"),
    amount: z.number().min(0, "amount is required"),
    bottle_type: z.string().min(1, "bottle_type is required (e.g. Breast Milk, Formula)"),
    units: z.enum(["ml", "oz"]),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    const id = await logBottle(client, input.child_uid, {
      start: input.start,
      amount: input.amount,
      bottleType: input.bottle_type,
      units: input.units,
      notes: input.notes,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ feed_id: id }, null, 2),
        },
      ],
    };
  },
);

// log_solids — log solids feeding
registerTool(
  "log_solids",
  "Log a solids feeding",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0, "start is required (epoch seconds)"),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    const id = await logSolids(client, input.child_uid, {
      start: input.start,
      notes: input.notes,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ feed_id: id }, null, 2),
        },
      ],
    };
  },
);

// log_pump — log a pumping session
registerTool(
  "log_pump",
  "Log a pumping session",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0, "start is required (epoch seconds)"),
    left_amount: z.number().min(0),
    right_amount: z.number().min(0),
    units: z.enum(["ml", "oz"]),
    duration: z.number().optional(),
    total_amount: z.number().optional(),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    const id = await logPump(client, input.child_uid, {
      start: input.start,
      leftAmount: input.left_amount,
      rightAmount: input.right_amount,
      units: input.units,
      duration: input.duration,
      totalAmount: input.total_amount,
      notes: input.notes,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ feed_id: id }, null, 2),
        },
      ],
    };
  },
);

// get_pump — read the live pump timer state
registerTool(
  "get_pump",
  "Get the child's pump document and current timer state (active/paused/start time)",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    const { timer } = await getPumpDoc(client, input.child_uid);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              timer: timer
                ? {
                    active: timer.active,
                    paused: timer.paused,
                    start_epoch_ms: timer.startTime ?? null,
                    paused_end_epoch_ms: timer.endTime ?? null,
                    units: timer.units ?? null,
                    session_uuid: timer.uuid ?? null,
                  }
                : null,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// start_pump — start the pump timer
registerTool(
  "start_pump",
  "Start the pumping timer. Pass `start` (epoch seconds) to set the session start; on an already-running timer this moves its start instead.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0).optional(),
  }),
  async (input) => {
    const client = await getClient();
    const result = await startPump(client, input.child_uid, {
      time: input.start !== undefined ? new Date(input.start * 1000) : undefined,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            result.moved
              ? { status: "moved", message: "Pump timer already active — start time moved" }
              : { status: "started" },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// pause_pump
registerTool(
  "pause_pump",
  "Pause the running pumping timer",
  z.object({ child_uid: z.string().min(1, "child_uid is required") }),
  async (input) => {
    const client = await getClient();
    await pausePump(client, input.child_uid);
    return { content: [{ type: "text", text: JSON.stringify({ status: "paused" }, null, 2) }] };
  },
);

// resume_pump
registerTool(
  "resume_pump",
  "Resume a paused pumping timer",
  z.object({ child_uid: z.string().min(1, "child_uid is required") }),
  async (input) => {
    const client = await getClient();
    await resumePump(client, input.child_uid);
    return { content: [{ type: "text", text: JSON.stringify({ status: "resumed" }, null, 2) }] };
  },
);

// cancel_pump — discard without saving
registerTool(
  "cancel_pump",
  "Cancel the running/paused pumping timer WITHOUT saving an entry",
  z.object({ child_uid: z.string().min(1, "child_uid is required") }),
  async (input) => {
    const client = await getClient();
    await cancelPump(client, input.child_uid);
    return { content: [{ type: "text", text: JSON.stringify({ status: "cancelled" }, null, 2) }] };
  },
);

// complete_pump — save amounts and reset
registerTool(
  "complete_pump",
  "Complete the pumping timer and save the session. Amounts: either `total_amount` (split evenly left/right) or both `left_amount` + `right_amount`. `start`/`end` (epoch seconds) optionally correct the interval.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    total_amount: z.number().min(0).optional(),
    left_amount: z.number().min(0).optional(),
    right_amount: z.number().min(0).optional(),
    units: z.enum(["ml", "oz"]).default("ml"),
    notes: z.string().optional(),
    start: z.number().min(0).optional(),
    end: z.number().min(0).optional(),
  }),
  async (input) => {
    const client = await getClient();
    const saved = await completePump(client, input.child_uid, {
      start: input.start !== undefined ? new Date(input.start * 1000) : undefined,
      end: input.end !== undefined ? new Date(input.end * 1000) : undefined,
      leftAmount: input.left_amount,
      rightAmount: input.right_amount,
      totalAmount: input.total_amount,
      units: input.units as "ml" | "oz",
      notes: input.notes,
    });
    if (!saved) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "noop", message: "No active pump timer to complete" },
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
            {
              status: "completed",
              start: saved.startSec,
              duration: saved.durationSec,
              entry_mode: saved.entryMode,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// list_pump_intervals — retrieve pump sessions
registerTool(
  "list_pump_intervals",
  "Retrieve pump sessions for a child",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    limit: z.number().min(1).default(50),
  }),
  async (input) => {
    const client = await getClient();
    const result = await listPumpIntervals(client, input.child_uid, {
      limit: input.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

// get_feed_history — retrieve feeding history
registerTool(
  "get_feed_history",
  "Retrieve feeding history for a child",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    limit: z.number().min(1).default(50),
  }),
  async (input) => {
    const client = await getClient();
    const result = await getFeedHistory(client, input.child_uid, {
      limit: input.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

// edit_feed — update fields on an existing feed entry (id from get_feed_history)
registerTool(
  "edit_feed",
  "Edit an existing feed entry. Get the interval_id from get_feed_history first.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    interval_id: z.string().min(1, "interval_id is required (from get_feed_history)"),
    start: z.number().min(0).optional(),
    amount: z.number().min(0).optional(),
    bottle_type: z.string().optional(),
    units: z.enum(["ml", "oz"]).optional(),
    left_duration: z.number().min(0).optional(),
    right_duration: z.number().min(0).optional(),
    last_side: z.enum(["left", "right"]).optional(),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    await editFeed(client, input.child_uid, input.interval_id, {
      start: input.start,
      amount: input.amount,
      bottleType: input.bottle_type,
      units: input.units,
      leftDuration: input.left_duration,
      rightDuration: input.right_duration,
      lastSide: input.last_side,
      notes: input.notes,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ edited: input.interval_id }, null, 2) }],
    };
  },
);

// edit_pump — update fields on an existing pump entry (id from list_pump_intervals)
registerTool(
  "edit_pump",
  "Edit an existing pump entry. Get the interval_id from list_pump_intervals first.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    interval_id: z.string().min(1, "interval_id is required (from list_pump_intervals)"),
    start: z.number().min(0).optional(),
    left_amount: z.number().min(0).optional(),
    right_amount: z.number().min(0).optional(),
    units: z.enum(["ml", "oz"]).optional(),
    duration: z.number().min(0).optional(),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    await editPump(client, input.child_uid, input.interval_id, {
      start: input.start,
      leftAmount: input.left_amount,
      rightAmount: input.right_amount,
      units: input.units,
      duration: input.duration,
      notes: input.notes,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ edited: input.interval_id }, null, 2) }],
    };
  },
);

// delete_feed — permanently remove a feed entry (id from get_feed_history)
registerTool(
  "delete_feed",
  "Permanently delete a feed entry (nursing/bottle/solids). Get the interval_id from get_feed_history first.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    interval_id: z.string().min(1, "interval_id is required (from get_feed_history)"),
  }),
  async (input) => {
    const client = await getClient();
    await deleteFeed(client, input.child_uid, input.interval_id);
    return {
      content: [{ type: "text", text: JSON.stringify({ deleted: input.interval_id }, null, 2) }],
    };
  },
);

// delete_pump — permanently remove a pump entry (id from list_pump_intervals)
registerTool(
  "delete_pump",
  "Permanently delete a pump entry. Get the interval_id from list_pump_intervals first.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    interval_id: z.string().min(1, "interval_id is required (from list_pump_intervals)"),
  }),
  async (input) => {
    const client = await getClient();
    await deletePump(client, input.child_uid, input.interval_id);
    return {
      content: [{ type: "text", text: JSON.stringify({ deleted: input.interval_id }, null, 2) }],
    };
  },
);
