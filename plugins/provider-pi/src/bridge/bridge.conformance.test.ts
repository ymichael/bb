import { afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import { type FakePiBridgeHarness, startFakePiBridge } from "./test-support.js";

const CONFORMANCE_WAIT_TIMEOUT_MS = 30_000;

let harness: FakePiBridgeHarness;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-conformance-ws-",
    initialize: false,
  });
});

afterEach(async () => {
  await harness.teardown();
});

it("passes the canonical protocol suite against a scripted pi rpc child", async () => {
  const report = await runBridgeConformance({
    transport: { send: handleLine, takeMessages: harness.takeMessages },
    providerId: "pi",
    session: {
      cwd: harness.workspaceDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      interruptiblePromptInput: [{ type: "text", text: "/hold", mentions: [] }],
    },
    timeoutMs: CONFORMANCE_WAIT_TIMEOUT_MS,
  });

  console.info(`pi bridge conformance:\n${formatConformanceReport(report)}`);

  const statusById = Object.fromEntries(
    report.results.map((result) => [result.id, result.status]),
  );
  expect(statusById).toMatchObject({
    "rpc/unknown-method": "pass",
    "rpc/invalid-params": "pass",
    "rpc/non-json-ignored": "pass",
    "rpc/response-not-request": "pass",
    "handshake/initialize": "pass",
    "session/start-identity": "pass",
    "turn/lifecycle": "pass",
    "events/schema-valid": "pass",
    "item/opens-before-delta": "pass",
    "stop/release-not-interrupted": "pass",
    "session/resume-identity": "pass",
    "session/resume-id-uniqueness": "pass",
    "session/fork-identity": "pass",
    "session/threads-independent": "pass",
    "stop/interrupt-settles-before-result": "pass",
  });
  expect(
    report.results
      .filter((result) => result.status !== "pass")
      .map((r) => r.id),
  ).toEqual([]);
}, 60_000);
