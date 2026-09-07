import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { CapturedBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./src/provider-bridge.js";

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-scripted-echo-conformance-"));
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("passes the canonical protocol suite", async () => {
  const report = await runBridgeConformance({
    transport: { send: handleLine, takeMessages: output.takeMessages },
    providerId: "scripted-echo",
    session: {
      cwd: workspaceDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      interruptiblePromptInput: [
        { type: "text", text: "hold_turn", mentions: [] },
      ],
    },
    timeoutMs: 5_000,
  });

  output.restore();
  console.info(
    `scripted echo bridge conformance:\n${formatConformanceReport(report)}`,
  );
  expect(report.results.filter((result) => result.status !== "pass")).toEqual(
    [],
  );
  expect(report.results.map((result) => result.id)).toEqual(
    expect.arrayContaining([
      "recovery/session-archived",
      "session/threads-independent",
      "stop/interrupt-settles-before-result",
    ]),
  );
  expect(report.passed).toBe(true);
}, 30_000);
