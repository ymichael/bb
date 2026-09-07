import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

const OPTIONS = {
  ...FULL_PERMISSION_OPTIONS,
  model: "fake-provider/fake-mini",
  reasoningLevel: "high",
};

const SETTINGS_PROCESS_TEST_TIMEOUT_MS = 60_000;

let harness: FakePiBridgeHarness;
let commandLogPath: string;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-settings-",
    initialize: true,
  });
  commandLogPath = join(harness.workspaceDir, "commands.log");
  vi.stubEnv("FAKE_PI_COMMAND_LOG", commandLogPath);
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function commandsSent(): string[] {
  return existsSync(commandLogPath)
    ? readFileSync(commandLogPath, "utf8").split("\n").filter(Boolean)
    : [];
}

it(
  "pins model and thinking at spawn and never sends set_model or set_thinking_level",
  async () => {
    const threadId = "thr_settings";
    const start = await harness.request(1, "thread/start", {
      threadId,
      cwd: harness.workspaceDir,
      instructionMode: "append",
      options: OPTIONS,
    });
    expect(start.result).toMatchObject({ providerThreadId: threadId });
    await harness.request(2, "turn/start", {
      threadId,
      providerThreadId: threadId,
      clientRequestId: "creq_ab23456789",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: OPTIONS,
    });
    let seen = await harness.waitForTurnBoundary(threadId, 0);
    await harness.request(3, "turn/start", {
      threadId,
      providerThreadId: threadId,
      clientRequestId: "creq_cd23456789",
      input: [{ type: "text", text: "again", mentions: [] }],
      options: {
        ...OPTIONS,
        model: "fake-provider/fake-model",
        reasoningLevel: "low",
      },
    });
    seen = await harness.waitForTurnBoundary(threadId, seen);
    await harness.request(4, "thread/stop", {
      threadId,
      providerThreadId: threadId,
      intent: "release",
      activeTurnId: null,
    });
    const resume = await harness.request(5, "thread/resume", {
      threadId,
      providerThreadId: threadId,
      cwd: harness.workspaceDir,
      instructionMode: "append",
      options: { ...OPTIONS, model: "fake-provider/fake-model" },
    });
    expect(resume.result).toMatchObject({ providerThreadId: threadId });
    const fork = await harness.request(6, "thread/fork", {
      threadId: "thr_settings_fork",
      cwd: harness.workspaceDir,
      sourceProviderThreadId: threadId,
      options: OPTIONS,
      instructionMode: "append",
    });
    void fork;

    const sent = commandsSent();
    expect(sent.length).toBeGreaterThan(0);
    expect(
      sent.filter((c) => c === "set_model" || c === "set_thinking_level"),
    ).toEqual([]);
    const contextWindows = harness.messages
      .filter((m) => m.method === "thread/delta")
      .flatMap(
        (m) =>
          (m.params as { deltas: { kind: string; size?: number }[] }).deltas,
      )
      .filter((d) => d.kind === "contextWindow")
      .map((d) => d.size);
    expect(contextWindows[0]).toBe(32_000);
    expect(contextWindows.at(-1)).toBe(200_000);
  },
  SETTINGS_PROCESS_TEST_TIMEOUT_MS,
);
