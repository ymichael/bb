import { describe, expect, it } from "vitest";
import { queueCommand } from "@bb/db";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import {
  getThreadEvents,
  getThreadOutput,
  sendTextMessage,
} from "../../helpers/api.js";
import {
  waitForEventType,
  waitForEvents,
  waitForHostConnected,
  waitForHostDisconnected,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import { readLatestProviderThreadId } from "../../helpers/queries.js";
import {
  createRecoveryThread,
  RECOVERY_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider offline queue recovery integration", () => {
  it("drains queued work that was inserted while the daemon was offline", () =>
    withHarness(async (harness) => {
      const { environment, projectName, projectRootPath, thread } =
        await createRecoveryThread(
          harness,
          "Queued Work Recovery",
        );

      await sendTextMessage(harness.api, thread.id, {
        text: "queued baseline",
      });
      await waitForThreadStatus(harness.api, thread.id, "idle", TURN_TIMEOUT_MS);

      await harness.crashDaemon();
      await waitForHostDisconnected(
        harness.api,
        harness.hostId,
        RECOVERY_TIMEOUT_MS,
      );

      const eventsBefore = await getThreadEvents(harness.api, thread.id);
      const providerThreadId = readLatestProviderThreadId(harness.db, thread.id);
      if (!providerThreadId || !environment.path) {
        throw new Error("Expected queued recovery turn to have provider context");
      }
      const queuedTurnRunCommand = hostDaemonCommandSchema.parse({
        type: "turn.run",
        environmentId: environment.id,
        threadId: thread.id,
        options: {
          model: `${thread.providerId}-model`,
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          serviceTier: "default",
        },
        eventSequence: eventsBefore.length + 1,
        input: [{ type: "text", text: "queued while offline" }],
        resumeContext: {
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          },
          projectId: thread.projectId,
          providerId: thread.providerId,
          providerThreadId,
          instructions: `Recovered queued work for ${projectName} in ${projectRootPath}`,
          instructionMode: "append",
          dynamicTools: [],
        },
      });
      queueCommand(harness.db, harness.hub, {
        hostId: harness.hostId,
        sessionId: null,
        type: queuedTurnRunCommand.type,
        payload: JSON.stringify(queuedTurnRunCommand),
      });

      await harness.startDaemon();
      await waitForHostConnected(harness.api, RECOVERY_TIMEOUT_MS);
      await waitForEvents(
        harness.api,
        thread.id,
        eventsBefore.length + 2,
        RECOVERY_TIMEOUT_MS,
      );
      await waitForEventType(
        harness.api,
        thread.id,
        "turn/completed",
        RECOVERY_TIMEOUT_MS,
      );

      expect(await getThreadOutput(harness.api, thread.id)).toContain(
        "queued while offline",
      );
    }));
});
