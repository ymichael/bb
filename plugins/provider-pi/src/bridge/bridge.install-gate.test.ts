import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PI_BRIDGE_ARGS_ENV, PI_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import {
  type FakePiBridgeHarness,
  fakePiPath,
  startFakePiBridge,
} from "./test-support.js";

let harness: FakePiBridgeHarness;
let requestId = 0;

function nextRequestId(): number {
  requestId += 1;
  return requestId;
}

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-install-gate-",
    initialize: true,
  });
});

afterEach(async () => {
  await harness.teardown();
});

it("reports ready with the installed version after the get_state probe", async () => {
  const response = await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(response.result).toMatchObject({
    supported: true,
    health: {
      status: "ready",
      installedVersion: "0.84.0",
      minimumSupportedVersion: "0.84.0",
      canInstall: true,
      canUpdate: true,
      loginCommand: "pi",
    },
  });
}, 30_000);

it("refuses a pi older than the supported minimum before spawning it", async () => {
  vi.stubEnv("FAKE_PI_VERSION", "0.83.2");
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(health.result).toMatchObject({
    health: { status: "unsupported_version", installedVersion: "0.83.2" },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toMatchObject({
    message: expect.stringContaining(
      "0.83.2 is older than the supported minimum 0.84.0",
    ),
  });
});

it("reports not_installed when the launch command is missing", async () => {
  vi.stubEnv(PI_BRIDGE_COMMAND_ENV, join(harness.workspaceDir, "no-such-pi"));
  vi.stubEnv(PI_BRIDGE_ARGS_ENV, "[]");
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(health.result).toMatchObject({
    health: { status: "not_installed", canInstall: true, canUpdate: false },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toMatchObject({
    message: expect.stringContaining("Could not find the pi CLI"),
  });
});

it("fails closed when pi cannot report its version, with install guidance", async () => {
  vi.stubEnv("FAKE_PI_VERSION", "crash");
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(health.result).toMatchObject({
    health: {
      status: "unknown",
      installedVersion: null,
      statusMessage: expect.stringMatching(
        /^Could not determine the pi version: `.*--version` exited with 1\. Install @earendil-works\/pi-coding-agent 0\.84\.0 or newer: npm install -g @earendil-works\/pi-coding-agent@latest$/u,
      ),
    },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toMatchObject({
    message: expect.stringContaining("Could not determine the pi version"),
  });
});

it("memoizes the install gate per launch path across health polls", async () => {
  const processLog = join(harness.workspaceDir, "process.log");
  vi.stubEnv("FAKE_PI_PROCESS_LOG", processLog);
  await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  const versionSpawns = readFileSync(processLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("version:"));
  expect(versionSpawns).toHaveLength(1);
  vi.stubEnv(
    PI_BRIDGE_ARGS_ENV,
    JSON.stringify([fakePiPath, "--other-launch"]),
  );
  await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(
    readFileSync(processLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("version:")),
  ).toHaveLength(2);
}, 30_000);
