import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { handleLine } from "./bridge.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

const LINE_SEPARATOR = " ";
const PARAGRAPH_SEPARATOR = " ";

let harness: FakePiBridgeHarness;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-framing-",
    sessionDir: (workspaceDir) =>
      join(workspaceDir, `sessions${LINE_SEPARATOR}dir`),
    initialize: true,
  });
});

afterEach(async () => {
  await harness.teardown();
});

it("carries U+2028/U+2029 through stdout events, RPC responses, and both channel directions", async () => {
  const threadId = "thr_framing";
  const start = await harness.request(1, "thread/start", {
    threadId,
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
    dynamicTools: [
      {
        name: "bb_probe",
        description: "A bb tool.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ],
  });
  expect(start.result).toMatchObject({ providerThreadId: threadId });

  const text = `alpha${LINE_SEPARATOR}beta${PARAGRAPH_SEPARATOR}gamma`;
  await harness.request(2, "turn/start", {
    threadId,
    providerThreadId: threadId,
    clientRequestId: "creq_ab23456789",
    input: [{ type: "text", text, mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  await harness.waitForMessage(
    (m) =>
      m.method === "thread/delta" &&
      harness.deltasOf(threadId).some((d) => d.kind === "turn.boundary"),
    "first turn boundary",
  );
  expect(
    harness
      .deltasOf(threadId)
      .some(
        (d) =>
          d.kind === "item.textDelta" &&
          String(d.text).includes(`Response to: ${text}`),
      ),
  ).toBe(true);

  const before = harness.deltasOf(threadId).length;
  const argValue = `arg${LINE_SEPARATOR}value`;
  const resultText = `result${PARAGRAPH_SEPARATOR}text`;
  handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        providerThreadId: threadId,
        clientRequestId: "creq_cd23456789",
        input: [
          {
            type: "text",
            text: `/tool bb_probe ${JSON.stringify({ value: argValue })}`,
            mentions: [],
          },
        ],
        options: FULL_PERMISSION_OPTIONS,
      },
    }),
  );
  const toolCall = await harness.waitForMessage(
    (m) => m.method === "item/tool/call",
    "tool call",
  );
  expect((toolCall.params as { arguments: unknown }).arguments).toEqual({
    value: argValue,
  });
  handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: toolCall.id,
      result: {
        contentItems: [{ type: "inputText", text: resultText }],
        success: true,
      },
    }),
  );
  await harness.waitForMessage(
    () =>
      harness
        .deltasOf(threadId)
        .slice(before)
        .some((d) => d.kind === "turn.boundary"),
    "second turn boundary",
  );
  expect(
    harness
      .deltasOf(threadId)
      .some(
        (d) =>
          d.kind === "item.textDelta" &&
          String(d.text).includes(`Tool said: ${resultText}`),
      ),
  ).toBe(true);
}, 30_000);
