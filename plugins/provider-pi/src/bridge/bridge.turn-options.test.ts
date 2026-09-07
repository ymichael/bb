import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

const TURN_OPTIONS_TEST_TIMEOUT_MS = 60_000;

const MINI = {
  ...FULL_PERMISSION_OPTIONS,
  model: "fake-provider/fake-mini",
  reasoningLevel: "medium",
};
const FULL_MODEL = { ...MINI, model: "fake-provider/fake-model" };

const sessionReplacedParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  reason: z.string(),
  contextLost: z.boolean(),
});

let harness: FakePiBridgeHarness;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-turn-options-",
    initialize: true,
  });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function sessionReplacements(
  threadId: string,
): z.infer<typeof sessionReplacedParamsSchema>[] {
  return harness.messages
    .filter((message) => message.method === "session/replaced")
    .map((message) => sessionReplacedParamsSchema.parse(message.params))
    .filter((params) => params.threadId === threadId);
}

function contextWindowSizes(threadId: string): number[] {
  return harness
    .deltasOf(threadId)
    .filter((delta) => delta.kind === "contextWindow")
    .map((delta) => delta.size)
    .filter((size): size is number => typeof size === "number");
}

function turnStart(
  id: number,
  threadId: string,
  text: string,
  options: BridgeJsonRpcObject,
): Promise<BridgeJsonRpcOutputMessage> {
  return harness.request(id, "turn/start", {
    threadId,
    providerThreadId: threadId,
    clientRequestId: `creq_abcdefghi${"23456789"[id % 8] ?? "2"}`,
    input: [{ type: "text", text, mentions: [] }],
    options,
  });
}

it(
  "rebuilds the session on the model a later turn carries",
  async () => {
    const threadId = "thr_turn_options_model";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    let seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(contextWindowSizes(threadId)).toEqual([32_000]);
    expect(sessionReplacements(threadId)).toEqual([]);

    expect(
      (await turnStart(2, threadId, "second", FULL_MODEL)).error,
    ).toBeUndefined();
    seen = await harness.waitForTurnBoundary(threadId, seen);

    expect(contextWindowSizes(threadId).at(-1)).toBe(200_000);
    expect(sessionReplacements(threadId)).toEqual([
      {
        threadId,
        providerThreadId: threadId,
        reason: expect.stringContaining("Execution settings changed"),
        contextLost: false,
      },
    ]);
    expect(
      harness
        .deltasOf(threadId)
        .filter((delta) => delta.kind === "session.reset"),
    ).toHaveLength(2);

    expect(
      (await turnStart(3, threadId, "third", FULL_MODEL)).error,
    ).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(sessionReplacements(threadId)).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "rebuilds the session on the reasoning level a later turn carries",
  async () => {
    const threadId = "thr_turn_options_level";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(sessionReplacements(threadId)).toEqual([]);

    expect(
      (
        await turnStart(2, threadId, "second", {
          ...MINI,
          reasoningLevel: "high",
        })
      ).error,
    ).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);

    expect(sessionReplacements(threadId)).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "compacts with the model the compaction turn selected",
  async () => {
    const threadId = "thr_turn_options_compact";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);

    const compaction = await harness.request(2, "turn/start", {
      threadId,
      providerThreadId: threadId,
      clientRequestId: "creq_abcdefghij",
      input: [
        {
          type: "text",
          text: "/compact",
          mentions: [
            {
              start: 0,
              end: 8,
              resource: {
                kind: "command",
                trigger: "/",
                name: "compact",
                source: "command",
                origin: "builtin",
                label: "compact",
                argumentHint: null,
              },
            },
          ],
        },
      ],
      options: FULL_MODEL,
    });
    expect(compaction.result).toMatchObject({ threadId });

    await harness.waitForDelta(
      threadId,
      (delta) => delta.kind === "contextWindow" && delta.size === 200_000,
      seen,
    );
    expect(sessionReplacements(threadId)).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "fails a turn whose model cannot be resolved and keeps the live session",
  async () => {
    const threadId = "thr_turn_options_bad_model";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);

    expect(
      (
        await turnStart(2, threadId, "second", {
          ...MINI,
          model: "no-such-model",
        })
      ).error,
    ).toMatchObject({
      code: -32000,
      message: 'Failed to resolve Pi model "no-such-model"',
    });
    expect(sessionReplacements(threadId)).toEqual([]);

    expect((await turnStart(3, threadId, "third", MINI)).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(contextWindowSizes(threadId).at(-1)).toBe(32_000);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "keeps serving the thread when the replacement child never starts",
  async () => {
    const threadId = "thr_turn_options_dead_replacement";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);

    vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", "1");
    const failed = await turnStart(2, threadId, "second", FULL_MODEL);
    vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", undefined);

    expect(failed.error).toMatchObject({ code: -32000 });
    expect(sessionReplacements(threadId)).toEqual([]);

    const recovered = await turnStart(3, threadId, "third", MINI);
    expect(recovered.error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(contextWindowSizes(threadId).at(-1)).toBe(32_000);
    expect(sessionReplacements(threadId)).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "steers the running turn without rebuilding on its options",
  async () => {
    const threadId = "thr_turn_options_steer";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "/hold", MINI)).error).toBeUndefined();
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open");

    const steer = await harness.request(2, "turn/steer", {
      threadId,
      providerThreadId: threadId,
      clientRequestId: "creq_abcdefghik",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steered", mentions: [] }],
      options: FULL_MODEL,
    });
    expect(steer.result).toMatchObject({ threadId });
    expect(sessionReplacements(threadId)).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);
