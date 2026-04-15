import {
  provisionHostMock,
  resumeHostMock,
  type SandboxProvisionCall,
} from "./public-thread-test-harness.js";

import {
  createProject,
  createProjectSource,
  events,
  getEnvironment,
  getHost,
  openSession,
  listHosts,
  getThread,
  hostDaemonCommands,
  threads,
} from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import {
  systemThreadProvisioningEventDataSchema,
  threadSchema,
} from "@bb/domain";
import {
  reportNextRuntimeMaterialSyncSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { runEphemeralHostCleanupSweep } from "../../src/services/system/periodic-sweeps.js";
import { destroyHost } from "../../src/services/hosts/host-lifecycle.js";
import {
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import {
  waitForAssertion,
  waitForThreadEnvironment,
} from "./public-thread-assertions.js";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";

describe("public thread sandbox-host routes", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });


  it("rejects sandbox thread creation when BB_EXTERNAL_URL is not https", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      externalUrl: "http://bb.example.test",
    });
    try {
      const { project } = createProject(harness.db, harness.hub, {
        name: "Insecure Public URL Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Start a sandbox thread" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Sandbox provisioning requires BB_EXTERNAL_URL to use https",
      });
      expect(provisionHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });


  it("rejects sandbox-host threads for local-path project sources", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/cloud-source",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Use the sandbox host" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "unsupported_operation",
        message:
          "Sandbox threads require a cloneable project source; local path sources are not supported yet",
      });
      expect(provisionHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });


  it("creates sandbox-host threads when a non-default cloneable project source exists", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      provisionHostMock.mockImplementation(async (options: SandboxProvisionCall) => {
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 10_000,
          hostId: options.hostId,
          hostName: options.hostName,
          hostType: "ephemeral",
          instanceId: "instance-sandbox-secondary-source",
          leaseTimeoutMs: 60_000,
          protocolVersion: 2,
          dataDir: "/tmp/bb-test-data",
        });
        return {
          destroy: vi.fn().mockResolvedValue(undefined),
          extendTimeout: vi.fn().mockResolvedValue(undefined),
          externalId: "sandbox-external-secondary-source",
          hostId: options.hostId,
          resume: vi.fn().mockResolvedValue(undefined),
          suspend: vi.fn().mockResolvedValue(undefined),
        };
      });

      const { host } = seedHostSession(harness.deps);
      const { project } = createProject(harness.db, harness.hub, {
        name: "Sandbox Secondary Source Project",
        source: {
          hostId: host.id,
          path: "/tmp/sandbox-secondary-default",
          type: "local_path",
        },
      });
      createProjectSource(harness.db, harness.hub, {
        isDefault: false,
        projectId: project.id,
        repoUrl: "https://github.com/example/secondary.git",
        type: "github_repo",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision from the cloneable source" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const sandboxEnvironment = await waitForThreadEnvironment(
        harness,
        createdThread.id,
      );
      await reportNextRuntimeMaterialSyncSuccess(harness, {
        hostId: sandboxEnvironment.hostId,
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      expect(queued.command).toMatchObject({
        branchName: `bb/${createdThread.id}`,
        environmentId: sandboxEnvironment.id,
        sourcePath: "https://github.com/example/secondary.git",
        targetPath: `/tmp/bb-data/worktrees/${sandboxEnvironment.id}/secondary`,
        workspaceProvisionType: "managed-clone",
      });
    } finally {
      await harness.cleanup();
    }
  });


  it("creates sandbox-host threads for cloneable project sources", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      const sandboxLifecycle = {
        destroy: vi.fn().mockResolvedValue(undefined),
        extendTimeout: vi.fn().mockResolvedValue(undefined),
        externalId: "sandbox-external-123",
        hostId: "host_sandbox_new",
        resume: vi.fn().mockResolvedValue(undefined),
        suspend: vi.fn().mockResolvedValue(undefined),
      };
      provisionHostMock.mockImplementation(async (options: SandboxProvisionCall) => {
        options.progressCallbacks?.onProgress?.({
          stage: "host",
          status: "started",
        });
        options.progressCallbacks?.onSandboxCreated?.({
          externalId: "sandbox-external-123",
        });
        options.progressCallbacks?.onProgress?.({
          externalId: "sandbox-external-123",
          stage: "host",
          status: "completed",
        });
        options.progressCallbacks?.onProgress?.({
          externalId: "sandbox-external-123",
          stage: "daemon-start",
          status: "started",
        });
        options.progressCallbacks?.onProgress?.({
          externalId: "sandbox-external-123",
          stage: "daemon-start",
          status: "completed",
        });
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 10_000,
          hostId: options.hostId,
          hostName: options.hostName,
          hostType: "ephemeral",
          instanceId: "instance-sandbox-test",
          leaseTimeoutMs: 60_000,
          protocolVersion: 2,
          dataDir: "/tmp/bb-test-data",
        });
        return {
          ...sandboxLifecycle,
          hostId: options.hostId,
        };
      });

      const { host } = seedHostSession(harness.deps);
      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision a sandbox thread" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");
      await waitForAssertion(() => {
        expect(provisionHostMock).toHaveBeenCalledWith(expect.objectContaining({
          apiKey: "test-e2b-api-key",
          daemonEnv: expect.objectContaining({
            GITHUB_TOKEN: "test-github-pat",
          }),
          enrollKey: expect.stringMatching(/^bbde_/u),
          hostId: expect.stringMatching(/^host_/u),
          hostName: expect.stringMatching(/^sandbox-/u),
          progressCallbacks: expect.any(Object),
          serverUrl: "https://bb.example.test",
          template: "test-e2b-template",
        }));
      });

      const environment = await waitForThreadEnvironment(harness, createdThread.id);
      expect(environment).toMatchObject({
        hostId: expect.stringMatching(/^host_/u),
        managed: true,
        projectId: project.id,
        status: "provisioning",
        workspaceProvisionType: "managed-clone",
      });

      const sandboxHost = getHost(harness.db, environment.hostId);
      if (!sandboxHost) {
        throw new Error("Expected sandbox host to exist");
      }
      await reportNextRuntimeMaterialSyncSuccess(harness, {
        hostId: sandboxHost.id,
      });
      expect(sandboxHost).toMatchObject({
        externalId: "sandbox-external-123",
        provider: "e2b",
        type: "ephemeral",
      });
      expect(harness.deps.sandboxRegistry.get(environment.hostId)).toMatchObject({
        externalId: "sandbox-external-123",
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      const provisioningEvents = harness.db
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(eq(events.threadId, createdThread.id))
        .all()
        .filter((event) => event.type === "system/thread-provisioning")
        .map((event) => systemThreadProvisioningEventDataSchema.parse(JSON.parse(event.data)));
      expect(
        provisioningEvents.flatMap((event) => event.entries.map((entry) => entry.text)),
      ).toEqual(
        expect.arrayContaining([
          "Preparing sandbox",
          "Sandbox host ready",
          "Starting sandbox daemon",
          "Sandbox daemon ready",
          "Sandbox host connected",
        ]),
      );
      expect(queued.command).toMatchObject({
        branchName: `bb/${createdThread.id}`,
        environmentId: environment.id,
        sourcePath: "https://github.com/example/repo.git",
        targetPath: `/tmp/bb-data/worktrees/${environment.id}/repo`,
        workspaceProvisionType: "managed-clone",
      });
      expect(queued.row.hostId).toBe(environment.hostId);
    } finally {
      await harness.cleanup();
    }
  });


  it("returns sandbox-host threads before the first session arrives", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      let sandboxHostId: string | undefined;
      let sandboxHostName: string | undefined;
      let resolveProvisionHost: ((value: {
        destroy: ReturnType<typeof vi.fn>;
        extendTimeout: ReturnType<typeof vi.fn>;
        externalId: string;
        hostId: string;
        resume: ReturnType<typeof vi.fn>;
        suspend: ReturnType<typeof vi.fn>;
      }) => void) | null = null;
      const provisionHostResult = new Promise<{
        destroy: ReturnType<typeof vi.fn>;
        extendTimeout: ReturnType<typeof vi.fn>;
        externalId: string;
        hostId: string;
        resume: ReturnType<typeof vi.fn>;
        suspend: ReturnType<typeof vi.fn>;
      }>((resolve) => {
        resolveProvisionHost = resolve;
      });
      provisionHostMock.mockImplementation(async (options: SandboxProvisionCall) => {
        sandboxHostId = options.hostId;
        sandboxHostName = options.hostName;
        return provisionHostResult;
      });

      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision a sandbox thread" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });
      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));

      await waitForAssertion(() => {
        if (!sandboxHostId) {
          throw new Error("Expected sandbox host provisioning to start");
        }

        const sandboxHost = getHost(harness.db, sandboxHostId);
        expect(sandboxHost).toMatchObject({ id: sandboxHostId });
        expect(createdThread.status).toBe("provisioning");
      });

      const environment = await waitForThreadEnvironment(harness, createdThread.id);
      await waitForAssertion(() => {
        expect(environment).toMatchObject({
          hostId: sandboxHostId,
          managed: true,
          status: "provisioning",
        });
      });

      await runEphemeralHostCleanupSweep(harness.deps, destroyHost);

      expect(sandboxHostId).toBeDefined();
      expect(getHost(harness.db, sandboxHostId!)).toMatchObject({
        destroyedAt: null,
        externalId: null,
      });

      if (!resolveProvisionHost) {
        throw new Error("Expected sandbox host provisioning to start");
      }
      resolveProvisionHost({
        destroy: vi.fn().mockResolvedValue(undefined),
        extendTimeout: vi.fn().mockResolvedValue(undefined),
        externalId: "sandbox-external-connecting",
        hostId: sandboxHostId!,
        resume: vi.fn().mockResolvedValue(undefined),
        suspend: vi.fn().mockResolvedValue(undefined),
      });

      openSession(harness.db, harness.hub, {
        dataDir: `/tmp/bb-host-data/${sandboxHostId}`,
        heartbeatIntervalMs: 10_000,
        hostId: sandboxHostId!,
        hostName: sandboxHostName ?? "Test Sandbox Host",
        hostType: "ephemeral",
        instanceId: "instance-sandbox-connecting",
        leaseTimeoutMs: 60_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      });
      await reportNextRuntimeMaterialSyncSuccess(harness, {
        hostId: sandboxHostId!,
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision"
          && command.environmentId === environment.id,
      );
      expect(queued.row.hostId).toBe(sandboxHostId);
    } finally {
      await harness.cleanup();
    }
  });


  it("allows reusing a provisioning sandbox environment before the first session arrives", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      let sandboxHostId: string | undefined;
      let sandboxHostName: string | undefined;
      let resolveProvisionHost: ((value: {
        destroy: ReturnType<typeof vi.fn>;
        extendTimeout: ReturnType<typeof vi.fn>;
        externalId: string;
        hostId: string;
        resume: ReturnType<typeof vi.fn>;
        suspend: ReturnType<typeof vi.fn>;
      }) => void) | null = null;
      const provisionHostResult = new Promise<{
        destroy: ReturnType<typeof vi.fn>;
        extendTimeout: ReturnType<typeof vi.fn>;
        externalId: string;
        hostId: string;
        resume: ReturnType<typeof vi.fn>;
        suspend: ReturnType<typeof vi.fn>;
      }>((resolve) => {
        resolveProvisionHost = resolve;
      });
      provisionHostMock.mockImplementation(async (options: SandboxProvisionCall) => {
        sandboxHostId = options.hostId;
        sandboxHostName = options.hostName;
        return provisionHostResult;
      });

      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Reuse Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const firstResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision a sandbox thread" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(firstResponse.status).toBe(201);
      const firstThread = threadSchema.parse(await readJson(firstResponse));
      const firstEnvironment = await waitForThreadEnvironment(harness, firstThread.id);

      const reuseResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Reuse the provisioning sandbox" }],
          environment: {
            type: "reuse",
            environmentId: firstEnvironment.id,
          },
        }),
      });

      expect(reuseResponse.status).toBe(201);
      const reusedThread = threadSchema.parse(await readJson(reuseResponse));
      expect(reusedThread.environmentId).toBe(firstEnvironment.id);
      expect(reusedThread.status).toBe("provisioning");

      await waitForAssertion(() => {
        expect(resolveProvisionHost).not.toBeNull();
        expect(sandboxHostId).toBeDefined();
      });

      if (!resolveProvisionHost || !sandboxHostId) {
        throw new Error("Expected sandbox host provisioning to start");
      }
      resolveProvisionHost({
        destroy: vi.fn().mockResolvedValue(undefined),
        extendTimeout: vi.fn().mockResolvedValue(undefined),
        externalId: "sandbox-external-reuse",
        hostId: sandboxHostId,
        resume: vi.fn().mockResolvedValue(undefined),
        suspend: vi.fn().mockResolvedValue(undefined),
      });

      openSession(harness.db, harness.hub, {
        dataDir: `/tmp/bb-host-data/${sandboxHostId}`,
        heartbeatIntervalMs: 10_000,
        hostId: sandboxHostId,
        hostName: sandboxHostName ?? "Sandbox Reuse Host",
        hostType: "ephemeral",
        instanceId: "instance-sandbox-reuse",
        leaseTimeoutMs: 60_000,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      });
      await reportNextRuntimeMaterialSyncSuccess(harness, {
        hostId: sandboxHostId,
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision"
          && command.environmentId === firstEnvironment.id,
      );
      expect(queued.row.hostId).toBe(sandboxHostId);
    } finally {
      await harness.cleanup();
    }
  });


  it("marks the thread errored when sandbox host provisioning fails", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      let sandboxHostId = "";
      provisionHostMock.mockImplementation(async (options: SandboxProvisionCall) => {
        sandboxHostId = options.hostId;
        throw new Error("sandbox bootstrap failed");
      });

      const { host } = seedHostSession(harness.deps);
      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision a sandbox thread" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));

      await waitForAssertion(() => {
        expect(sandboxHostId).toMatch(/^host_/u);
        expect(getThread(harness.db, createdThread.id)).toMatchObject({
          status: "error",
        });
        expect(getHost(harness.db, sandboxHostId)).toMatchObject({
          destroyedAt: expect.any(Number),
        });
      });

      const storedEvents = harness.db
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(eq(events.threadId, createdThread.id))
        .all();
      const failureEvents = storedEvents
        .filter((event) => event.type === "system/thread-provisioning")
        .map((event) => systemThreadProvisioningEventDataSchema.parse(JSON.parse(event.data)));
      expect(
        failureEvents.flatMap((event) => event.entries.map((entry) => entry.text)),
      ).toContain("sandbox bootstrap failed");
      expect(listHosts(harness.db)).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });


  it("finishes pending cleanup when sandbox bootstrap fails after delete-before-connect", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      let sandboxHostId: string | undefined;
      let rejectProvisionHost: ((reason?: unknown) => void) | null = null;
      const provisionHostResult = new Promise<{
        destroy: ReturnType<typeof vi.fn>;
        extendTimeout: ReturnType<typeof vi.fn>;
        externalId: string;
        hostId: string;
        resume: ReturnType<typeof vi.fn>;
        suspend: ReturnType<typeof vi.fn>;
      }>((_resolve, reject) => {
        rejectProvisionHost = reject;
      });
      void provisionHostResult.catch(() => undefined);
      provisionHostMock.mockImplementation(async (options: SandboxProvisionCall) => {
        sandboxHostId = options.hostId;
        return provisionHostResult;
      });

      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Cleanup Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const createResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision then delete" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(createResponse.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(createResponse));
      const environment = await waitForThreadEnvironment(harness, createdThread.id);

      const deleteResponse = await harness.app.request(`/api/v1/threads/${createdThread.id}`, {
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        cleanupMode: "force",
        cleanupRequestedAt: expect.any(Number),
        status: "provisioning",
      });

      if (!rejectProvisionHost) {
        throw new Error("Expected sandbox host provisioning to start");
      }
      rejectProvisionHost(new Error("sandbox bootstrap failed"));

      await waitForAssertion(() => {
        expect(getEnvironment(harness.db, environment.id)).toMatchObject({
          cleanupMode: null,
          cleanupRequestedAt: null,
          status: "destroyed",
        });
      });
      expect(sandboxHostId).toBeDefined();
      expect(getHost(harness.db, sandboxHostId!)).toMatchObject({
        destroyedAt: expect.any(Number),
      });
      const destroyCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.destroy"))
        .all();
      expect(destroyCommands).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });


  it.each([
    "https://localhost:3000",
    "https://127.0.0.1:3000",
    "https://0.0.0.0:3000",
    "https://[::1]:3000",
    "https://169.254.20.1:3000",
    "https://10.0.0.5:3000",
    "https://172.20.0.10:3000",
    "https://192.168.1.20:3000",
    "https://[fc00::1]:3000",
    "https://[fe80::1]:3000",
  ])("rejects unreachable sandbox external URLs: %s", async (externalUrl) => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      externalUrl,
    });
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision a sandbox thread" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message:
          "Sandbox provisioning requires BB_EXTERNAL_URL to be reachable from the internet",
      });
      expect(provisionHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });


  it("rejects sandbox-host threads when BB_EXTERNAL_URL is not configured", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      externalUrl: undefined,
    });
    try {
      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision a sandbox thread" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(501);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "not_configured",
        message: "Sandbox provisioning requires BB_EXTERNAL_URL to be configured",
      });
      expect(provisionHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });


  it("rejects sandbox-host threads when no sandbox template is configured", async () => {
    const harness = await createTestAppHarness({
      e2bTemplate: "",
      githubPat: "test-github-pat",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision a sandbox thread" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(501);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "not_configured",
        message:
          "Sandbox provisioning requires E2B_TEMPLATE to be configured",
      });
      expect(provisionHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });


  it("rejects sandbox-host threads when BB_GITHUB_PAT is not configured", async () => {
    const harness = await createTestAppHarness({
      githubPat: "",
    });
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Provision a sandbox thread" }],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(501);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "not_configured",
        message:
          "Sandbox provisioning requires BB_GITHUB_PAT to be configured",
      });
      expect(provisionHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });
});
