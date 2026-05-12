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

describe.sequential("fake provider managed crash recovery integration", () => {
  it("survives a crash with a managed-worktree environment and resumes after restart", () =>
    withHarness(async (harness) => {
      const { thread } = await createRecoveryThread(
        harness,
        "Managed Worktree Crash Restart",
        "managed-worktree",
      );

      await sendTextMessage(harness.api, thread.id, {
        text: "before managed crash",
      });
      await waitForThreadOutputContaining(
        harness.api,
        thread.id,
        "before managed crash",
        TURN_TIMEOUT_MS,
      );
      await waitForThreadStatus(
        harness.api,
        thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      await harness.crashDaemon();
      await waitForHostDisconnected(
        harness.api,
        harness.hostId,
        RECOVERY_TIMEOUT_MS,
      );

      await harness.startDaemon();
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

      await sendTextMessage(harness.api, thread.id, {
        text: "after managed crash",
      });
      await waitForThreadOutputContaining(
        harness.api,
        thread.id,
        "after managed crash",
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
