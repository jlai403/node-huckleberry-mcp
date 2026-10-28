import { z } from "zod";
import { registerTool } from "../server/server.js";
import { getClient } from "../server/auth.js";
import {
  logSleep,
  getSleepHistory,
  editSleep,
  deleteSleep,
  getSleepDoc,
  startSleep,
  pauseSleep,
  resumeSleep,
  cancelSleep,
  completeSleep,
} from "../client/index.js";

// T2.4: Sleep Tools (log/edit/delete/history + live timer)

// get_sleep — read the live sleep document and current timer state
registerTool(
  "get_sleep",
  "Get the child's sleep document and current timer state (active/paused/start time)",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    const { timer } = await getSleepDoc(client, input.child_uid);
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
                    start_epoch_ms: timer.timerStartTime ?? null,
                    end_epoch_ms: timer.timerEndTime ?? null,
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

// start_sleep — start the sleep timer (or move an active timer's start)
registerTool(
  "start_sleep",
  "Start the sleep timer. Pass `start` (epoch seconds) to set when the child fell asleep; on an already-running timer this moves its start instead of starting a new session.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0, "start must be epoch seconds").optional(),
  }),
  async (input) => {
    const client = await getClient();
    const result = await startSleep(client, input.child_uid, {
      time: input.start !== undefined ? new Date(input.start * 1000) : undefined,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            result.moved
              ? { status: "moved", message: "Sleep timer already active — start time moved" }
              : { status: "started" },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// pause_sleep — pause the active sleep timer
registerTool(
  "pause_sleep",
  "Pause the running sleep timer without ending the session",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    await pauseSleep(client, input.child_uid);
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "paused" }, null, 2) }],
    };
  },
);

// resume_sleep — resume a paused sleep timer
registerTool(
  "resume_sleep",
  "Resume a paused sleep timer",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    await resumeSleep(client, input.child_uid);
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "resumed" }, null, 2) }],
    };
  },
);

// cancel_sleep — cancel without saving
registerTool(
  "cancel_sleep",
  "Cancel the running/paused sleep timer WITHOUT saving an entry — the session is discarded",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
  }),
  async (input) => {
    const client = await getClient();
    await cancelSleep(client, input.child_uid);
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "cancelled" }, null, 2) }],
    };
  },
);

// complete_sleep — save the session and reset the timer
registerTool(
  "complete_sleep",
  "Complete the running/paused sleep timer and save the session to history. `start`/`end` (epoch seconds) are optional corrections to the saved interval.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0).optional(),
    end: z.number().min(0).optional(),
  }),
  async (input) => {
    const client = await getClient();
    const saved = await completeSleep(client, input.child_uid, {
      start: input.start !== undefined ? new Date(input.start * 1000) : undefined,
      end: input.end !== undefined ? new Date(input.end * 1000) : undefined,
    });
    if (!saved) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "noop", message: "No active sleep timer to complete" },
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
            { status: "completed", start: saved.startSec, duration: saved.durationSec },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// log_sleep — log a completed sleep session
registerTool(
  "log_sleep",
  "Log a completed sleep session with start and end times",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    start: z.number().min(0, "start is required (epoch seconds)"),
    end: z.number().min(0, "end is required (epoch seconds)"),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    const id = await logSleep(
      client,
      input.child_uid,
      new Date(input.start * 1000),
      new Date(input.end * 1000),
      { notes: input.notes },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ sleep_id: id }, null, 2),
        },
      ],
    };
  },
);

// get_sleep_history — retrieve sleep history for a child
registerTool(
  "get_sleep_history",
  "Retrieve sleep history for a child",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    limit: z.number().min(1).default(50),
  }),
  async (input) => {
    const client = await getClient();
    const result = await getSleepHistory(client, input.child_uid, {
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

// edit_sleep — update fields on an existing sleep entry (id from get_sleep_history)
registerTool(
  "edit_sleep",
  "Edit an existing sleep entry. Get the interval_id from get_sleep_history first.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    interval_id: z.string().min(1, "interval_id is required (from get_sleep_history)"),
    start: z.number().min(0).optional(),
    duration: z.number().min(0).optional(),
    notes: z.string().optional(),
  }),
  async (input) => {
    const client = await getClient();
    await editSleep(client, input.child_uid, input.interval_id, {
      start: input.start,
      duration: input.duration,
      notes: input.notes,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ edited: input.interval_id }, null, 2) }],
    };
  },
);

// delete_sleep — permanently remove a sleep entry (id from get_sleep_history)
registerTool(
  "delete_sleep",
  "Permanently delete a sleep entry. Get the interval_id from get_sleep_history first.",
  z.object({
    child_uid: z.string().min(1, "child_uid is required"),
    interval_id: z.string().min(1, "interval_id is required (from get_sleep_history)"),
  }),
  async (input) => {
    const client = await getClient();
    await deleteSleep(client, input.child_uid, input.interval_id);
    return {
      content: [{ type: "text", text: JSON.stringify({ deleted: input.interval_id }, null, 2) }],
    };
  },
);
