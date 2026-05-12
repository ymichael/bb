import { describe, it } from "vitest";
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
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential(
  "fake provider managed graceful recovery integration",
  () => {
    it("restarts cleanly with a managed-worktree environment and continues the thread", () =>
      withHarness(async (harness) => {
        const { thread } = await createRecoveryThread(
          harness,
          "Managed Worktree Graceful Restart",
          "managed-worktree",
        );

        await sendTextMessage(harness.api, thread.id, {
          text: "before managed restart",
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "before managed restart",
          TURN_TIMEOUT_MS,
        );
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );

        await harness.shutdownDaemon("managed-restart");
        await waitForHostDisconnected(
          harness.api,
          harness.hostId,
          RECOVERY_TIMEOUT_MS,
        );

        await harness.startDaemon();
        await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

        await sendTextMessage(harness.api, thread.id, {
          text: "after managed restart",
        });
        await waitForThreadOutputContaining(
          harness.api,
          thread.id,
          "after managed restart",
          TURN_TIMEOUT_MS,
        );
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );
      }));
  },
);
