import { describe, expect, it } from "vitest";
import { getThread, sendTextMessage } from "../../helpers/api.js";
import {
  waitForHostConnected,
  waitForHostDisconnected,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import {
  applyThreadLifecycleEvent,
  requireThreadLifecycleEventApplied,
} from "@bb/db";
import {
  createRecoveryThread,
  RECOVERY_TEST_TIMEOUT_MS,
  RECOVERY_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider idle-error reconciliation integration", () => {
  it(
    "does not revive an idle thread that was manually marked errored before reconnect",
    () =>
      withHarness(async (harness) => {
        const { thread } = await createRecoveryThread(
          harness,
          "Reconciliation Idle Error",
        );

        await sendTextMessage(harness.api, thread.id, {
          text: "reconciliation baseline",
        });
        await waitForThreadStatus(
          harness.api,
          thread.id,
          "idle",
          TURN_TIMEOUT_MS,
        );

        await harness.shutdownDaemon("reconciliation-stop");
        await waitForHostDisconnected(
          harness.api,
          harness.hostId,
          RECOVERY_TIMEOUT_MS,
        );

        requireThreadLifecycleEventApplied(
          applyThreadLifecycleEvent(harness.db, {
            event: { type: "run.started" },
            threadId: thread.id,
          }),
        );
        requireThreadLifecycleEventApplied(
          applyThreadLifecycleEvent(harness.db, {
            event: { type: "run.failed" },
            threadId: thread.id,
          }),
        );

        await harness.startDaemon();
        await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);

        const afterReconnect = await getThread(harness.api, thread.id);
        expect(afterReconnect.status).toBe("error");
      }),
    RECOVERY_TEST_TIMEOUT_MS,
  );
});
