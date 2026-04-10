import {
  buildCloudAuthCredentialUpsert,
  createCloudAuthCrypto,
  type StoredCloudAuthCredential,
} from "@bb/agent-provider-auth";
import { buildHostRuntimeMaterialState, replaceManagedRuntimeFiles } from "@bb/host-runtime-material";
import {
  getCommand,
  getHostOperation,
  hostDaemonSessions,
  openSession,
  upsertSandboxProviderCredential,
  upsertHost,
} from "@bb/db";
import fs from "node:fs/promises";
import os from "node:os";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { TestAppHarness } from "../helpers/test-app.js";
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

interface SeedSandboxCredentialArgs {
  credential: StoredCloudAuthCredential;
  harness: TestAppHarness;
  lastRefreshedAt: number | null;
  updatedAt: number;
}

async function seedSandboxCredential(
  args: SeedSandboxCredentialArgs,
): Promise<void> {
  const crypto = await createCloudAuthCrypto({
    dataDir: args.harness.config.dataDir,
  });
  upsertSandboxProviderCredential(
    args.harness.db,
    buildCloudAuthCredentialUpsert({
      credential: args.credential,
      crypto,
      label: null,
      lastErrorMessage: null,
      lastRefreshedAt: args.lastRefreshedAt,
      updatedAt: args.updatedAt,
    }),
  );
}

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

      await requestSandboxRuntimeMaterialSync(harness.deps, {
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

      const desiredSnapshot = await requestSandboxRuntimeMaterialSync(harness.deps, {
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

      const requestedSnapshot = await requestSandboxRuntimeMaterialSync(harness.deps, {
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
      const desiredSnapshot = await buildSandboxRuntimeMaterialSnapshot(harness.deps);
      expect(queuedRuntimeSync.command).toMatchObject({
        type: "host.sync_runtime_material",
        version: desiredSnapshot.version,
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
        desiredSnapshot,
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

  it("merges app sandbox env vars ahead of provider-specific env", async () => {
    const harness = await createTestAppHarness({
      openAiApiKey: "server-openai-key",
    });

    try {
      await harness.deps.sandboxEnv.upsertEnvVar({
        name: "OPENAI_API_KEY",
        value: "custom-openai-key",
      });
      await harness.deps.sandboxEnv.upsertEnvVar({
        name: "PI_API_TOKEN",
        value: "pi-api-token",
      });

      const snapshot = await buildSandboxRuntimeMaterialSnapshot(harness.deps);

      expect(snapshot.env).toEqual({
        OPENAI_API_KEY: "custom-openai-key",
        PI_API_TOKEN: "pi-api-token",
      });
      expect(snapshot.files).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });

  it("lets cloud auth runtime env override custom sandbox env vars", async () => {
    const harness = await createTestAppHarness();

    try {
      await seedSandboxCredential({
        credential: {
          accessToken: "codex-access-token",
          accountId: "acct_codex_test",
          expiresAt: 1_900_000_100_000,
          idToken: "codex-id-token",
          providerId: "codex",
          refreshToken: "codex-refresh-token",
        },
        harness,
        lastRefreshedAt: 1_800_000_100_000,
        updatedAt: 1_800_000_100_100,
      });
      await harness.deps.sandboxEnv.upsertEnvVar({
        name: "PI_CODING_AGENT_DIR",
        value: "/tmp/custom-pi",
      });

      const snapshot = await buildSandboxRuntimeMaterialSnapshot(harness.deps);

      expect(snapshot.env).toEqual({
        OPENAI_API_KEY: "test-openai-key",
        PI_CODING_AGENT_DIR: "~/.pi/agent",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("builds managed auth files from encrypted stored credentials", async () => {
    const harness = await createTestAppHarness();

    try {
      await seedSandboxCredential({
        credential: {
          accessToken: "claude-access-token",
          accountEmail: "claude@example.test",
          accountId: "acct_claude_test",
          expiresAt: 1_900_000_000_000,
          providerId: "claude-code",
          refreshToken: "claude-refresh-token",
          scopes: ["user:profile", "user:sessions:claude_code"],
          subscriptionType: "max",
        },
        harness,
        lastRefreshedAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_100,
      });
      await seedSandboxCredential({
        credential: {
          accessToken: "codex-access-token",
          accountId: "acct_codex_test",
          expiresAt: 1_900_000_100_000,
          idToken: "codex-id-token",
          providerId: "codex",
          refreshToken: "codex-refresh-token",
        },
        harness,
        lastRefreshedAt: 1_800_000_100_000,
        updatedAt: 1_800_000_100_100,
      });

      const snapshot = await buildSandboxRuntimeMaterialSnapshot(harness.deps);
      expect(snapshot.env).toEqual({
        OPENAI_API_KEY: "test-openai-key",
        PI_CODING_AGENT_DIR: "~/.pi/agent",
      });

      const claudeFile = snapshot.files.find(
        (file) => file.path === "~/.claude/.credentials.json",
      );
      expect(claudeFile?.contents).toContain("\"accessToken\": \"claude-access-token\"");
      expect(claudeFile?.contents).toContain("\"refreshToken\": \"\"");

      const codexFile = snapshot.files.find(
        (file) => file.path === "~/.codex/auth.json",
      );
      expect(codexFile?.contents).toContain("\"access_token\": \"codex-access-token\"");
      expect(codexFile?.contents).toContain("\"refresh_token\": \"\"");
      expect(codexFile?.contents).toContain("\"id_token\": \"codex-id-token\"");

      const piFile = snapshot.files.find(
        (file) => file.path === "~/.pi/agent/auth.json",
      );
      expect(piFile?.contents).toContain("\"anthropic\"");
      expect(piFile?.contents).toContain("\"openai-codex\"");
      expect(piFile?.contents).toContain("\"refresh\": \"\"");
    } finally {
      await harness.cleanup();
    }
  });

  it("removes disconnected managed auth files from future runtime syncs", async () => {
    const harness = await createTestAppHarness();
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "bb-runtime-material-disconnect-"),
    );
    const homeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "bb-runtime-material-home-"),
    );

    try {
      await seedSandboxCredential({
        credential: {
          accessToken: "codex-access-token",
          accountId: "acct_codex_test",
          expiresAt: 1_900_000_100_000,
          idToken: "codex-id-token",
          providerId: "codex",
          refreshToken: "codex-refresh-token",
        },
        harness,
        lastRefreshedAt: 1_800_000_100_000,
        updatedAt: 1_800_000_100_100,
      });

      const initialSnapshot = await buildSandboxRuntimeMaterialSnapshot(harness.deps);
      const homedirMock = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
      try {
        await replaceManagedRuntimeFiles({
          nextSnapshot: initialSnapshot,
          previousState: null,
        });
        await expect(
          fs.readFile(path.join(homeDir, ".codex", "auth.json"), "utf8"),
        ).resolves.toContain("\"access_token\": \"codex-access-token\"");

        await harness.deps.cloudAuth.disconnectProvider({
          providerId: "codex",
        });

        const nextSnapshot = await buildSandboxRuntimeMaterialSnapshot(harness.deps);
        expect(nextSnapshot.files).toEqual([]);

        await replaceManagedRuntimeFiles({
          nextSnapshot,
          previousState: buildHostRuntimeMaterialState(initialSnapshot),
        });
      } finally {
        homedirMock.mockRestore();
      }

      await expect(
        fs.readFile(path.join(homeDir, ".codex", "auth.json"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(dataDir, { force: true, recursive: true });
      await fs.rm(homeDir, { force: true, recursive: true });
      await harness.cleanup();
    }
  });
});
