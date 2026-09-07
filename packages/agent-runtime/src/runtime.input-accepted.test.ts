import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { getThreadEventScopeTurnId } from "@bb/domain";
import { BRIDGE_JSON_RPC_ERRORS } from "@bb/provider-bridge-protocol";
import {
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  waitForThreadTurnStarted,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";

function inputAcceptedEvents(
  events: readonly ThreadEvent[],
  clientRequestId: string,
): ThreadEvent[] {
  return events.filter(
    (event) =>
      event.type === "turn/input/accepted" &&
      event.clientRequestId === clientRequestId,
  );
}

describe("createAgentRuntime input accepted events", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits input accepted events only after accepted commands", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
      },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222222u",
      threadId: "t1",
      input: [promptTextInput({ text: "delay:500 active turn" })],
      options: fullRuntimeOptions,
    });
    const { turnId } = await waitForThreadTurnStarted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });
    expect(inputAcceptedEvents(events, "creq_23456789ae")).toHaveLength(0);

    await expect(
      runtime.steerTurn({
        threadId: "t1",
        expectedTurnId: turnId,
        clientRequestId: "creq_23456789ae",
        input: [promptTextInput({ text: "accepted steer" })],
        options: fullRuntimeOptions,
      }),
    ).resolves.toEqual({ status: "steered" });

    const accepted = inputAcceptedEvents(events, "creq_23456789ae");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      type: "turn/input/accepted",
      threadId: "t1",
      providerThreadId: "prov-1",
      clientRequestId: "creq_23456789ae",
    });
    expect(getThreadEventScopeTurnId(accepted[0]?.scope)).toBe(turnId);

    await runtime.shutdown();
  });

  it("does not emit provider accepted-command events when a command is rejected", async () => {
    const events: ThreadEvent[] = [];
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
      },
      launch: {
        scripted: {
          failMethods: [{ method: "turn/steer", message: "No active session" }],
        },
      },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222222v",
      threadId: "t1",
      input: [promptTextInput({ text: "delay:500 active turn" })],
      options: fullRuntimeOptions,
    });
    const { turnId } = await waitForThreadTurnStarted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });

    await expect(
      runtime.steerTurn({
        clientRequestId: "creq_222222222w",
        threadId: "t1",
        expectedTurnId: turnId,
        input: [promptTextInput({ text: "rejected steer" })],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(/No active session/);

    expect(inputAcceptedEvents(events, "creq_222222222w")).toHaveLength(0);
    expect(runtime.getActiveTurnId("t1")).toBe(turnId);

    await runtime.shutdown();
  });

  it("maps a staleTurn steer rejection to a stale steer", async () => {
    const events: ThreadEvent[] = [];
    const record = createScriptedEchoRequestRecord();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: record.env,
        onEvent: (event) => events.push(event),
      },
      launch: {
        scripted: {
          failMethods: [
            {
              method: "turn/steer",
              message: "No active turn to steer",
              code: BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
              recovery: { kind: "staleTurn", retryable: false },
            },
          ],
        },
      },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "acp-cursor",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222222x",
      threadId: "t1",
      input: [promptTextInput({ text: "delay:500 active turn" })],
      options: fullRuntimeOptions,
    });
    const { turnId } = await waitForThreadTurnStarted({
      events,
      providerId: "acp-cursor",
      runtime,
      threadId: "t1",
    });

    await expect(
      runtime.steerTurn({
        clientRequestId: "creq_222222222y",
        threadId: "t1",
        expectedTurnId: turnId,
        input: [promptTextInput({ text: "late steer" })],
        options: fullRuntimeOptions,
      }),
    ).resolves.toEqual({ status: "stale", activeTurnId: null });
    expect(runtime.getActiveTurnId("t1")).toBeNull();
    const steersSentSoFar = record
      .read()
      .filter((request) => request.method === "turn/steer").length;
    expect(steersSentSoFar).toBe(1);

    await expect(
      runtime.steerTurn({
        clientRequestId: "creq_222222222z",
        threadId: "t1",
        expectedTurnId: turnId,
        input: [promptTextInput({ text: "still late" })],
        options: fullRuntimeOptions,
      }),
    ).resolves.toEqual({ status: "stale", activeTurnId: null });
    expect(
      record.read().filter((request) => request.method === "turn/steer"),
    ).toHaveLength(1);
    expect(inputAcceptedEvents(events, "creq_222222222y")).toHaveLength(0);
    expect(inputAcceptedEvents(events, "creq_222222222z")).toHaveLength(0);

    await runtime.shutdown();
  });
});
