import { setTimeout as sleep } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import {
  createThreadProvisioningId,
  createEnvironment,
  events,
  getEnvironment,
  getHost,
  getHostOperation,
  getLatestThreadSequence,
  getThread,
  hostDaemonCommands,
  hostDaemonSessions,
  listEvents,
  markHostSuspended,
  markThreadDeleted,
  markThreadStopRequested,
  openSession,
  queueCommand,
  threads,
  upsertHost,
} from "@bb/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonCommandSchema,
  hostDaemonCommandResultResponseSchema,
  hostDaemonSessionOpenResponseSchema,
  hostRuntimeMaterialSnapshotSchema,
} from "@bb/host-daemon-contract";
import {
  type ProvisioningTranscriptEntry,
  systemThreadProvisioningEventDataSchema,
  threadScope,
  threadSchema,
  turnScope,
} from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import { appendClientTurnEvent } from "../../src/services/threads/thread-events.js";
import {
  finalizeStoppedThread,
  interruptActiveThreads,
  interruptActiveTurnForThread,
  requestThreadStart,
} from "../../src/services/threads/thread-lifecycle.js";
import {
  recordThreadProvisionWorkspaceReady,
  requestThreadProvision,
  requestThreadReprovision,
} from "../../src/services/threads/thread-provisioning.js";
import { ensureSandboxHostSessionReady } from "../../src/services/hosts/host-lifecycle.js";
import {
  advanceSandboxRuntimeMaterialSync,
  requestSandboxRuntimeMaterialSync,
} from "../../src/services/hosts/sandbox-runtime-material.js";
import { completeSandboxRuntimeMaterialSyncForCommand } from "../../src/services/hosts/sandbox-runtime-material-operation.js";
import { buildSandboxRuntimeMaterialSnapshot } from "../../src/services/hosts/sandbox-runtime-material-snapshot.js";
import {
  internalAuthHeaders,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  queueEnvironmentDestroyLifecycleCommand,
  queueEnvironmentProvisionLifecycleCommand,
  queueThreadStopLifecycleCommand,
} from "../helpers/lifecycle-commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("internal session routes", () => {
  it("opens sessions, replaces existing ones, and returns thread high-water marks", async () => {
    const harness = await createTestAppHarness();
    try {
      const existing = seedHostSession(harness.deps, {
        id: "host-open",
        name: "Original Host",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: existing.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: existing.host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-open",
        scope: turnScope("turn-1"),
        sequence: 4,
        type: "turn/started",
        data: {},
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: existing.host.id,
          instanceId: "instance-2",
          hostName: "Reconnected Host",
          hostType: "persistent",
          dataDir: "/tmp/host-open-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      const body = hostDaemonSessionOpenResponseSchema.parse(
        await readJson(response),
      );
      expect(body).toMatchObject({
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
        trackedThreadTargets: [
          {
            environmentId: environment.id,
            threadId: thread.id,
          },
        ],
        threadHighWaterMarks: {
          [thread.id]: 6,
        },
      });
      const replaced = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, existing.session.id))
        .get();
      expect(replaced?.status).toBe("closed");
      expect(replaced?.closeReason).toBe("replaced");
      const current = harness.db
        .select()
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.id, body.sessionId))
        .get();
      expect(current?.dataDir).toBe("/tmp/host-open-data");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects old host daemon protocol versions during session open", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: "host-1",
          instanceId: "instance-old-protocol",
          hostName: "Old Protocol Host",
          hostType: "persistent",
          dataDir: "/tmp/old-protocol",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(
        harness.db.select().from(hostDaemonSessions).all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns session-open responses before runtime material sync finishes on resumed sandboxes", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-session-open-resume",
        name: "Session Resume Host",
        provider: "e2b",
        type: "ephemeral",
      });
      harness.deps.sandboxRegistry.set(host.id, {
        destroy: async () => undefined,
        extendTimeout: async () => undefined,
        externalId: "sandbox-session-open-resume",
        hostId: host.id,
        resume: async () => undefined,
        suspend: async () => undefined,
      });
      markHostSuspended(harness.db, {
        hostId: host.id,
        suspendedAt: 1_000,
      });

      let readyResolved = false;
      const readyPromise = ensureSandboxHostSessionReady(harness.deps, {
        hostId: host.id,
      }).then(() => {
        readyResolved = true;
      });

      await Promise.resolve();

      const responsePromise = harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: "ephemeral",
        }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-session-open-resume",
          hostName: host.name,
          hostType: "ephemeral",
          dataDir: "/tmp/session-open-resume",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      const queuedRuntimeSync = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === host.id &&
          command.type === "host.sync_runtime_material",
      );
      const response = await Promise.race([
        responsePromise,
        sleep(500).then(() => null),
      ]);
      expect(response).not.toBeNull();
      if (!response) {
        throw new Error(
          "Expected session.open to return before runtime sync completed",
        );
      }
      expect(response.status).toBe(201);
      expect(readyResolved).toBe(false);

      const body = hostDaemonSessionOpenResponseSchema.parse(
        await readJson(response),
      );
      expect(queuedRuntimeSync.row.sessionId).toBe(body.sessionId);

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

      await readyPromise;
      expect(readyResolved).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("fetches pending commands, marks them fetched, and long-polls to 204", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-commands",
        name: "Command Host",
        type: "ephemeral",
      });
      const session = openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-host-commands",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        dataDir: "/tmp/bb-test-data",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "thread.stop",
        payload: JSON.stringify({
          type: "thread.stop",
          environmentId: environment.id,
          threadId: thread.id,
        }),
      });

      const fetchResponse = await harness.app.request(
        `/internal/session/commands?sessionId=${session.id}&limit=10&waitMs=0`,
        {
          headers: internalAuthHeaders(harness, { hostId: host.id }),
        },
      );
      expect(fetchResponse.status).toBe(200);
      await expect(readJson(fetchResponse)).resolves.toEqual({
        commands: [
          expect.objectContaining({
            id: command.id,
            cursor: command.cursor,
            command: {
              type: "thread.stop",
              environmentId: environment.id,
              threadId: thread.id,
            },
          }),
        ],
      });
      const fetched = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.id, command.id))
        .get();
      expect(fetched?.state).toBe("fetched");
      const fetchedActivityAt = getHost(harness.db, host.id)?.lastActivityAt;
      expect(fetchedActivityAt).toEqual(expect.any(Number));

      const timeoutResponse = await harness.app.request(
        `/internal/session/commands?sessionId=${session.id}&limit=100&waitMs=1`,
        {
          headers: internalAuthHeaders(harness, { hostId: host.id }),
        },
      );
      expect(timeoutResponse.status).toBe(204);
      expect(getHost(harness.db, host.id)?.lastActivityAt).toBe(
        fetchedActivityAt,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("marks ephemeral hosts active when they report command results", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-command-result-activity",
        name: "Command Result Host",
        type: "ephemeral",
      });
      const session = openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-command-result-activity",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        dataDir: "/tmp/bb-test-data",
      });
      const command = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "host.list_files",
        payload: JSON.stringify({
          type: "host.list_files",
          path: "/tmp",
          limit: 10,
        }),
      });

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness, {
            hostId: host.id,
            hostType: "ephemeral",
          }),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: command.id,
            completedAt: Date.now(),
            type: "host.list_files",
            ok: true,
            result: {
              files: [],
              truncated: false,
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(getHost(harness.db, host.id)?.lastActivityAt).toEqual(
        expect.any(Number),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("returns thread high-water marks after thread.start results", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-start-high-water",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environmentPath = "/tmp/thread-start-high-water";
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: environmentPath,
        status: "ready",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });

      const eventSequence = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "start with high-water response" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
        target: { kind: "thread-start" },
      });

      await requestThreadStart(harness.deps, {
        thread,
        environment: {
          id: environment.id,
          hostId: environment.hostId,
          path: environmentPath,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
        eventSequence,
        input: [{ type: "text", text: "start with high-water response" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          source: "client/turn/requested",
        },
        permissionEscalation: "deny",
        projectId: project.id,
        providerId: "codex",
      });

      const threadStartCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      const sequenceBeforeResult = getLatestThreadSequence(harness.db, {
        threadId: thread.id,
      });

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: threadStartCommand.row.sessionId,
            commandId: threadStartCommand.row.id,
            completedAt: Date.now(),
            type: "thread.start",
            ok: true,
            result: {
              providerThreadId: "provider-thread-start-high-water",
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = hostDaemonCommandResultResponseSchema.parse(
        await readJson(response),
      );
      const sequenceAfterResult = getLatestThreadSequence(harness.db, {
        threadId: thread.id,
      });

      expect(sequenceAfterResult).toBe(sequenceBeforeResult);
      expect(body.threadHighWaterMarks).toMatchObject({
        [thread.id]: sequenceAfterResult,
      });
      const provisioningEvents = harness.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all()
        .map((row) =>
          systemThreadProvisioningEventDataSchema.parse(JSON.parse(row.data)),
        );
      expect(provisioningEvents).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not drop reuser daemon events after provision side effects advance reuser sequence", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-provision-shared-high-water",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/provision-shared-high-water",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/provision-shared-high-water",
        status: "provisioning",
      });
      const initiator = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const reuser = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedEvent(harness.deps, {
        threadId: initiator.id,
        environmentId: environment.id,
        providerThreadId: "provider-initiator-before-provision",
        sequence: 6,
        type: "thread/identity",
        scope: threadScope(),
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: reuser.id,
        environmentId: environment.id,
        providerThreadId: "provider-reuser-before-provision",
        sequence: 3,
        type: "thread/identity",
        scope: threadScope(),
        data: {},
      });

      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: {
            threadId: initiator.id,
            provisioningId: "tpv-session-shared-high-water",
            eventSequence: 6,
          },
          workspaceProvisionType: "unmanaged",
          path: "/tmp/provision-shared-high-water",
        },
      });

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: command.id,
            completedAt: Date.now(),
            type: "environment.provision",
            ok: true,
            result: {
              path: "/tmp/provision-shared-high-water",
              branchName: "bb/shared-high-water",
              defaultBranch: "main",
              isGitRepo: true,
              isWorktree: false,
              transcript: [],
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = hostDaemonCommandResultResponseSchema.parse(
        await readJson(response),
      );
      const initiatorSequenceAfterResult = getLatestThreadSequence(harness.db, {
        threadId: initiator.id,
      });
      const reuserSequenceAfterResult = getLatestThreadSequence(harness.db, {
        threadId: reuser.id,
      });
      const reuserProvisioningEvents = harness.db
        .select({ sequence: events.sequence })
        .from(events)
        .where(
          and(
            eq(events.threadId, reuser.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all();

      expect(reuserProvisioningEvents).toHaveLength(1);
      expect(reuserSequenceAfterResult).toBeGreaterThan(3);
      expect(initiatorSequenceAfterResult).toBeGreaterThan(6);
      expect(body.threadHighWaterMarks).toMatchObject({
        [initiator.id]: initiatorSequenceAfterResult,
        [reuser.id]: reuserSequenceAfterResult,
      });

      const daemonNextReuserSequence = reuserSequenceAfterResult + 1;
      const daemonEventResponse = await harness.app.request(
        "/internal/session/events",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            events: [
              {
                environmentId: environment.id,
                threadId: reuser.id,
                sequence: daemonNextReuserSequence,
                createdAt: Date.now(),
                event: {
                  type: "thread/identity",
                  threadId: reuser.id,
                  providerThreadId: "provider-reuser-after-provision",
                  scope: threadScope(),
                },
              },
            ],
          }),
        },
      );

      expect(daemonEventResponse.status).toBe(200);
      expect(
        harness.db
          .select({ sequence: events.sequence })
          .from(events)
          .where(
            and(
              eq(events.threadId, reuser.id),
              eq(events.type, "thread/identity"),
              eq(events.sequence, daemonNextReuserSequence),
            ),
          )
          .get(),
      ).toMatchObject({
        sequence: daemonNextReuserSequence,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("preserves sandbox host provider metadata when a session reconnects", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-existing",
        id: "host-sandbox-reconnect",
        name: "Sandbox Host",
        provider: "e2b",
        type: "ephemeral",
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: "ephemeral",
        }),
        body: JSON.stringify({
          activeThreads: [],
          dataDir: "/tmp/host-daemon-reconnected",
          hostId: host.id,
          instanceId: "instance-reconnected",
          hostName: "Sandbox Host",
          hostType: "ephemeral",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        }),
      });

      expect(response.status).toBe(201);

      const updatedHost = getHost(harness.db, host.id);
      expect(updatedHost).toMatchObject({
        externalId: "sandbox-existing",
        provider: "e2b",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("interrupts pending interactions owned by a replaced session", async () => {
    const harness = await createTestAppHarness();
    try {
      const existing = seedHostSession(harness.deps, {
        id: "host-replace-interaction-session",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: existing.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: existing.host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const registered =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-replace-interaction-session",
            providerId: "codex",
            providerThreadId: "provider-thread-replace-interaction-session",
            providerRequestId: "request-replace-interaction-session",
            payload: createCommandApprovalPayload({
              itemId: "item-replace-interaction-session",
              reason: "Approve command",
              command: "git push",
              cwd: "/tmp/project",
            }),
          },
          sessionId: existing.session.id,
        });
      if (registered.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${registered.reason}`,
        );
      }

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          activeThreads: [{ threadId: thread.id }],
          dataDir: "/tmp/host-replace-interaction-session-data",
          hostId: existing.host.id,
          instanceId: existing.session.instanceId,
          hostName: "Replacement Session Host",
          hostType: "persistent",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        }),
      });

      expect(response.status).toBe(201);
      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: registered.interaction.id,
        }),
      ).toMatchObject({
        status: "interrupted",
        statusReason:
          "Host daemon session was replaced while awaiting user interaction; retry the thread to continue",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("clears suspended state without requeueing runtime sync when an ephemeral host session reconnects with the current version already applied", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      openAiApiKey: "test-openai-key",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-runtime-reconnect",
        id: "host-runtime-reconnect",
        name: "Sandbox Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const initialSession = openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-before-reconnect",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        dataDir: "/tmp/bb-test-data",
      });
      const initialSnapshot = await requestSandboxRuntimeMaterialSync(
        harness.deps,
        {
          hostId: host.id,
        },
      );
      const initialRuntimeSync = advanceSandboxRuntimeMaterialSync(
        harness.deps,
        {
          hostId: host.id,
        },
      );
      if (!initialRuntimeSync) {
        throw new Error("Expected initial runtime sync command to be queued");
      }
      completeSandboxRuntimeMaterialSyncForCommand(harness.deps, {
        appliedVersion: initialSnapshot.version,
        commandId: initialRuntimeSync,
        completedAt: 1_700_000_000_000,
      });
      markHostSuspended(harness.db, {
        hostId: host.id,
        suspendedAt: 1_700_000_000_000,
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: "ephemeral",
        }),
        body: JSON.stringify({
          activeThreads: [],
          dataDir: "/tmp/host-runtime-reconnect",
          hostId: host.id,
          instanceId: "instance-reconnected",
          hostName: host.name,
          hostType: "ephemeral",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        }),
      });

      expect(response.status).toBe(201);
      expect(getHost(harness.db, host.id)).toMatchObject({
        externalId: "sandbox-runtime-reconnect",
        suspendedAt: null,
      });

      const runtimeSyncOperation = getHostOperation(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      });
      expect(runtimeSyncOperation).toMatchObject({
        commandId: initialRuntimeSync,
        state: "completed",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("requeues a fetched runtime material command when an ephemeral host session reconnects", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-runtime-reconnect-fetched",
        id: "host-runtime-reconnect-fetched",
        name: "Sandbox Host",
        provider: "e2b",
        type: "ephemeral",
      });
      openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-before-reconnect-fetched",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        dataDir: "/tmp/bb-test-data",
      });
      const initialSnapshot = await requestSandboxRuntimeMaterialSync(
        harness.deps,
        {
          hostId: host.id,
        },
      );
      const initialRuntimeSync = advanceSandboxRuntimeMaterialSync(
        harness.deps,
        {
          hostId: host.id,
        },
      );
      if (!initialRuntimeSync) {
        throw new Error("Expected initial runtime sync command to be queued");
      }
      harness.db
        .update(hostDaemonCommands)
        .set({
          fetchedAt: 1_700_000_000_000,
          state: "fetched",
        })
        .where(eq(hostDaemonCommands.id, initialRuntimeSync))
        .run();

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: "ephemeral",
        }),
        body: JSON.stringify({
          activeThreads: [],
          dataDir: "/tmp/host-runtime-reconnect-fetched",
          hostId: host.id,
          instanceId: "instance-reconnected-fetched",
          hostName: host.name,
          hostType: "ephemeral",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        }),
      });

      expect(response.status).toBe(201);

      const requeuedRuntimeSync = await waitForQueuedCommandAfter(
        harness,
        harness.db
          .select({
            cursor: hostDaemonCommands.cursor,
          })
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, initialRuntimeSync))
          .get()?.cursor ?? 0,
        ({ command, row }) =>
          row.hostId === host.id &&
          command.type === "host.sync_runtime_material",
      );
      expect(requeuedRuntimeSync.command).toMatchObject({
        type: "host.sync_runtime_material",
        version: initialSnapshot.version,
      });
      expect(
        getHostOperation(harness.db, {
          hostId: host.id,
          kind: "sync_runtime_material",
        }),
      ).toMatchObject({
        commandId: requeuedRuntimeSync.row.id,
        state: "queued",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("handles provisioning command success and failure", async () => {
    const harness = await createTestAppHarness();
    try {
      const successCompletedAt = 1_700_000_000_000;
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-results",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const successEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/provision-success",
        status: "provisioning",
      });
      const successThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: successEnvironment.id,
        status: "provisioning",
      });
      requestThreadProvision(harness.deps, {
        thread: successThread,
        environmentIntent: {
          type: "reuse",
          environmentId: successEnvironment.id,
        },
        input: [{ type: "text", text: "Start when ready" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          source: "client/turn/requested",
        },
        titleProvided: true,
      });
      const successCommand = queueEnvironmentProvisionLifecycleCommand(
        harness,
        {
          hostId: host.id,
          sessionId: session.id,
          environmentId: successEnvironment.id,
          command: {
            type: "environment.provision",
            environmentId: successEnvironment.id,
            initiator: {
              threadId: successThread.id,
              provisioningId: "tpv-session-success",
              eventSequence: 0,
            },
            workspaceProvisionType: "unmanaged",
            path: "/tmp/provision-success",
          },
        },
      );

      const successResponse = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: successCommand.id,
            completedAt: successCompletedAt,
            type: "environment.provision",
            ok: true,
            result: {
              path: "/tmp/provision-success",
              branchName: "bb/success",
              defaultBranch: "main",
              isGitRepo: true,
              isWorktree: false,
              transcript: [],
            },
          }),
        },
      );
      expect(successResponse.status).toBe(200);
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.id, successCommand.id))
          .get()?.completedAt,
      ).toBe(successCompletedAt);
      expect(getEnvironment(harness.db, successEnvironment.id)?.status).toBe(
        "ready",
      );
      expect(getThread(harness.db, successThread.id)?.status).toBe(
        "provisioning",
      );
      const threadStartCommand = await waitForQueuedCommandAfter(
        harness,
        successCommand.cursor,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === successThread.id,
      );
      expect(threadStartCommand.command).toMatchObject({
        environmentId: successEnvironment.id,
        workspaceContext: {
          workspacePath: "/tmp/provision-success",
          workspaceProvisionType: "unmanaged",
        },
      });

      const failureEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/provision-failure",
        status: "provisioning",
      });
      const failureThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: failureEnvironment.id,
        status: "provisioning",
      });
      const failureCommand = queueEnvironmentProvisionLifecycleCommand(
        harness,
        {
          hostId: host.id,
          sessionId: session.id,
          environmentId: failureEnvironment.id,
          command: {
            type: "environment.provision",
            environmentId: failureEnvironment.id,
            initiator: {
              threadId: failureThread.id,
              provisioningId: "tpv-session-failure",
              eventSequence: 0,
            },
            workspaceProvisionType: "unmanaged",
            path: "/tmp/provision-failure",
          },
        },
      );

      const failureResponse = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: failureCommand.id,
            completedAt: Date.now(),
            type: "environment.provision",
            ok: false,
            errorCode: "provision_failed",
            errorMessage: "git clone failed",
          }),
        },
      );
      expect(failureResponse.status).toBe(200);
      expect(getEnvironment(harness.db, failureEnvironment.id)?.status).toBe(
        "error",
      );
      expect(getThread(harness.db, failureThread.id)?.status).toBe("error");
      const failureEvent = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, failureThread.id))
        .all()
        .find((event) => event.type === "system/error");
      expect(failureEvent).toBeTruthy();
      expect(failureEvent ? JSON.parse(failureEvent.data) : null).toMatchObject(
        {
          code: "thread_provisioning_failed",
          detail: "git clone failed",
        },
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("queues runtime material sync on the first ephemeral session open", async () => {
    const harness = await createTestAppHarness({
      openAiApiKey: "test-openai-key",
    });

    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-first-runtime-sync",
        id: "host-first-runtime-sync",
        name: "First Runtime Sync Host",
        provider: "e2b",
        type: "ephemeral",
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, {
          hostId: host.id,
          hostType: "ephemeral",
        }),
        body: JSON.stringify({
          activeThreads: [],
          dataDir: "/tmp/host-first-runtime-sync",
          hostId: host.id,
          instanceId: "instance-first-runtime-sync",
          hostName: host.name,
          hostType: "ephemeral",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        }),
      });

      expect(response.status).toBe(201);
      const runtimeSyncOperation = getHostOperation(harness.db, {
        hostId: host.id,
        kind: "sync_runtime_material",
      });
      expect(runtimeSyncOperation).toMatchObject({
        state: "queued",
      });

      const queuedRuntimeSync = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === host.id &&
          command.type === "host.sync_runtime_material",
      );
      const desiredSnapshot = await buildSandboxRuntimeMaterialSnapshot(
        harness.deps,
      );
      expect(queuedRuntimeSync.command).toMatchObject({
        type: "host.sync_runtime_material",
        version: desiredSnapshot.version,
      });
      expect(runtimeSyncOperation?.commandId).toBe(queuedRuntimeSync.row.id);
    } finally {
      await harness.cleanup();
    }
  });

  it("serves runtime material only for the current requested version", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });

    try {
      const host = upsertHost(harness.db, harness.hub, {
        externalId: "sandbox-runtime-material-route",
        id: "host-runtime-material-route",
        name: "Runtime Material Route Host",
        provider: "e2b",
        type: "ephemeral",
      });
      const session = openSession(harness.db, harness.hub, {
        heartbeatIntervalMs: 5_000,
        hostId: host.id,
        hostName: host.name,
        hostType: host.type,
        instanceId: "instance-runtime-material-route",
        leaseTimeoutMs: 30_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        dataDir: "/tmp/bb-test-data",
      });
      const desiredSnapshot = await buildSandboxRuntimeMaterialSnapshot(
        harness.deps,
      );

      const response = await harness.app.request(
        `/internal/session/runtime-material?sessionId=${session.id}&version=${desiredSnapshot.version}`,
        {
          headers: internalAuthHeaders(harness, {
            hostId: host.id,
            hostType: "ephemeral",
          }),
        },
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual(
        hostRuntimeMaterialSnapshotSchema.parse(desiredSnapshot),
      );

      const staleResponse = await harness.app.request(
        `/internal/session/runtime-material?sessionId=${session.id}&version=runtime-version-stale`,
        {
          headers: internalAuthHeaders(harness, {
            hostId: host.id,
            hostType: "ephemeral",
          }),
        },
      );
      expect(staleResponse.status).toBe(409);
      await expect(readJson(staleResponse)).resolves.toMatchObject({
        code: "stale_runtime_material_version",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("gives the initiator thread the daemon transcript when non-empty", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-transcript",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/transcript-test",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Start" }],
        target: { kind: "thread-start" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: {
            threadId: thread.id,
            provisioningId: "tpv-session-transcript",
            eventSequence: 0,
          },
          workspaceProvisionType: "managed-worktree",
          targetPath: "/tmp/transcript-test",
          sourcePath: "/tmp/transcript-source",
          branchName: "bb/transcript",
          setupTimeoutMs: 900000,
        },
      });

      const transcriptEntries = [
        {
          type: "step",
          key: "workspace-source",
          text: "Using workspace: /tmp/transcript-source",
          status: "completed",
        },
        {
          type: "output",
          key: "git-worktree-command",
          text: "git worktree add -B bb/transcript /tmp/transcript-test",
        },
        {
          type: "step",
          key: "workspace-target",
          text: "Using workspace: /tmp/transcript-test",
          status: "completed",
        },
        {
          type: "step",
          key: "workspace-branch",
          text: "Using branch: bb/transcript (abc1234)",
          status: "completed",
        },
      ];
      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: command.id,
            cursor: command.cursor,
            completedAt: Date.now(),
            type: "environment.provision",
            ok: true,
            result: {
              path: "/tmp/transcript-test",
              branchName: "bb/transcript",
              defaultBranch: "main",
              isGitRepo: true,
              isWorktree: true,
              transcript: transcriptEntries,
            },
          }),
        },
      );
      expect(response.status).toBe(200);

      const transcriptEvents = harness.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all()
        .map((row) =>
          systemThreadProvisioningEventDataSchema.parse(JSON.parse(row.data)),
        )
        .filter((eventData) =>
          eventData.entries.some(
            (entry) => entry.key === "git-worktree-command",
          ),
        );
      expect(transcriptEvents).toHaveLength(1);
      expect(transcriptEvents[0]?.status).toBe("active");
      expect(transcriptEvents[0]?.entries).toEqual(transcriptEntries);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not replay the initiator daemon transcript when streamed entries already exist", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-streamed-transcript",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        projectId: project.id,
        path: "/tmp/streamed-transcript",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 11,
        type: "system/thread-provisioning",
        scope: threadScope(),
        data: {
          provisioningId: "tpv-1",
          status: "active",
          environmentId: environment.id,
          entries: [
            {
              type: "step",
              key: "git-worktree-started",
              text: "Creating worktree",
              status: "started",
            },
          ],
        },
      });
      const command = queueEnvironmentProvisionLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.provision",
          environmentId: environment.id,
          initiator: {
            threadId: thread.id,
            provisioningId: "tpv-session-streamed",
            eventSequence: 10,
          },
          workspaceProvisionType: "managed-worktree",
          targetPath: "/tmp/streamed-transcript",
          sourcePath: "/tmp/streamed-source",
          branchName: "bb/streamed-transcript",
          setupTimeoutMs: 900000,
        },
      });

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: command.id,
            cursor: command.cursor,
            completedAt: Date.now(),
            type: "environment.provision",
            ok: true,
            result: {
              path: "/tmp/streamed-transcript",
              branchName: "bb/streamed-transcript",
              defaultBranch: "main",
              isGitRepo: true,
              isWorktree: true,
              transcript: [
                {
                  type: "output",
                  key: "git-worktree-command",
                  text: "git worktree add -B bb/streamed-transcript /tmp/streamed-transcript",
                },
              ],
            },
          }),
        },
      );
      expect(response.status).toBe(200);

      const provisioningEvents = harness.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all()
        .map((row) =>
          systemThreadProvisioningEventDataSchema.parse(JSON.parse(row.data)),
        );

      expect(
        provisioningEvents.some((eventData) =>
          eventData.entries.some(
            (entry) => entry.key === "git-worktree-command",
          ),
        ),
      ).toBe(false);
      expect(provisioningEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "active",
            entries: [],
          }),
        ]),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("records workspace ready once for repeated thread provisioning advancement", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-workspace-ready-once",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        managed: true,
        projectId: project.id,
        path: "/tmp/workspace-ready-once",
        status: "provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      requestThreadReprovision(harness.deps, {
        thread,
        environment,
        eventSequence: 0,
        input: [{ type: "text", text: "Resume once" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          source: "client/turn/requested",
        },
        initiator: "user",
        provisioningId: createThreadProvisioningId(),
      });

      const entries: ProvisioningTranscriptEntry[] = [
        {
          type: "step",
          key: "workspace-path",
          text: "Using workspace: /tmp/workspace-ready-once",
          status: "completed",
        },
      ];
      recordThreadProvisionWorkspaceReady(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        entries,
      });
      recordThreadProvisionWorkspaceReady(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        entries,
      });

      const workspaceReadyEvents = harness.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all()
        .map((row) =>
          systemThreadProvisioningEventDataSchema.parse(JSON.parse(row.data)),
        )
        .filter((eventData) =>
          eventData.entries.some((entry) => entry.key === "workspace-path"),
        );
      expect(workspaceReadyEvents).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("restarts reprovisioned threads with thread.start instead of turn.submit", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-reprovision-start",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reprovision-start",
        managed: true,
        status: "provisioning",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-old",
        sequence: 1,
        type: "thread/identity",
        scope: threadScope(),
        data: {},
      });
      requestThreadReprovision(harness.deps, {
        thread,
        environment,
        eventSequence: 0,
        input: [{ type: "text", text: "Resume after reprovision" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          source: "client/turn/requested",
        },
        initiator: "user",
        provisioningId: createThreadProvisioningId(),
      });
      const provisionCommand = queueEnvironmentProvisionLifecycleCommand(
        harness,
        {
          hostId: host.id,
          sessionId: session.id,
          environmentId: environment.id,
          command: {
            type: "environment.provision",
            environmentId: environment.id,
            initiator: {
              threadId: thread.id,
              provisioningId: "tpv-session-direct",
              eventSequence: 0,
            },
            workspaceProvisionType: "managed-worktree",
            targetPath: "/tmp/reprovision-start",
            sourcePath: "/tmp/reprovision-source",
            branchName: "bb/reprovision-start",
            setupTimeoutMs: 900000,
          },
        },
      );

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: provisionCommand.id,
            completedAt: Date.now(),
            type: "environment.provision",
            ok: true,
            result: {
              path: "/tmp/reprovision-start",
              branchName: "bb/reprovision-start",
              defaultBranch: "main",
              isGitRepo: true,
              isWorktree: true,
              transcript: [],
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      const queuedRestart = await waitForQueuedCommandAfter(
        harness,
        provisionCommand.cursor,
        ({ command }) => command.threadId === thread.id,
      );
      if (queuedRestart.command.type !== "thread.start") {
        throw new Error("Expected reprovisioning to queue thread.start");
      }
      const provisioningEvents = harness.db
        .select({ data: events.data, sequence: events.sequence })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all()
        .map((row) => ({
          data: systemThreadProvisioningEventDataSchema.parse(
            JSON.parse(row.data),
          ),
          sequence: row.sequence,
        }));
      const completedProvisioningEvent = provisioningEvents.find(
        (event) => event.data.status === "completed",
      );
      expect(completedProvisioningEvent).toBeDefined();
      expect(queuedRestart.command.eventSequence).toBe(
        completedProvisioningEvent?.sequence,
      );
      const followupCommands = harness.db
        .select({
          cursor: hostDaemonCommands.cursor,
          payload: hostDaemonCommands.payload,
        })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.hostId, host.id))
        .all()
        .filter((row) => row.cursor > provisionCommand.cursor)
        .map((row) => hostDaemonCommandSchema.parse(JSON.parse(row.payload)));
      expect(followupCommands).toEqual([
        expect.objectContaining({
          type: "thread.start",
          threadId: thread.id,
        }),
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("restarts reprovisioned threads from the durable thread provision payload", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-reprovision-malformed",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reprovision-malformed",
        managed: true,
        status: "provisioning",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Valid earlier request" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Malformed latest request" }],
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      requestThreadReprovision(harness.deps, {
        thread,
        environment,
        eventSequence: 0,
        input: [{ type: "text", text: "Durable reprovision payload" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          source: "client/turn/requested",
        },
        initiator: "user",
        provisioningId: createThreadProvisioningId(),
      });
      const provisionCommand = queueEnvironmentProvisionLifecycleCommand(
        harness,
        {
          hostId: host.id,
          sessionId: session.id,
          environmentId: environment.id,
          command: {
            type: "environment.provision",
            environmentId: environment.id,
            initiator: {
              threadId: thread.id,
              provisioningId: "tpv-session-managed",
              eventSequence: 0,
            },
            workspaceProvisionType: "managed-worktree",
            targetPath: "/tmp/reprovision-malformed",
            sourcePath: "/tmp/reprovision-malformed-source",
            branchName: "bb/reprovision-malformed",
            setupTimeoutMs: 900000,
          },
        },
      );

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: provisionCommand.id,
            completedAt: Date.now(),
            type: "environment.provision",
            ok: true,
            result: {
              path: "/tmp/reprovision-malformed",
              branchName: "bb/reprovision-malformed",
              defaultBranch: "main",
              isGitRepo: true,
              isWorktree: true,
              transcript: [],
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      const followupCommands = harness.db
        .select({
          cursor: hostDaemonCommands.cursor,
          payload: hostDaemonCommands.payload,
        })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.hostId, host.id))
        .all()
        .filter((row) => row.cursor > provisionCommand.cursor)
        .map((row) => hostDaemonCommandSchema.parse(JSON.parse(row.payload)))
        .filter((command) => command.type === "thread.start");
      expect(followupCommands).toHaveLength(1);
      expect(followupCommands[0]).toMatchObject({
        threadId: thread.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("only restarts threads that are still provisioning when reprovision completes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-reprovision-filter",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reprovision-filter",
        managed: true,
        status: "provisioning",
        workspaceProvisionType: "managed-worktree",
      });
      const provisioningThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      const idleSibling = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const archivedSibling = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, archivedSibling.id))
        .run();
      const stopRequestedSibling = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      markThreadStopRequested(harness.db, harness.hub, {
        threadId: stopRequestedSibling.id,
      });
      requestThreadReprovision(harness.deps, {
        thread: provisioningThread,
        environment,
        eventSequence: 0,
        input: [{ type: "text", text: "Resume provisioning thread" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          permissionEscalation: null,
          source: "client/turn/requested",
        },
        initiator: "user",
        provisioningId: createThreadProvisioningId(),
      });
      appendClientTurnEvent(harness.deps, {
        threadId: idleSibling.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Do not restart this sibling" }],
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "turn/start",
        source: "tell",
        target: { kind: "new-turn" },
      });
      const provisionCommand = queueEnvironmentProvisionLifecycleCommand(
        harness,
        {
          hostId: host.id,
          sessionId: session.id,
          environmentId: environment.id,
          command: {
            type: "environment.provision",
            environmentId: environment.id,
            initiator: {
              threadId: provisioningThread.id,
              provisioningId: "tpv-session-provisioning-thread",
              eventSequence: 0,
            },
            workspaceProvisionType: "managed-worktree",
            targetPath: "/tmp/reprovision-filter",
            sourcePath: "/tmp/reprovision-filter-source",
            branchName: "bb/reprovision-filter",
            setupTimeoutMs: 900000,
          },
        },
      );

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: provisionCommand.id,
            completedAt: Date.now(),
            type: "environment.provision",
            ok: true,
            result: {
              path: "/tmp/reprovision-filter",
              branchName: "bb/reprovision-filter",
              defaultBranch: "main",
              isGitRepo: true,
              isWorktree: true,
              transcript: [
                {
                  type: "step",
                  key: "workspace-source",
                  text: "Using workspace: /tmp/reprovision-filter-source",
                  status: "completed",
                },
                {
                  type: "output",
                  key: "git-worktree-command",
                  text: "git worktree add -B bb/reprovision-filter /tmp/reprovision-filter",
                },
                {
                  type: "step",
                  key: "workspace-target",
                  text: "Using workspace: /tmp/reprovision-filter",
                  status: "completed",
                },
                {
                  type: "step",
                  key: "workspace-branch",
                  text: "Using branch: bb/reprovision-filter (abc1234)",
                  status: "completed",
                },
              ],
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, provisioningThread.id)?.status).toBe(
        "provisioning",
      );
      expect(getThread(harness.db, idleSibling.id)?.status).toBe("idle");
      expect(getThread(harness.db, archivedSibling.id)?.archivedAt).toBeTypeOf(
        "number",
      );
      expect(
        getThread(harness.db, stopRequestedSibling.id)?.stopRequestedAt,
      ).toBeTypeOf("number");

      // Initiator gets the full daemon transcript because no streamed transcript was already appended.
      const initiatorEvents = harness.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, provisioningThread.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all()
        .map((row) =>
          systemThreadProvisioningEventDataSchema.parse(JSON.parse(row.data)),
        )
        .filter((eventData) =>
          eventData.entries.some(
            (entry) => entry.key === "git-worktree-command",
          ),
        );
      expect(initiatorEvents).toHaveLength(1);
      expect(initiatorEvents[0].entries).toHaveLength(4);
      expect(initiatorEvents[0].entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "git-worktree-command" }),
          expect.objectContaining({
            key: "workspace-branch",
            text: "Using branch: bb/reprovision-filter (abc1234)",
          }),
        ]),
      );
      // Sibling gets its own concise workspace summary, not the initiator's daemon transcript.
      const siblingEvents = harness.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, idleSibling.id),
            eq(events.type, "system/thread-provisioning"),
          ),
        )
        .all()
        .map((row) =>
          systemThreadProvisioningEventDataSchema.parse(JSON.parse(row.data)),
        );
      expect(
        siblingEvents.some((eventData) =>
          eventData.entries.some(
            (entry) => entry.key === "git-worktree-command",
          ),
        ),
      ).toBe(false);
      const siblingWorkspaceEvents = siblingEvents.filter((eventData) =>
        eventData.entries.some((entry) => entry.key === "workspace-path"),
      );
      expect(siblingWorkspaceEvents).toHaveLength(1);
      expect(siblingWorkspaceEvents[0].status).toBe("completed");
      expect(siblingEvents).toHaveLength(1);
      expect(siblingWorkspaceEvents[0].entries).toHaveLength(2);
      expect(siblingWorkspaceEvents[0].entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "workspace-path",
            text: "Using workspace: /tmp/reprovision-filter",
          }),
          expect.objectContaining({
            key: "workspace-branch",
            text: "Using branch: bb/reprovision-filter",
          }),
        ]),
      );

      const queuedStarts = harness.db
        .select({
          cursor: hostDaemonCommands.cursor,
          payload: hostDaemonCommands.payload,
        })
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .all()
        .filter((row) => row.cursor > provisionCommand.cursor)
        .map((row) => hostDaemonCommandSchema.parse(JSON.parse(row.payload)))
        .filter((command) => command.type === "thread.start");

      expect(queuedStarts).toHaveLength(1);
      expect(queuedStarts[0]?.threadId).toBe(provisioningThread.id);
      for (const skippedThread of [archivedSibling, stopRequestedSibling]) {
        const skippedEvents = harness.db
          .select({ data: events.data })
          .from(events)
          .where(
            and(
              eq(events.threadId, skippedThread.id),
              eq(events.type, "system/thread-provisioning"),
            ),
          )
          .all();
        expect(skippedEvents).toHaveLength(0);
        expect(
          queuedStarts.some((command) => command.threadId === skippedThread.id),
        ).toBe(false);
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("reconciles errored and orphaned active threads when a session opens", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const erroredThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "error",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const activeThreadWithoutProviderId = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const activeThreadWithoutTurn = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-active-reconcile",
        scope: turnScope("turn-active-reconcile"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedStoredEvent(harness.deps, {
        threadId: activeThreadWithoutProviderId.id,
        environmentId: environment.id,
        providerThreadId: null,
        scope: turnScope("turn-active-reconcile-no-provider"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-reconcile",
          hostName: "Reconcile Host",
          hostType: "persistent",
          dataDir: "/tmp/host-reconcile-data",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [
            {
              threadId: erroredThread.id,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, erroredThread.id)?.status).toBe("active");
      expect(getThread(harness.db, activeThread.id)?.status).toBe("idle");
      expect(
        getThread(harness.db, activeThreadWithoutProviderId.id)?.status,
      ).toBe("idle");
      expect(getThread(harness.db, activeThreadWithoutTurn.id)?.status).toBe(
        "idle",
      );
      const activeThreadEvents = listEvents(harness.db, {
        threadId: activeThread.id,
      });
      const completedEvent = activeThreadEvents.find(
        (event) => event.type === "turn/completed",
      );
      expect(completedEvent).toMatchObject({
        providerThreadId: "provider-active-reconcile",
        turnId: "turn-active-reconcile",
      });
      expect(JSON.parse(completedEvent?.data ?? "{}")).toEqual({
        providerThreadId: "provider-active-reconcile",
        status: "interrupted",
      });
      const interruptedEvent = activeThreadEvents.find(
        (event) => event.type === "system/thread/interrupted",
      );
      expect(JSON.parse(interruptedEvent?.data ?? "{}")).toEqual({
        reason: "host-daemon-restarted",
      });
      const activeThreadWithoutProviderEvents = listEvents(harness.db, {
        threadId: activeThreadWithoutProviderId.id,
      });
      const completedWithoutProviderEvent =
        activeThreadWithoutProviderEvents.find(
          (event) => event.type === "turn/completed",
        );
      expect(completedWithoutProviderEvent).toMatchObject({
        providerThreadId: null,
        turnId: "turn-active-reconcile-no-provider",
      });
      expect(JSON.parse(completedWithoutProviderEvent?.data ?? "{}")).toEqual({
        providerThreadId: null,
        status: "interrupted",
      });
      const interruptedWithoutProviderEvent =
        activeThreadWithoutProviderEvents.find(
          (event) => event.type === "system/thread/interrupted",
        );
      expect(JSON.parse(interruptedWithoutProviderEvent?.data ?? "{}")).toEqual(
        {
          reason: "host-daemon-restarted",
        },
      );
      const activeThreadWithoutTurnEvents = listEvents(harness.db, {
        threadId: activeThreadWithoutTurn.id,
      });
      expect(
        activeThreadWithoutTurnEvents.some(
          (event) => event.type === "turn/completed",
        ),
      ).toBe(false);
      const interruptedWithoutTurnEvent = activeThreadWithoutTurnEvents.find(
        (event) => event.type === "system/thread/interrupted",
      );
      expect(JSON.parse(interruptedWithoutTurnEvent?.data ?? "{}")).toEqual({
        reason: "host-daemon-restarted",
      });

      const secondResponse = await harness.app.request(
        "/internal/session/open",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            hostId: host.id,
            instanceId: "instance-reconcile-second",
            hostName: "Reconcile Host",
            hostType: "persistent",
            dataDir: "/tmp/host-reconcile-data",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            activeThreads: [
              { threadId: erroredThread.id },
              { threadId: activeThread.id },
              { threadId: activeThreadWithoutProviderId.id },
              { threadId: activeThreadWithoutTurn.id },
            ],
          }),
        },
      );

      expect(secondResponse.status).toBe(201);
      expect(getThread(harness.db, erroredThread.id)?.status).toBe("active");
      expect(getThread(harness.db, activeThread.id)?.status).toBe("idle");
      expect(
        getThread(harness.db, activeThreadWithoutProviderId.id)?.status,
      ).toBe("idle");
      expect(getThread(harness.db, activeThreadWithoutTurn.id)?.status).toBe(
        "idle",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("hard-deletes deleted tombstones and queues cleanup when reconciliation sees the thread is gone", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile-deleted",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/reconcile-deleted",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-reconcile-deleted",
          hostName: "Reconcile Deleted Host",
          hostType: "persistent",
          dataDir: "/tmp/reconcile-deleted",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, thread.id)).toBeNull();
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );

      const destroyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.row.sessionId).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps deleted tombstones retryable when no active session exists", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = upsertHost(harness.db, harness.hub, {
        id: "host-reconcile-deleted-no-session",
        name: "Test Host",
        type: "persistent",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/reconcile-deleted-no-session",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      const finalized = await finalizeStoppedThread(harness.deps, {
        threadId: thread.id,
      });

      expect(finalized).toBe(false);
      expect(getThread(harness.db, thread.id)?.deletedAt).toBeTypeOf("number");
      const queuedDeleteCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.deleted"))
        .all();
      expect(queuedDeleteCommands).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("interrupts pending interactions when a thread stop is finalized", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-finalize-stop-interaction",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      markThreadStopRequested(harness.db, harness.hub, {
        threadId: thread.id,
      });

      const interaction =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-stop-interaction",
            providerId: "codex",
            providerThreadId: "provider-thread-stop-interaction",
            providerRequestId: "request-stop-interaction",
            payload: createCommandApprovalPayload({
              itemId: "item-stop-interaction",
              reason: "Approve command",
              command: "git push",
              cwd: "/tmp/project",
            }),
          },
          sessionId: "session-1",
        });
      if (interaction.outcome === "rejected") {
        throw new Error(
          `Expected interaction registration to succeed: ${interaction.reason}`,
        );
      }

      expect(
        await finalizeStoppedThread(harness.deps, {
          threadId: thread.id,
        }),
      ).toBe(true);

      expect(
        harness.deps.pendingInteractions.getThreadInteraction({
          threadId: thread.id,
          interactionId: interaction.interaction.id,
        }),
      ).toMatchObject({
        status: "interrupted",
        statusReason: "Thread stopped by user request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("finalizes an active stopped turn without a provider thread id", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-finalize-stop-no-provider",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: null,
        scope: turnScope("turn-finalize-stop-no-provider"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });

      expect(
        await finalizeStoppedThread(harness.deps, {
          threadId: thread.id,
        }),
      ).toBe(true);

      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      const threadEvents = listEvents(harness.db, { threadId: thread.id });
      const completedEvent = threadEvents.find(
        (event) => event.type === "turn/completed",
      );
      expect(completedEvent).toMatchObject({
        providerThreadId: null,
        turnId: "turn-finalize-stop-no-provider",
      });
      expect(JSON.parse(completedEvent?.data ?? "{}")).toEqual({
        providerThreadId: null,
        status: "interrupted",
      });
      const interruptedEvent = threadEvents.find(
        (event) => event.type === "system/thread/interrupted",
      );
      expect(JSON.parse(interruptedEvent?.data ?? "{}")).toEqual({
        reason: "manual-stop",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not append interrupted turn events when status transition fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-interrupt-transition-fails",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-interrupt-transition-fails",
        scope: turnScope("turn-interrupt-transition-fails"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });

      expect(() =>
        interruptActiveTurnForThread(harness.deps, {
          environmentId: environment.id,
          threadId: thread.id,
          reason: "host-daemon-restarted",
        }),
      ).toThrow("Invalid thread status transition");

      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      const threadEvents = listEvents(harness.db, { threadId: thread.id });
      expect(threadEvents.map((event) => event.type)).toEqual(["turn/started"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not append batched interrupted events when any status transition fails", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-batch-interrupt-transition-fails",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const idleThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-batch-transition-active",
        scope: turnScope("turn-batch-transition-active"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: idleThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-batch-transition-idle",
        scope: turnScope("turn-batch-transition-idle"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });

      expect(() =>
        interruptActiveThreads(harness.deps, {
          threads: [
            {
              environmentId: environment.id,
              threadId: activeThread.id,
            },
            {
              environmentId: environment.id,
              threadId: idleThread.id,
            },
          ],
          reason: "host-daemon-restarted",
        }),
      ).toThrow("Invalid thread status transition");

      expect(getThread(harness.db, activeThread.id)?.status).toBe("active");
      expect(getThread(harness.db, idleThread.id)?.status).toBe("idle");
      expect(
        listEvents(harness.db, { threadId: activeThread.id }).map(
          (event) => event.type,
        ),
      ).toEqual(["turn/started"]);
      expect(
        listEvents(harness.db, { threadId: idleThread.id }).map(
          (event) => event.type,
        ),
      ).toEqual(["turn/started"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("hard-deletes deleted provisioning tombstones on reconnect", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile-deleted-provisioning",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: false,
        status: "provisioning",
        workspaceProvisionType: "unmanaged",
        path: "/tmp/reconcile-deleted-provisioning",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-reconcile-deleted-provisioning",
          hostName: "Reconcile Deleted Provisioning Host",
          hostType: "persistent",
          dataDir: "/tmp/reconcile-deleted-provisioning",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, thread.id)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("re-queues stop for stop-pending threads that are still active on reconnect", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile-stop-pending",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      markThreadStopRequested(harness.db, harness.hub, {
        threadId: thread.id,
        requestedAt: 123,
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-reconcile-stop-pending",
          hostName: "Reconcile Stop Pending Host",
          hostType: "persistent",
          dataDir: "/tmp/reconcile-stop-pending",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [{ threadId: thread.id }],
        }),
      });

      expect(response.status).toBe(201);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stopCommand.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("resumes forced archived cleanup after reconciliation clears a lost stop result", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile-archived-force-cleanup",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/reconcile-archived-force-cleanup",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const archiveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            force: true,
            managerChildThreadsConfirmed: false,
          }),
        },
      );

      expect(archiveResponse.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        cleanupMode: "force",
        cleanupRequestedAt: expect.any(Number),
        status: "ready",
      });

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );

      const reconnectResponse = await harness.app.request(
        "/internal/session/open",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            activeThreads: [],
            dataDir: "/tmp/reconcile-archived-force-cleanup",
            hostId: host.id,
            hostName: "Reconcile Archived Force Cleanup Host",
            hostType: "persistent",
            instanceId: "instance-reconcile-archived-force-cleanup",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          }),
        },
      );

      expect(reconnectResponse.status).toBe(201);
      expect(getThread(harness.db, thread.id)?.stopRequestedAt).toBeNull();

      const destroyCommand = await waitForQueuedCommandAfter(
        harness,
        stopCommand.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );

      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("requests stop for deleted tombstones that are still active on reconnect", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile-deleted-active",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-reconcile-deleted-active",
          hostName: "Reconcile Deleted Active Host",
          hostType: "persistent",
          dataDir: "/tmp/reconcile-deleted-active",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [{ threadId: thread.id }],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, thread.id)?.deletedAt).toBeTypeOf("number");
      expect(getThread(harness.db, thread.id)?.stopRequestedAt).toBeTypeOf(
        "number",
      );

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stopCommand.command).toMatchObject({
        environmentId: environment.id,
        threadId: thread.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not hard-delete deleted tombstones while thread.start is still active on reconnect", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reconcile-created-start-pending",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/reconcile-created-start-pending",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reconcile-created-start-pending",
      });

      const createResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Create then reconnect-delete me" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(createResponse.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(createResponse));
      expect(createdThread.status).toBe("provisioning");

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );

      const deleteResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}`,
        {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ managerChildThreadsConfirmed: false }),
        },
      );

      expect(deleteResponse.status).toBe(200);

      const queuedStop = await waitForQueuedCommandAfter(
        harness,
        queuedStart.row.cursor,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStop.command).toMatchObject({
        environmentId: environment.id,
        threadId: createdThread.id,
      });

      const reconnectResponse = await harness.app.request(
        "/internal/session/open",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            hostId: host.id,
            instanceId: "instance-reconcile-created-start-pending",
            hostName: "Reconcile Created Start Pending Host",
            hostType: "persistent",
            dataDir: "/tmp/reconcile-created-start-pending",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            activeThreads: [],
          }),
        },
      );

      expect(reconnectResponse.status).toBe(201);
      expect(getThread(harness.db, createdThread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        stopRequestedAt: expect.any(Number),
        status: "provisioning",
      });
      expect(
        harness.db
          .select({ id: hostDaemonCommands.id })
          .from(hostDaemonCommands)
          .where(eq(hostDaemonCommands.type, "environment.destroy"))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("hard-deletes deleted stop-pending threads and queues cleanup on successful stop results", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-stop-finalize-delete",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/stop-finalize-delete",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
      markThreadStopRequested(harness.db, harness.hub, {
        threadId: thread.id,
        requestedAt: 123,
      });
      const stopCommand = queueThreadStopLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        threadId: thread.id,
        command: {
          type: "thread.stop",
          environmentId: environment.id,
          threadId: thread.id,
        },
      });

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: stopCommand.id,
            completedAt: Date.now(),
            type: "thread.stop",
            ok: true,
            result: {},
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)).toBeNull();

      const destroyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.row.cursor).toBeGreaterThan(stopCommand.cursor);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroying",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("marks environments destroyed after a successful destroy result", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-destroy-result",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/destroy-result-environment",
        managed: true,
        status: "destroying",
      });
      const destroyCommand = queueEnvironmentDestroyLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.destroy",
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "managed-worktree",
          },
        },
      });

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: destroyCommand.id,
            completedAt: Date.now(),
            type: "environment.destroy",
            ok: true,
            result: {},
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroyed",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("does not revive deleted provisioning threads after provision succeeds", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-provision-deleted-thread",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = createEnvironment(harness.db, harness.hub, {
        hostId: host.id,
        projectId: project.id,
        managed: false,
        path: null,
        status: "provisioning",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "provisioning",
      });
      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
      appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: [{ type: "text", text: "Provision then delete" }],
        target: { kind: "thread-start" },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "client/turn/requested",
        },
        initiator: "user",
        requestMethod: "thread/start",
        source: "spawn",
      });
      const provisionCommand = queueEnvironmentProvisionLifecycleCommand(
        harness,
        {
          hostId: host.id,
          sessionId: session.id,
          environmentId: environment.id,
          command: {
            type: "environment.provision",
            environmentId: environment.id,
            workspaceProvisionType: "unmanaged",
            path: "/tmp/target",
            initiator: null,
          },
        },
      );

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: provisionCommand.id,
            completedAt: Date.now(),
            type: "environment.provision",
            ok: true,
            result: {
              path: "/tmp/target",
              isGitRepo: true,
              isWorktree: false,
              branchName: "bb/provision-deleted",
              defaultBranch: "main",
              transcript: [],
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)).toBeNull();
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("ready");
      const queuedStarts = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "thread.start"))
        .all();
      expect(queuedStarts).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("destroys ephemeral sandbox hosts after a successful environment destroy result", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-ephemeral-destroy-result",
        type: "ephemeral",
      });
      const cachedHost = {
        destroy: vi.fn().mockResolvedValue(undefined),
        extendTimeout: vi.fn().mockResolvedValue(undefined),
        externalId: "sandbox-ephemeral-destroy-result",
        hostId: host.id,
        resume: vi.fn().mockResolvedValue(undefined),
        suspend: vi.fn().mockResolvedValue(undefined),
      };
      upsertHost(harness.db, harness.hub, {
        externalId: cachedHost.externalId,
        id: host.id,
        name: host.name,
        provider: "e2b",
        type: "ephemeral",
      });
      harness.deps.sandboxRegistry.set(host.id, cachedHost);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/ephemeral-destroy-result-environment",
        managed: true,
        status: "destroying",
      });
      const destroyCommand = queueEnvironmentDestroyLifecycleCommand(harness, {
        hostId: host.id,
        sessionId: session.id,
        environmentId: environment.id,
        command: {
          type: "environment.destroy",
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "managed-worktree",
          },
        },
      });

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: destroyCommand.id,
            completedAt: Date.now(),
            type: "environment.destroy",
            ok: true,
            result: {},
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(cachedHost.destroy).toHaveBeenCalledTimes(1);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "destroyed",
      );
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: expect.any(Number),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores stale destroy results after reprovision has already started", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-stale-destroy",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/stale-destroy",
        managed: true,
        status: "provisioning",
      });
      const destroyCommand = queueCommand(harness.db, harness.hub, {
        hostId: host.id,
        sessionId: session.id,
        type: "environment.destroy",
        payload: JSON.stringify({
          type: "environment.destroy",
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: "managed-worktree",
          },
        }),
      });

      const response = await harness.app.request(
        "/internal/session/command-result",
        {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            commandId: destroyCommand.id,
            completedAt: Date.now(),
            type: "environment.destroy",
            ok: true,
            result: {},
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe(
        "provisioning",
      );
    } finally {
      await harness.cleanup();
    }
  });
});
