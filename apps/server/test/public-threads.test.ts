import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import {
  createProject,
  createProjectSource,
  createEnvironment,
  createThread,
  events,
  getDraft,
  getEnvironment,
  getHost,
  openSession,
  listHosts,
  getThread,
  hostDaemonCommands,
  listThreads,
  threads,
} from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { systemOperationEventDataSchema, threadSchema } from "@bb/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "./helpers/commands.js";
import { readJson } from "./helpers/json.js";
import { runEphemeralHostCleanupSweep } from "../src/services/periodic-sweeps.js";
import { destroyHost } from "../src/services/host-lifecycle.js";
import {
  seedDraft,
  seedEnvironment,
  seedEvent,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

const execFileAsync = promisify(execFile);
const provisionHostMock = vi.fn();
const resumeHostMock = vi.fn();
type SandboxHostMockArgs = Array<object | string | undefined>;

interface SandboxProvisionCall {
  daemonEnv?: Record<string, string>;
  hostId: string;
  hostName: string;
}

type AssertionFn = () => void;

// Server tests treat @bb/sandbox-host as the external sandbox boundary.
// Package-level tests cover the E2B mechanics directly; these tests focus on
// server policy and request/response behavior.
vi.mock("@bb/sandbox-host", () => ({
  provisionHost: (...args: SandboxHostMockArgs) => provisionHostMock(...args),
  resumeHost: (...args: SandboxHostMockArgs) => resumeHostMock(...args),
}));

interface GitCommandArgs {
  args: string[];
  cwd: string;
}

interface TestGitRepo {
  cleanup: () => Promise<void>;
  path: string;
}

async function runGitCommand(args: GitCommandArgs): Promise<void> {
  await execFileAsync("git", args.args, {
    cwd: args.cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "bb-tests@example.com",
      GIT_AUTHOR_NAME: "bb tests",
      GIT_COMMITTER_EMAIL: "bb-tests@example.com",
      GIT_COMMITTER_NAME: "bb tests",
    },
  });
}

async function createTestGitRepo(): Promise<TestGitRepo> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "bb-server-thread-repo-"));
  await runGitCommand({ cwd: repoPath, args: ["init", "--initial-branch=main"] });
  await writeFile(path.join(repoPath, "README.md"), "# thread test repo\n", "utf8");
  await runGitCommand({ cwd: repoPath, args: ["add", "README.md"] });
  await runGitCommand({ cwd: repoPath, args: ["commit", "-m", "Initial commit"] });

  return {
    path: repoPath,
    cleanup: async () => {
      await rm(repoPath, { recursive: true, force: true });
    },
  };
}

async function waitForAssertion(assertion: AssertionFn): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastMessage = "Condition not met";

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : "Condition not met";
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw new Error(lastMessage);
}

function cleanWorkspaceStatus() {
  return {
    workingTree: {
      hasUncommittedChanges: false,
      state: "clean",
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      files: [],
    },
    branch: {
      currentBranch: "bb/thread",
      defaultBranch: "main",
    },
    mergeBase: {
      mergeBaseBranch: "main",
      baseRef: "origin/main",
      aheadCount: 0,
      behindCount: 0,
      hasCommittedUnmergedChanges: false,
      commits: [],
    },
  };
}

