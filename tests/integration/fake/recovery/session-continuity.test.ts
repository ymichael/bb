import { describe, expect, it } from "vitest";
import { getThreadEvents, sendTextMessage } from "../../helpers/api.js";
import {
  waitForHostConnected,
  waitForThreadOutputContaining,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import { readSessionRow } from "../../helpers/queries.js";
import { assertMonotonicSequences } from "../smoke/shared.js";
import {
  createRecoveryThread,
  RECOVERY_TEST_TIMEOUT_MS,
  RECOVERY_TIMEOUT_MS,
  requireSessionId,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider session continuity integration", () => {
  it(
    "preserves event sequencing and completes new work across restart",
    () =>
      withHarness(async (harness) => {
        const { thread } = await createRecoveryThread(
          harness,
          "Restart Continuity",
        );

        await sendTextMessage(harness.api, thread.id, {
          text: "cursor first turn",
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "cursor first turn",
          TURN_TIMEOUT_MS,
        );
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );

        const eventsBefore = await getThreadEvents(harness.api, thread.id);
        const baselineCompletedCount = eventsBefore.filter(
          (event) => event.type === "turn/completed",
        ).length;

        await harness.restartDaemon("cursor-restart");
        await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

        await sendTextMessage(harness.api, thread.id, {
          text: "cursor second turn",
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "cursor second turn",
          TURN_TIMEOUT_MS,
        );
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );

        const eventsAfter = await getThreadEvents(harness.api, thread.id);
        expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
        assertMonotonicSequences(eventsAfter);
        const messageLifecycles = new Map<string, string[]>();
        for (const event of eventsAfter) {
          if (
            (event.type === "item/started" ||
              event.type === "item/completed") &&
            event.data.item.type === "agentMessage"
          ) {
            const lifecycle = messageLifecycles.get(event.data.item.id) ?? [];
            lifecycle.push(event.type);
            messageLifecycles.set(event.data.item.id, lifecycle);
          }
        }
        expect(messageLifecycles.size).toBe(baselineCompletedCount + 1);
        for (const lifecycle of messageLifecycles.values()) {
          expect(lifecycle).toEqual(["item/started", "item/completed"]);
        }
        expect(
          eventsAfter.filter((event) => event.type === "turn/completed"),
        ).toHaveLength(baselineCompletedCount + 1);
      }),
    RECOVERY_TEST_TIMEOUT_MS,
  );

  it(
    "closes the old daemon session after restart and accepts new live work",
    () =>
      withHarness(async (harness) => {
        const { thread } = await createRecoveryThread(
          harness,
          "Old Session Rejection",
        );
        const oldSessionId = requireSessionId(harness);

        await sendTextMessage(harness.api, thread.id, {
          text: "before session rotation",
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "before session rotation",
          TURN_TIMEOUT_MS,
        );
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );

        await harness.restartDaemon("old-session-restart");
        await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

        const oldSession = readSessionRow(harness.db, oldSessionId);
        expect(oldSession?.status).toBe("closed");

        await sendTextMessage(harness.api, thread.id, {
          text: "after session restart",
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "after session restart",
          TURN_TIMEOUT_MS,
        );
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );
      }),
    RECOVERY_TEST_TIMEOUT_MS,
  );
});
