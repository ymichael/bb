import {
  getCommand,
  getHostOperation,
  hostDaemonSessions,
  openSession,
  upsertSandboxProviderCredential,
  upsertHost,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { TestAppHarness } from "../helpers/test-app.js";
import { createCloudAuthCrypto } from "../../src/services/cloud-auth/crypto.js";
import {
  ensureSandboxRuntimeMaterialSynced,
  requestSandboxRuntimeMaterialSync,
  advanceSandboxRuntimeMaterialSync,
} from "../../src/services/hosts/sandbox-runtime-material.js";
import type {
  ClaudeStoredCredential,
  CodexStoredCredential,
  StoredCloudAuthCredential,
} from "../../src/services/cloud-auth/provider-definitions.js";
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
  upsertSandboxProviderCredential(args.harness.db, {
    encryptedPayload: crypto.encryptJson({
      plaintext: JSON.stringify(args.credential),
    }),
    expiresAt: args.credential.expiresAt,
    label: null,
    lastErrorMessage: null,
    lastRefreshedAt: args.lastRefreshedAt,
    providerId: args.credential.providerId,
    updatedAt: args.updatedAt,
  });
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

  it("builds managed auth files for claude, codex, and pi without refresh tokens", async () => {
    const harness = await createTestAppHarness();
    const claudeCredential: ClaudeStoredCredential = {
      accessToken: "claude-access-token",
      accountEmail: "claude@example.test",
      accountId: "acct_claude_test",
      expiresAt: 1_800_000_000_000,
      providerId: "claude-code",
      refreshToken: "claude-refresh-token",
      scopes: ["user:profile", "user:sessions:claude_code"],
      subscriptionType: "max",
    };
    const codexCredential: CodexStoredCredential = {
      accessToken: "codex-access-token",
      accountId: "acct_codex_test",
      expiresAt: 1_800_000_000_500,
      idToken: "codex-id-token",
      providerId: "codex",
      refreshToken: "codex-refresh-token",
    };

    try {
      await seedSandboxCredential({
        credential: claudeCredential,
        harness,
        lastRefreshedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      });
      await seedSandboxCredential({
        credential: codexCredential,
        harness,
        lastRefreshedAt: 1_700_000_100_000,
        updatedAt: 1_700_000_100_000,
      });

      const snapshot = await buildSandboxRuntimeMaterialSnapshot(harness.deps);

      expect(snapshot.env).toEqual({
        OPENAI_API_KEY: "test-openai-key",
        PI_CODING_AGENT_DIR: "~/.pi/agent",
      });
      expect(snapshot.files).toHaveLength(3);

      const codexFile = snapshot.files.find((file) => file.path === "~/.codex/auth.json");
      expect(codexFile).toMatchObject({
        managedBy: "bb-runtime-material",
        mode: 0o600,
      });
      expect(codexFile?.contents).toContain("\"refresh_token\": \"\"");
      expect(codexFile?.contents).toContain("\"access_token\": \"codex-access-token\"");
      expect(codexFile?.contents).toContain("\"account_id\": \"acct_codex_test\"");
      expect(codexFile?.contents).toContain("\"id_token\": \"codex-id-token\"");

      const claudeFile = snapshot.files.find(
        (file) => file.path === "~/.claude/.credentials.json",
      );
      expect(claudeFile).toMatchObject({
        managedBy: "bb-runtime-material",
        mode: 0o600,
      });
      expect(claudeFile?.contents).toContain("\"refreshToken\": \"\"");
      expect(claudeFile?.contents).toContain("\"accessToken\": \"claude-access-token\"");
      expect(claudeFile?.contents).toContain("\"subscriptionType\": \"max\"");

      const piFile = snapshot.files.find((file) => file.path === "~/.pi/agent/auth.json");
      expect(piFile).toMatchObject({
        managedBy: "bb-runtime-material",
        mode: 0o600,
      });
      expect(piFile?.contents).toContain("\"anthropic\"");
      expect(piFile?.contents).toContain("\"openai-codex\"");
      expect(piFile?.contents).toContain("\"refresh\": \"\"");
      expect(piFile?.contents).toContain("\"accountId\": \"acct_codex_test\"");
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
});