describe("public thread routes", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });

  it("creates unmanaged host threads and queues environment provisioning", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/unmanaged-project",
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
          input: [{ type: "text", text: "Inspect the default source workspace" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");

      const environment = getEnvironment(harness.db, createdThread.environmentId);
      expect(environment).toMatchObject({
        projectId: project.id,
        status: "provisioning",
        workspaceProvisionType: "unmanaged",
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      expect(queued.command).toMatchObject({
        environmentId: environment?.id,
        path: source.path,
        workspaceProvisionType: "unmanaged",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("creates host threads even when the host is offline by queueing provisioning without a session", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, {
        id: "host-thread-offline",
      });
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/offline-thread-project",
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
          input: [{ type: "text", text: "Create this thread offline" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      expect(queued.command).toMatchObject({
        environmentId: createdThread.environmentId,
        path: source.path,
        workspaceProvisionType: "unmanaged",
      });
      expect(queued.row.sessionId).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("creates managed-worktree threads and queues managed provisioning", async () => {
    const harness = await createTestAppHarness();
    const repo = await createTestGitRepo();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: repo.path,
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
          title: "Managed thread",
          input: [{ type: "text", text: "Build it" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "managed-worktree",
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      expect(queued.command).toMatchObject({
        sourcePath: source.path,
        workspaceProvisionType: "managed-worktree",
        setupScript: ".bb-env-setup.sh",
        setupTimeoutMs: 900000,
      });
      expect(queued.command).toHaveProperty("targetPath");
      expect(queued.command).toHaveProperty("branchName");

    } finally {
      await repo.cleanup();
      await harness.cleanup();
    }
  });

  it("creates managed-worktree threads on a non-default host using that host's source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: defaultHost } = seedHostSession(harness.deps, {
        id: "host-managed-default",
      });
      const { host: secondaryHost } = seedHostSession(harness.deps, {
        id: "host-managed-secondary",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: defaultHost.id,
        path: "/tmp/default-managed-source",
      });
      const secondarySource = createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: secondaryHost.id,
        path: "/tmp/secondary-managed-source",
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
          title: "Secondary host thread",
          input: [{ type: "text", text: "Build it on the secondary host" }],
          environment: {
            type: "host",
            hostId: secondaryHost.id,
            workspace: {
              type: "managed-worktree",
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === createdThread.environmentId,
      );
      expect(queued.command).toMatchObject({
        sourcePath: secondarySource.path,
        workspaceProvisionType: "managed-worktree",
      });
      expect(queued.command.targetPath).toContain(`.bb-worktrees/${project.id}/${createdThread.id}`);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 409 when the requested host has no configured project source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: defaultHost } = seedHostSession(harness.deps, {
        id: "host-source-default",
      });
      const { host: missingSourceHost } = seedHostSession(harness.deps, {
        id: "host-source-missing",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: defaultHost.id,
        path: "/tmp/source-present",
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
          input: [{ type: "text", text: "Try the missing host" }],
          environment: {
            type: "host",
            hostId: missingSourceHost.id,
            workspace: {
              type: "managed-worktree",
            },
          },
        }),
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: "No project source configured for this host",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("creates unmanaged threads with an explicit path even when the host has no project source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: defaultHost } = seedHostSession(harness.deps, {
        id: "host-unmanaged-default",
      });
      const { host: explicitPathHost } = seedHostSession(harness.deps, {
        id: "host-unmanaged-explicit",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: defaultHost.id,
        path: "/tmp/unmanaged-default-source",
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
          input: [{ type: "text", text: "Use the explicit workspace path" }],
          environment: {
            type: "host",
            hostId: explicitPathHost.id,
            workspace: {
              type: "unmanaged",
              path: "/tmp/explicit-unmanaged-workspace",
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.status).toBe("provisioning");

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === createdThread.environmentId,
      );
      expect(queued.command).toMatchObject({
        path: "/tmp/explicit-unmanaged-workspace",
        workspaceProvisionType: "unmanaged",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("reuses the ready unmanaged environment for the default source path", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/shared-unmanaged-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: source.path,
        status: "ready",
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
          input: [{ type: "text", text: "Reuse the existing direct workspace" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread).toMatchObject({
        environmentId: environment.id,
        status: "active",
      });

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.environmentId === environment.id &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        workspaceContext: { workspacePath: source.path, workspaceProvisionType: "unmanaged" },
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/thread/start",
        },
      });
      expect(getThread(harness.db, createdThread.id)).toMatchObject({
        type: "standard",
        parentThreadId: null,
      });

      const provisionCommands = harness.db
        .select()
        .from(hostDaemonCommands)
        .where(eq(hostDaemonCommands.type, "environment.provision"))
        .all();
      expect(provisionCommands).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("attaches new threads to an in-flight unmanaged environment without reprovisioning", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project, source } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/inflight-unmanaged-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: source.path,
        status: "provisioning",
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
          input: [{ type: "text", text: "Wait for the existing provisioning flow" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({
        environmentId: environment.id,
        status: "provisioning",
      });

      const queuedCommands = harness.db.select().from(hostDaemonCommands).all();
      expect(queuedCommands).toHaveLength(0);
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
        openSession(harness.db, harness.hub, {
          heartbeatIntervalMs: 10_000,
          hostId: options.hostId,
          hostName: options.hostName,
          hostType: "ephemeral",
          instanceId: "instance-sandbox-test",
          leaseTimeoutMs: 60_000,
          protocolVersion: 2,
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
      const createdThread = await readJson(response) as {
        environmentId: string;
        id: string;
        status: string;
      };
      expect(createdThread.status).toBe("provisioning");
      expect(provisionHostMock).toHaveBeenCalledWith({
        apiKey: "test-e2b-api-key",
        authToken: harness.config.authToken,
        daemonEnv: {
          GITHUB_TOKEN: "test-github-pat",
          OPENAI_API_KEY: "test-openai-key",
        },
        hostId: expect.stringMatching(/^host_/u),
        hostName: expect.stringMatching(/^sandbox-/u),
        serverUrl: "https://bb.example.test",
        template: "test-e2b-template",
      });

      const environment = getEnvironment(harness.db, createdThread.environmentId);
      if (!environment) {
        throw new Error("Expected environment to exist");
      }
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
      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        sourcePath: "https://github.com/example/repo.git",
        targetPath: `/tmp/.bb-worktrees/${project.id}/${createdThread.id}`,
        workspaceProvisionType: "managed-clone",
      });
      expect(queued.row.hostId).toBe(environment.hostId);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not sweep connecting sandbox hosts before the first session arrives", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      let sandboxHostId: string | undefined;
      let sandboxHostName: string | undefined;
      provisionHostMock.mockImplementation(async (options: SandboxProvisionCall) => {
        sandboxHostId = options.hostId;
        sandboxHostName = options.hostName;
        return {
          destroy: vi.fn().mockResolvedValue(undefined),
          extendTimeout: vi.fn().mockResolvedValue(undefined),
          externalId: "sandbox-external-connecting",
          hostId: options.hostId,
          resume: vi.fn().mockResolvedValue(undefined),
          suspend: vi.fn().mockResolvedValue(undefined),
        };
      });

      const { project } = createProject(harness.db, harness.hub, {
        name: "Cloud Sandbox Project",
        source: {
          repoUrl: "https://github.com/example/repo.git",
          type: "github_repo",
        },
      });

      const responsePromise = harness.app.request("/api/v1/threads", {
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

      await waitForAssertion(() => {
        if (!sandboxHostId) {
          throw new Error("Expected sandbox host provisioning to start");
        }

        const sandboxHost = getHost(harness.db, sandboxHostId);
        expect(sandboxHost).toMatchObject({
          externalId: "sandbox-external-connecting",
          id: sandboxHostId,
        });

        const createdThreads = listThreads(harness.db, {
          archived: false,
          projectId: project.id,
        });
        expect(createdThreads).toHaveLength(1);

        const createdThread = createdThreads[0];
        expect(createdThread.status).toBe("provisioning");
        expect(createdThread.environmentId).toMatch(/^env_/u);

        const environment = getEnvironment(harness.db, createdThread.environmentId!);
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
        externalId: "sandbox-external-connecting",
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

      const response = await responsePromise;
      expect(response.status).toBe(201);
    } finally {
      await harness.cleanup();
    }
  });

  it("cleans up the sandbox host row when provisioning fails", async () => {
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

      expect(response.status).toBe(500);
      expect(sandboxHostId).toMatch(/^host_/u);
      expect(getHost(harness.db, sandboxHostId)).toBeNull();
      expect(listHosts(harness.db)).toHaveLength(1);
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
  ])("rejects unreachable sandbox public URLs: %s", async (publicUrl) => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      publicUrl,
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
          "Sandbox provisioning requires BB_PUBLIC_URL to be reachable from the internet",
      });
      expect(provisionHostMock).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects sandbox-host threads when BB_PUBLIC_URL is not configured", async () => {
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
      publicUrl: undefined,
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
        message: "Sandbox provisioning requires BB_PUBLIC_URL to be configured",
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

  it("reuses an existing environment when requested", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/reuse-project",
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
          input: [{ type: "text", text: "Reuse the environment" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      await expect(readJson(response)).resolves.toMatchObject({
        environmentId: environment.id,
        status: "active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("queues turn.run for idle threads and turn.steer for active threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/send-project",
      });
      const idleThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: idleThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-idle",
        sequence: 1,
        type: "thread/identity",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: idleThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-idle",
        sequence: 2,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Prior task" }],
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
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
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-turn",
        turnId: "turn-1",
        sequence: 3,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: activeThread.id,
        environmentId: environment.id,
        providerThreadId: "provider-turn",
        sequence: 4,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Prior task" }],
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
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

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${idleThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            input: [{ type: "text", text: "Run this task" }],
          }),
        },
      );
      expect(sendResponse.status).toBe(200);
      const runCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === idleThread.id,
      );
      expect(runCommand.command).toMatchObject({
        environmentId: environment.id,
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/turn/requested",
        },
        resumeContext: {
          workspaceContext: { workspacePath: environment.path, workspaceProvisionType: "unmanaged" },
          projectId: project.id,
          providerId: idleThread.providerId,
          providerThreadId: "provider-idle",
        },
      });
      expect(getThread(harness.db, idleThread.id)?.status).toBe("active");

      const steerResponse = await harness.app.request(
        `/api/v1/threads/${activeThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: "Refocus the turn" }],
          }),
        },
      );
      expect(steerResponse.status).toBe(200);
      const steerCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.steer" && command.threadId === activeThread.id,
      );
      expect(steerCommand.command).toMatchObject({
        expectedTurnId: "turn-1",
        environmentId: environment.id,
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          source: "client/turn/requested",
        },
        resumeContext: {
          workspaceContext: { workspacePath: environment.path, workspaceProvisionType: "unmanaged" },
          projectId: project.id,
          providerId: activeThread.providerId,
          providerThreadId: "provider-turn",
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid send mode transitions", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const idleThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      const activeThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const startOnActive = await harness.app.request(
        `/api/v1/threads/${activeThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "start",
            input: [{ type: "text", text: "Should fail" }],
          }),
        },
      );
      expect(startOnActive.status).toBe(409);
      await expect(readJson(startOnActive)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Thread is already active",
      });

      const steerOnIdle = await harness.app.request(
        `/api/v1/threads/${idleThread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: "Should also fail" }],
          }),
        },
      );
      expect(steerOnIdle.status).toBe(409);
      await expect(readJson(steerOnIdle)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Thread is not active",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("stops threads, archives unmanaged workspaces directly, and requires confirmation for dirty isolated managed workspaces", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const isolatedManagedEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-dirty",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const dirtyThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: isolatedManagedEnvironment.id,
        status: "idle",
      });

      const stopPromise = harness.app.request(`/api/v1/threads/${thread.id}/stop`, {
        method: "POST",
      });
      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      await reportQueuedCommandSuccess(harness, stopCommand, {});
      const stopResponse = await stopPromise;
      expect(stopResponse.status).toBe(200);

      const dirtyArchivePromise = harness.app.request(
        `/api/v1/threads/${dirtyThread.id}/archive`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ force: false }),
        },
      );
      const dirtyStatusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === isolatedManagedEnvironment.id,
      );
      await reportQueuedCommandSuccess(harness, dirtyStatusCommand, {
        workspaceStatus: {
          ...cleanWorkspaceStatus(),
          workingTree: {
            ...cleanWorkspaceStatus().workingTree,
            state: "dirty_uncommitted",
            changedFiles: 1,
            hasUncommittedChanges: true,
          },
        },
      });
      const dirtyArchiveResponse = await dirtyArchivePromise;
      expect(dirtyArchiveResponse.status).toBe(409);
      await expect(readJson(dirtyArchiveResponse)).resolves.toMatchObject({
        code: "archive_confirmation_required",
        message: "Archiving this thread would clean up a workspace that contains work.",
      });

      const archiveResponse = await harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: false }),
      });
      expect(archiveResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      await expect(
        waitForQueuedCommandAfter(
          harness,
          dirtyStatusCommand.row.cursor,
          ({ command }) =>
            command.type === "workspace.status" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");

      const unarchiveResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        {
          method: "POST",
        },
      );
      expect(unarchiveResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("stops active threads while the host is disconnected", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-stop-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}/stop`, {
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.stopRequestedAt).toBeTypeOf("number");

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stopCommand.row.sessionId).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes active threads while the host is disconnected and hides the tombstone immediately", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-delete-active-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/delete-active-offline",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      const deletedThread = getThread(harness.db, thread.id);
      expect(deletedThread?.deletedAt).toBeTypeOf("number");
      expect(deletedThread?.stopRequestedAt).toBeTypeOf("number");
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(0);

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      expect(stopCommand.row.sessionId).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes idle threads while the host is disconnected without queueing stop", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-delete-idle-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      const deletedThread = getThread(harness.db, thread.id);
      expect(deletedThread?.deletedAt).toBeTypeOf("number");
      expect(deletedThread?.stopRequestedAt).toBeNull();
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(0);
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" && command.threadId === thread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes idle managed threads while disconnected and queues cleanup immediately", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-delete-idle-managed-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/delete-idle-managed-offline",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.deletedAt).toBeTypeOf("number");
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroying");

      const destroyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.row.sessionId).toBeNull();
      await expect(
        waitForQueuedCommandAfter(
          harness,
          destroyCommand.row.cursor,
          ({ command }) =>
            command.type === "thread.stop" && command.threadId === thread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });

  it("archives shared managed environments without prompting or queueing cleanup", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-shared",
      });
      const archivedThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(`/api/v1/threads/${archivedThread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: false }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, archivedThread.id)?.archivedAt).toBeTypeOf("number");
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "workspace.status" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "environment.destroy" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });

  it("archives isolated managed environments while disconnected without authorizing cleanup", async () => {
    const harness = await createTestAppHarness();
    try {
      const host = seedHost(harness.deps, { id: "host-archive-managed-offline" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-offline",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: false }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("ready");
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "environment.destroy" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    } finally {
      await harness.cleanup();
    }
  });

  it("archives active isolated managed environments without destroying them until stop finalization completes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-archive-managed-active",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-active",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const archivePromise = harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: false }),
      });

      const initialStatusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, initialStatusCommand, {
        workspaceStatus: cleanWorkspaceStatus(),
      });

      const stopCommand = await waitForQueuedCommandAfter(
        harness,
        initialStatusCommand.row.cursor,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === thread.id,
      );

      const archiveResponse = await archivePromise;
      expect(archiveResponse.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      expect(getThread(harness.db, thread.id)?.stopRequestedAt).toBeTypeOf("number");
      await expect(
        waitForQueuedCommandAfter(
          harness,
          stopCommand.row.cursor,
          ({ command }) =>
            command.type === "environment.destroy" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");

      const stopResultPromise = reportQueuedCommandSuccess(harness, stopCommand, {});

      const cleanupStatusCommand = await waitForQueuedCommandAfter(
        harness,
        stopCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, cleanupStatusCommand, {
        workspaceStatus: cleanWorkspaceStatus(),
      });
      const stopResultResponse = await stopResultPromise;
      expect(stopResultResponse.status).toBe(200);

      const destroyCommand = await waitForQueuedCommandAfter(
        harness,
        cleanupStatusCommand.row.cursor,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("preserves forced managed cleanup across active thread stop finalization", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-archive-managed-active-force",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/archive-managed-active-force",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });

      const archiveResponse = await harness.app.request(`/api/v1/threads/${thread.id}/archive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ force: true }),
      });
      expect(archiveResponse.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroying");

      const stopCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === thread.id,
      );

      const stopResultPromise = reportQueuedCommandSuccess(harness, stopCommand, {});

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
      await expect(
        waitForQueuedCommandAfter(
          harness,
          stopCommand.row.cursor,
          ({ command }) =>
            command.type === "workspace.status" &&
            command.environmentId === environment.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");

      const stopResultResponse = await stopResultPromise;
      expect(stopResultResponse.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  it("queues environment.destroy when deleting the last thread on a managed environment", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        path: "/tmp/delete-managed",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);

      const destroyCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.destroy" &&
          command.environmentId === environment.id,
      );
      expect(destroyCommand.command).toMatchObject({
        environmentId: environment.id,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("marks provisioning managed environments as destroying without queueing an invalid destroy", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: null,
        managed: true,
        status: "provisioning",
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)?.status).toBe("destroying");

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

  it("queues thread.rename, returns thread events, sends drafts, and creates manager threads", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-data-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-data-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
        title: "Old title",
        titleFallback: "Old title",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        data: { text: "Hello from the manager" },
      });

      const patchResponse = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "New title",
        }),
      });
      expect(patchResponse.status).toBe(200);
      const renameCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.rename" && command.threadId === thread.id,
      );
      expect(renameCommand.command).toMatchObject({
        title: "New title",
      });

      const eventsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/events`,
      );
      expect(eventsResponse.status).toBe(200);
      await expect(readJson(eventsResponse)).resolves.toEqual([
        expect.objectContaining({
          type: "system/manager/user_message",
        }),
      ]);

      const draft = seedDraft(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Draft content" }],
        model: "gpt-5",
        serviceTier: "default",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-draft",
        sequence: 2,
        type: "thread/identity",
        data: {},
      });
      const draftSendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts/${draft.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      expect(draftSendResponse.status).toBe(200);
      const draftCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.run" && command.threadId === thread.id,
      );
      expect(draftCommand.command).toMatchObject({
        environmentId: environment.id,
        options: {
          model: "gpt-5",
          serviceTier: "default",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();

      // Manager creation returns immediately — thread.start is queued with
      // default preferences (skipPreferences: true on initial start).
      const managerResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/managers`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: "Project manager",
            providerId: "codex",
            model: "gpt-5",
            reasoningLevel: "medium",
          }),
        },
      );
      expect(managerResponse.status).toBe(201);
      const managerThread = threadSchema.parse(await readJson(managerResponse));
      expect(managerThread.type).toBe("manager");
      if (!managerThread.environmentId) {
        throw new Error("Expected manager thread environment");
      }

      const managerStartCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === managerThread.id,
      );
      expect(managerStartCommand.command.options).toMatchObject({
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        sandboxMode: "danger-full-access",
        source: "client/thread/start",
      });
      expect(managerStartCommand.command.dynamicTools).toEqual(
        [expect.objectContaining({ name: "message_user" })],
      );
      expect(managerStartCommand.command.instructions).toContain(
        "You are a manager for this project.",
      );
      expect(managerStartCommand.command.instructions).toContain(
        "(file does not exist)",
      );
      expect(managerStartCommand.command.instructions).toContain(project.name);
      expect(managerStartCommand.command.instructions).toContain(
        "Project root: `/tmp/thread-data-project`",
      );
      expect(managerStartCommand.command.instructions).toContain(
        `Thread storage: \`/tmp/bb-host-data/${host.id}/thread-storage/${managerThread.id}\``,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("appends an ownership change event when the parent thread changes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-ownership-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-ownership-project/worktree",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
        title: "Manager thread",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: null,
      });

      const response = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          parentThreadId: managerThread.id,
        }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.parentThreadId).toBe(managerThread.id);

      const storedEvent = harness.db
        .select({ type: events.type, data: events.data })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .orderBy(events.sequence)
        .all()
        .at(-1);

      expect(storedEvent?.type).toBe("system/operation");
      const parsedData = systemOperationEventDataSchema.parse(
        storedEvent ? JSON.parse(storedEvent.data) : null,
      );
      expect(parsedData).toMatchObject({
        operation: "ownership_change",
        status: "completed",
        message: "Thread assigned to manager",
        metadata: {
          action: "assign",
          previousParentThreadId: null,
          nextParentThreadId: managerThread.id,
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("archives non-git threads without requiring workspace status", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        workspaceProvisionType: "unmanaged",
        path: "/tmp/non-git-thread",
        status: "ready",
        isGitRepo: false,
        defaultBranch: null,
      });
      const thread = createThread(harness.db, harness.hub, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
        status: "idle",
        title: "Non-git thread",
        titleFallback: "Non-git thread",
      });
      const commandCountBefore = harness.db
        .select({ id: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .all().length;

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ force: false }),
        },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeTypeOf("number");
      const commandCountAfter = harness.db
        .select({ id: hostDaemonCommands.id })
        .from(hostDaemonCommands)
        .all().length;
      expect(commandCountAfter).toBe(commandCountBefore);
    } finally {
      await harness.cleanup();
    }
  });

  it("steers queued drafts for active threads without a mode field", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-draft-steer-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-draft-steer-project",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-draft-steer",
        sequence: 1,
        type: "thread/identity",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-draft-steer",
        sequence: 2,
        type: "turn/started",
        data: {},
        turnId: "turn-draft-steer",
      });
      const draft = seedDraft(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "Queue a correction" }],
        model: "gpt-5",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts/${draft.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(200);
      const steerCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.steer" && command.threadId === thread.id,
      );
      expect(steerCommand.command).toMatchObject({
        expectedTurnId: "turn-draft-steer",
        input: [{ type: "text", text: "Queue a correction" }],
        options: {
          model: "gpt-5",
        },
        resumeContext: {
          providerThreadId: "provider-draft-steer",
        },
      });
      expect(getDraft(harness.db, draft.id)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
