import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import {
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  wait,
  type LaunchBoundAgentRuntime,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";

describe("turn-start watchdog", () => {
  let tmpDir: string;
  let runtime: LaunchBoundAgentRuntime | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-watchdog-"));
  });

  afterEach(async () => {
    await runtime?.shutdown();
    runtime = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function waitFor<T>(
    resolve: () => T | undefined,
    timeoutMs = 3_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = resolve();
      if (value !== undefined) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting");
      }
      await wait(15);
    }
  }

  it("surfaces a visible error when an accepted turn never starts", async () => {
    const events: ThreadEvent[] = [];
    runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        turnStartWatchdog: { thresholdMs: 120, intervalMs: 25 },
      },
      launch: { scripted: { swallowTurnStart: true } },
    });

    await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222222w",
      threadId: "t1",
      input: [promptTextInput({ text: "hello" })],
      options: fullRuntimeOptions,
    });

    const watchdogEvent = await waitFor(() =>
      events.find(
        (event) =>
          event.type === "system/error" &&
          event.code === "provider_turn_start_timeout",
      ),
    );
    expect(watchdogEvent.threadId).toBe("t1");
    expect(events.some((event) => event.type === "turn/started")).toBe(false);

    await wait(120);
    expect(
      events.filter(
        (event) =>
          event.type === "system/error" &&
          event.code === "provider_turn_start_timeout",
      ),
    ).toHaveLength(1);
  });

  it("stays silent when the turn starts within the threshold", async () => {
    const events: ThreadEvent[] = [];
    runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        onEvent: (event) => events.push(event),
        turnStartWatchdog: { thresholdMs: 150, intervalMs: 25 },
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
      clientRequestId: "creq_222222222x",
      threadId: "t1",
      input: [promptTextInput({ text: "hello" })],
      options: fullRuntimeOptions,
    });

    await waitFor(() => events.find((event) => event.type === "turn/started"));
    await wait(250);
    expect(
      events.some(
        (event) =>
          event.type === "system/error" &&
          event.code === "provider_turn_start_timeout",
      ),
    ).toBe(false);
  });
});
