import { describe, expect, it } from "vitest";
import {
  getThreadEvents,
  getThreadOutput,
  getThreadResponse,
  sendTextMessage,
} from "../../helpers/api.js";
import {
  waitForHostConnected,
  waitForHostDisconnected,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import {
  ACTIVE_TIMEOUT_MS,
  createRecoveryThread,
  RECOVERY_TIMEOUT_MS,
  STOP_DELAY_TEXT,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider active crash recovery integration", () => {
  it("leaves an active thread waiting for its host and recovers after restart", () =>
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
      expect(disconnectedThread.status).toBe("active");
      expect(
        disconnectedThread.runtime.displayStatus === "host-reconnecting" ||
          disconnectedThread.runtime.displayStatus === "waiting-for-host",
      ).toBe(true);

      await harness.startDaemon();
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        RECOVERY_TIMEOUT_MS,
      );

      await sendTextMessage(harness.api, thread.id, {
        text: "recovered after crash",
      });
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      const events = await getThreadEvents(harness.api, thread.id);
      expect(
        events.some(
          (event) =>
            event.type === "system/thread/interrupted" &&
            event.data.reason === "host-daemon-restarted",
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === "system/error")).toBe(false);
      expect(await getThreadOutput(harness.api, thread.id)).toContain(
        "recovered after crash",
      );
    }));
});
