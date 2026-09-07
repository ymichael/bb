import { describe, expect, it } from "vitest";
import {
  getThreadEvents,
  sendTextMessage,
  stopThread,
} from "../helpers/api.js";
import { waitForThreadStatus } from "../helpers/assertions.js";
import {
  countTurnEvents,
  createRealThread,
  expectNonEmptyOutput,
  resolveExecutionOptions,
  REAL_PROVIDER_IDS,
  sendAndWaitForIdle,
  sendLongRunningTurnAndWaitStarted,
  STOP_TIMEOUT_MS,
  TEST_TIMEOUT_MS,
  waitForInputAcceptedAfter,
} from "./provider-smoke-harness.js";

describe("real provider control integration", () => {
  for (const providerId of REAL_PROVIDER_IDS) {
    it.concurrent(
      `${providerId} can steer, stop, and recover an active turn`,
      async () => {
        const { harness, thread } = await createRealThread({
          providerId,
          workspace: {
            path: null,
            type: "unmanaged",
          },
        });

        try {
          const execution = await resolveExecutionOptions({
            harness,
            providerId,
          });
          const activeTurn = await sendLongRunningTurnAndWaitStarted({
            providerId,
            harness,
            threadId: thread.id,
          });
          const steerBaselineEvents = await getThreadEvents(
            harness.api,
            thread.id,
          );
          const steerBaselineSequence = Math.max(
            0,
            ...steerBaselineEvents.map((event) => event.seq),
          );
          const steerText = `Steer acknowledgement ${providerId}`;
          await sendTextMessage(harness.api, thread.id, {
            execution,
            mode: "steer",
            text: steerText,
          });
          const inputAccepted = await waitForInputAcceptedAfter({
            baselineSequence: steerBaselineSequence,
            harness,
            threadId: thread.id,
          });
          expect(inputAccepted.turnId).toBe(activeTurn.turnId);

          await stopThread(harness.api, thread.id);
          await waitForThreadStatus(
            harness.api,
            thread.id,
            "idle",
            STOP_TIMEOUT_MS,
          );

          const beforeRecoveryEvents = await getThreadEvents(
            harness.api,
            thread.id,
          );
          const { events, output } = await sendAndWaitForIdle({
            providerId,
            threadId: thread.id,
            text: "Reply with exactly: READY",
            harness,
          });
          expect(countTurnEvents(events, "turn/completed")).toBeGreaterThan(
            countTurnEvents(beforeRecoveryEvents, "turn/completed"),
          );
          expectNonEmptyOutput(output, `${providerId} recovery output`);
        } finally {
          await harness.cleanup();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
