import { describe, expect, it } from "vitest";
import { appendStoredThreadEvent, queueCommand } from "@bb/db";
import {
  clientTurnRequestIdSchema,
  threadScope,
  turnRequestEventDataSchema,
} from "@bb/domain";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import { getThreadEvents, sendTextMessage } from "../../helpers/api.js";
import {
  waitForEventType,
  waitForEvents,
  waitForHostConnected,
  waitForHostDisconnected,
  waitForThreadOutputContaining,
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
        await createRecoveryThread(harness, "Queued Work Recovery");

      await sendTextMessage(harness.api, thread.id, {
        text: "queued baseline",
      });
      await waitForThreadOutputContaining(
        harness.api,
        thread.id,
        "queued baseline",
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

      const eventsBefore = await getThreadEvents(harness.api, thread.id);
      const providerThreadId = readLatestProviderThreadId(
        harness.db,
        thread.id,
      );
      if (!providerThreadId || !environment.path) {
        throw new Error(
          "Expected queued recovery turn to have provider context",
        );
      }
      const requestId = clientTurnRequestIdSchema.parse("creq_23456789ae");
      const queuedRequest = turnRequestEventDataSchema.parse({
        direction: "outbound",
        requestId,
        source: "tell",
        initiator: "user",
        input: [{ type: "text", text: "queued while offline" }],
        target: { kind: "new-turn" },
        request: { method: "turn/start", params: {} },
        execution: {
          model: `${thread.providerId}-model`,
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          serviceTier: "default",
          source: "client/turn/requested",
        },
      });
      appendStoredThreadEvent(harness.db, harness.hub, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: queuedRequest,
      });
      const queuedTurnSubmitCommand = hostDaemonCommandSchema.parse({
        type: "turn.submit",
        environmentId: environment.id,
        threadId: thread.id,
        options: {
          model: `${thread.providerId}-model`,
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          serviceTier: "default",
        },
        requestId,
        input: queuedRequest.input,
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
        target: { mode: "start" },
      });
      if (queuedTurnSubmitCommand.type !== "turn.submit") {
        throw new Error("Expected queued offline turn.submit command");
      }
      queueCommand(harness.db, harness.hub, {
        hostId: harness.hostId,
        sessionId: null,
        type: queuedTurnSubmitCommand.type,
        payload: JSON.stringify(queuedTurnSubmitCommand),
      });
      expect(queuedTurnSubmitCommand.requestId).toBe(queuedRequest.requestId);

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
      await waitForThreadOutputContaining(
        harness.api,
        thread.id,
        "queued while offline",
        RECOVERY_TIMEOUT_MS,
      );
    }));
});
