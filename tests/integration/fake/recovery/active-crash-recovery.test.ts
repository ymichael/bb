import { describe, expect, it } from "vitest";
import {
  getThreadEvents,
  getThreadResponse,
  sendTextMessage,
} from "../../helpers/api.js";
import {
  waitForHostConnected,
  waitForHostDisconnected,
  waitForThreadOutputContaining,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import {
  ACTIVE_TIMEOUT_MS,
  createRecoveryThread,
  RECOVERY_TEST_TIMEOUT_MS,
  RECOVERY_TIMEOUT_MS,
  STOP_DELAY_TEXT,
} from "./shared.js";

describe.sequential("fake provider active crash recovery integration", () => {
  it(
    "marks in-flight work failed on daemon crash and allows retry after restart",
    () =>
      withHarness(async (harness) => {
        const { thread } = await createRecoveryThread(
          harness,
          "Crash Recovery Active",
        );

        await sendTextMessage(harness.api, thread.id, {
          text: STOP_DELAY_TEXT,
        });
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "active",
          ACTIVE_TIMEOUT_MS,
        );

        await harness.crashDaemon();
        await waitForHostDisconnected(
          harness.api,
          harness.hostId,
          RECOVERY_TIMEOUT_MS,
        );
        const disconnectedThread = await getThreadResponse(
          harness.api,
          thread.id,
        );
        if (disconnectedThread.status === "active") {
          expect(disconnectedThread.runtime.displayStatus).toBe(
            "host-reconnecting",
          );
        } else {
          expect(disconnectedThread.status).toBe("error");
          expect(disconnectedThread.runtime.displayStatus).toBe("error");
        }

        await harness.startDaemon();
        await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "error",
          RECOVERY_TIMEOUT_MS,
        );

        await sendTextMessage(harness.api, thread.id, {
          text: "recovered after crash",
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "recovered after crash",
          RECOVERY_TIMEOUT_MS,
        );
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          RECOVERY_TIMEOUT_MS,
        );

        const events = await getThreadEvents(harness.api, thread.id);
        expect(
          events.some(
            (event) =>
              event.type === "system/error" &&
              event.data.code === "thread_command_failed",
          ),
        ).toBe(true);
      }),
    RECOVERY_TEST_TIMEOUT_MS,
  );
});
