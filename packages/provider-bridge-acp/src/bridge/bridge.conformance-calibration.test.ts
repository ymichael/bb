import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  formatConformanceReport,
  runBridgeConformance,
} from "@bb/provider-bridge-protocol/conformance";
import { captureBridgeJsonRpcOutput } from "@bb/provider-bridge-protocol/testing";
import type { CapturedBridgeJsonRpcOutput } from "@bb/provider-bridge-protocol/testing";

import { handleLine } from "./bridge.js";

const FAKE_AGENT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fake-acp-agent.mjs",
);

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-acp-conformance-"));
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("passes the canonical protocol suite against the fake agent", async () => {
  const report = await runBridgeConformance({
    transport: { send: handleLine, takeMessages: output.takeMessages },
    providerId: "acp",
    session: {
      cwd: workspaceDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      zeroWorkPromptInput: [{ type: "text", text: "/compact", mentions: [] }],
      interruptiblePromptInput: [{ type: "text", text: "hang", mentions: [] }],
      options: {
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
        providerOptions: {
          acpLaunchSpec: {
            displayName: "Fake ACP Agent",
            command: process.execPath,
            args: [FAKE_AGENT_PATH],
            env: { FAKE_ACP_FORK_SESSION: "1" },
          },
        },
      },
    },
    timeoutMs: 10_000,
  });

  console.info(`acp bridge conformance:\n${formatConformanceReport(report)}`);

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
    "turn/settles-without-activity": "pass",
    "session/threads-independent": "pass",
    "stop/interrupt-settles-before-result": "pass",
  });

  expect(report.passed).toBe(true);
}, 60_000);
