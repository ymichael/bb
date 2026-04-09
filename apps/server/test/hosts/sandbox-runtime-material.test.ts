import {
  getCommand,
  getHostOperation,
  hostDaemonSessions,
  openSession,
  upsertHost,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  ensureSandboxRuntimeMaterialSynced,
  requestSandboxRuntimeMaterialSync,
  advanceSandboxRuntimeMaterialSync,
} from "../../src/services/hosts/sandbox-runtime-material.js";
import {
  completeSandboxRuntimeMaterialSyncForCommand,
  failSandboxRuntimeMaterialSyncForCommand,
} from "../../src/services/hosts/sandbox-runtime-material-operation.js";
import { buildSandboxRuntimeMaterialSnapshot } from "../../src/services/hosts/sandbox-runtime-material-snapshot.js";
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
      expect(secondCommand?.payload).not.toContain("test-github-pat");
      expect(secondCommand?.payload).not.toContain("test-openai-key");
      expect(firstOperation?.payload).not.toContain("test-github-pat");
      expect(firstOperation?.payload).not.toContain("test-openai-key");
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
        type: "host.sync_runtime_material",
        version: buildSandboxRuntimeMaterialSnapshot(harness.config).version,
      });
      expect(queuedRuntimeSync.row.payload).not.toContain("test-github-pat");
      expect(queuedRuntimeSync.row.payload).not.toContain("test-openai-key");

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

  it("reports a stale session lease instead of host_disconnected when sync cannot be queued", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-runtime-expired-session",
        name: "Runtime Expired Session Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const session = openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-runtime-expired-session",
        leaseTimeoutMs: 30_000,
        protocolVersion: 2,
      });
      harness.db
        .update(hostDaemonSessions)
        .set({
          leaseExpiresAt: Date.now() - 1,
        })
        .where(eq(hostDaemonSessions.id, session.id))
        .run();

      await expect(
        ensureSandboxRuntimeMaterialSynced(harness.deps, {
          hostId: host.id,
        }),
      ).rejects.toMatchObject({
        body: {
          code: "host_session_expired",
        },
        status: 502,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("fails when the daemon reports a mismatched runtime material version", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      openAiApiKey: "test-openai-key",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-runtime-version-mismatch",
        name: "Runtime Version Mismatch Host",
        provider: "e2b",
        type: "ephemeral",
      });
      openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-runtime-version-mismatch",
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

      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        queuedRuntimeSync,
        {
          appliedVersion: "runtime-version-other",
        },
        {
          hostId: host.id,
          hostType: "ephemeral",
        },
      );
      expect(reportResponse.status).toBe(200);

      await expect(ensurePromise).rejects.toMatchObject({
        body: {
          code: "internal_error",
          message: "Daemon reported a mismatched runtime material version",
        },
        status: 500,
      });
    } finally {
      await harness.cleanup();
    }
  });
});
