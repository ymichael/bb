import {
  getCommand,
  getHostOperation,
  openSession,
  upsertHost,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  advanceSandboxRuntimeMaterialSync,
  buildSandboxRuntimeMaterialSnapshot,
  completeSandboxRuntimeMaterialSyncForCommand,
  ensureSandboxRuntimeMaterialSynced,
  failSandboxRuntimeMaterialSyncForCommand,
  requestSandboxRuntimeMaterialSync,
} from "../../src/services/hosts/sandbox-runtime-material.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("sandbox runtime material", () => {
  it("requeues failed runtime sync operations onto a new command", async () => {
    const harness = await createTestAppHarness({
      anthropicApiKey: "test-anthropic-key",
      githubPat: "test-github-pat",
      openAiApiKey: "test-openai-key",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-runtime-requeue",
        name: "Runtime Requeue Host",
        provider: "e2b",
        type: "ephemeral",
      });
      openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-runtime-requeue",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
      });

      requestSandboxRuntimeMaterialSync(harness.deps, {
        hostId: host.id,
      });
      const firstCommandId = advanceSandboxRuntimeMaterialSync(harness.deps, {
        hostId: host.id,
      });
      if (!firstCommandId) {
        throw new Error("Expected first runtime sync command to be queued");
      }

      const firstOperation = getHostOperation(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      });
      expect(firstOperation).toMatchObject({
        commandId: firstCommandId,
        state: "queued",
      });

      failSandboxRuntimeMaterialSyncForCommand(harness.deps, {
        commandId: firstCommandId,
        completedAt: 1_700_000_000_000,
        failureReason: "daemon_disconnected",
      });

      const secondCommandId = advanceSandboxRuntimeMaterialSync(harness.deps, {
        hostId: host.id,
      });
      if (!secondCommandId) {
        throw new Error("Expected second runtime sync command to be queued");
      }
      expect(secondCommandId).not.toBe(firstCommandId);

      const secondOperation = getHostOperation(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      });
      expect(secondOperation).toMatchObject({
        commandId: secondCommandId,
        failureReason: null,
        state: "queued",
      });

      const secondCommand = getCommand(harness.db, secondCommandId);
      expect(secondCommand).toMatchObject({
        hostId: host.id,
        type: "host.sync_runtime_material",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not queue a command when the desired version is already applied", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      openAiApiKey: "test-openai-key",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-runtime-applied",
        name: "Runtime Applied Host",
        provider: "e2b",
        type: "ephemeral",
      });
      openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-runtime-applied",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
      });

      const desiredSnapshot = requestSandboxRuntimeMaterialSync(harness.deps, {
        hostId: host.id,
      });
      const queuedCommandId = advanceSandboxRuntimeMaterialSync(harness.deps, {
        hostId: host.id,
      });
      if (!queuedCommandId) {
        throw new Error("Expected runtime sync command to be queued");
      }

      const completed = completeSandboxRuntimeMaterialSyncForCommand(
        harness.deps,
        {
          appliedVersion: desiredSnapshot.version,
          commandId: queuedCommandId,
          completedAt: 1_700_000_000_000,
        },
      );
      expect(completed).toBe(true);

      const requestedSnapshot = requestSandboxRuntimeMaterialSync(harness.deps, {
        hostId: host.id,
      });
      expect(requestedSnapshot).toEqual(desiredSnapshot);

      const requeuedCommandId = advanceSandboxRuntimeMaterialSync(harness.deps, {
        hostId: host.id,
      });
      expect(requeuedCommandId).toBeNull();

      const operation = getHostOperation(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      });
      expect(operation).toMatchObject({
        commandId: queuedCommandId,
        state: "completed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("waits for the queued runtime sync command and returns the desired snapshot", async () => {
    const harness = await createTestAppHarness({
      anthropicApiKey: "test-anthropic-key",
      githubPat: "test-github-pat",
      openAiApiKey: "test-openai-key",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-runtime-ensure",
        name: "Runtime Ensure Host",
        provider: "e2b",
        type: "ephemeral",
      });
      openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-runtime-ensure",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
      });

      const ensurePromise = ensureSandboxRuntimeMaterialSynced(harness.deps, {
        hostId: host.id,
      });

      const queuedRuntimeSync = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === host.id && command.type === "host.sync_runtime_material",
      );
      expect(queuedRuntimeSync.command).toMatchObject({
        env: buildSandboxRuntimeMaterialSnapshot(harness.config).env,
        type: "host.sync_runtime_material",
      });

      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        queuedRuntimeSync,
        {
          appliedVersion: queuedRuntimeSync.command.version,
        },
        {
          hostId: host.id,
          hostType: "ephemeral",
        },
      );
      expect(reportResponse.status).toBe(200);

      await expect(ensurePromise).resolves.toEqual(
        buildSandboxRuntimeMaterialSnapshot(harness.config),
      );
    } finally {
      await harness.cleanup();
    }
  });
});
