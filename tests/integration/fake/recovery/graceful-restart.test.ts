import { describe, expect, it } from "vitest";
import { sendTextMessage } from "../../helpers/api.js";
import {
  waitForHostConnected,
  waitForHostDisconnected,
  waitForThreadOutputContaining,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import {
  createRecoveryThread,
  RECOVERY_TIMEOUT_MS,
  requireSessionId,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider graceful recovery integration", () => {
  it("restarts cleanly after a graceful shutdown and continues an existing thread", () =>
    withHarness(async (harness) => {
      const { thread } = await createRecoveryThread(
        harness,
        "Graceful Shutdown Recovery",
      );
      const oldSessionId = requireSessionId(harness);

      await sendTextMessage(harness.api, thread.id, {
        text: "before graceful restart",
      });
      await waitForThreadOutputContaining(
        harness.api,
        thread.id,
        "before graceful restart",
        TURN_TIMEOUT_MS,
      );
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      await harness.shutdownDaemon("graceful-restart");
      await waitForHostDisconnected(
        harness.api,
        harness.hostId,
        RECOVERY_TIMEOUT_MS,
      );

      await harness.startDaemon();
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);
      const newSessionId = requireSessionId(harness);
      expect(newSessionId).not.toBe(oldSessionId);

      await sendTextMessage(harness.api, thread.id, {
        text: "after graceful restart",
      });
      await waitForThreadOutputContaining(
        harness.api,
        thread.id,
        "after graceful restart",
        TURN_TIMEOUT_MS,
      );
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );
    }));
});
