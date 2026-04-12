import { createProject, getEnvironment, openSession } from "@bb/db";
import { threadSchema } from "@bb/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reportNextRuntimeMaterialSyncSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { generateThreadMetadata } from "../../src/services/threads/title-generation.js";

const piAiMocks = vi.hoisted(() => ({
  complete: vi.fn(),
  getModel: vi.fn(),
  validateToolCall: vi.fn(),
}));

const sandboxHostMocks = vi.hoisted(() => ({
  provisionHost: vi.fn(),
  resumeHost: vi.fn(),
}));

interface MockThreadMetadata {
  branchSlug?: string;
  title?: string;
}

interface SandboxProvisionCall {
  hostId: string;
  hostName: string;
}

type SandboxHostMockArgs = Array<object | string | undefined>;

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: piAiMocks.complete,
    getModel: piAiMocks.getModel,
    validateToolCall: piAiMocks.validateToolCall,
  };
});

vi.mock("@bb/sandbox-host", () => ({
  DEFAULT_SANDBOX_TIMEOUT_MS: 15 * 60 * 1000,
  provisionHost: (...args: SandboxHostMockArgs) =>
    sandboxHostMocks.provisionHost(...args),
  resumeHost: (...args: SandboxHostMockArgs) =>
    sandboxHostMocks.resumeHost(...args),
}));

function mockThreadMetadata(metadata: MockThreadMetadata): void {
  piAiMocks.getModel.mockReturnValue({ provider: "test" });
  piAiMocks.complete.mockResolvedValue({
    content: [
      {
        name: "result",
        type: "toolCall",
      },
    ],
  });
  piAiMocks.validateToolCall.mockReturnValue(metadata);
}

describe("generated managed branch names", () => {
  beforeEach(() => {
    piAiMocks.complete.mockReset();
    piAiMocks.getModel.mockReset();
    piAiMocks.validateToolCall.mockReset();
    sandboxHostMocks.provisionHost.mockReset();
    sandboxHostMocks.resumeHost.mockReset();
  });

  it("uses generated branch slugs for managed worktree provisioning", async () => {
    mockThreadMetadata({
      branchSlug: "Improve Branch Names!",
      title: "Improve Branch Names",
    });
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-branch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-branch-project",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [
            {
              type: "text",
              text: "Improve the generated branch naming path",
            },
          ],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "managed-worktree" },
          },
        }),
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      expect(thread.title).toBe("Improve Branch Names");

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      if (queued.command.type !== "environment.provision") {
        throw new Error("Expected environment.provision command");
      }
      expect(queued.command.branchName).toBe(
        `bb/improve-branch-names-${thread.id}`,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back to thread ID branch names when inference is unavailable", async () => {
    const harness = await createTestAppHarness({
      inferenceModel: "openai/gpt-4o-mini",
      openAiApiKey: "",
    });
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-branch-fallback",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-branch-fallback-project",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [
            {
              type: "text",
              text: "Improve the generated branch naming fallback path",
            },
          ],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "managed-worktree" },
          },
        }),
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      if (queued.command.type !== "environment.provision") {
        throw new Error("Expected environment.provision command");
      }
      expect(queued.command.branchName).toBe(`bb/${thread.id}`);
      expect(piAiMocks.getModel).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back to thread ID branch names for invalid generated slugs", async () => {
    mockThreadMetadata({
      branchSlug: "!!!",
      title: "Invalid Slug Title",
    });
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-branch-invalid",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-branch-invalid-project",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [
            {
              type: "text",
              text: "Improve invalid generated branch slug handling",
            },
          ],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "managed-worktree" },
          },
        }),
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      expect(thread.title).toBe("Invalid Slug Title");
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      if (queued.command.type !== "environment.provision") {
        throw new Error("Expected environment.provision command");
      }
      expect(queued.command.branchName).toBe(`bb/${thread.id}`);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns no metadata when inference times out", async () => {
    piAiMocks.getModel.mockReturnValue({ provider: "test" });
    piAiMocks.complete.mockReturnValue(new Promise(() => undefined));
    const harness = await createTestAppHarness();
    try {
      await expect(
        generateThreadMetadata(harness.deps, {
          input: [
            {
              type: "text",
              text: "Improve timed out metadata generation behavior",
            },
          ],
          threadId: "thr_timeout",
          timeoutMs: 1,
        }),
      ).resolves.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("uses generated branch slugs for sandbox-host provisioning", async () => {
    mockThreadMetadata({
      branchSlug: "Sandbox Branch",
      title: "Sandbox Branch",
    });
    const harness = await createTestAppHarness({
      githubPat: "test-github-pat",
    });
    try {
      sandboxHostMocks.provisionHost.mockImplementation(
        async (options: SandboxProvisionCall) => {
          openSession(harness.db, harness.hub, {
            heartbeatIntervalMs: 10_000,
            hostId: options.hostId,
            hostName: options.hostName,
            hostType: "ephemeral",
            instanceId: "instance-generated-branch-sandbox",
            leaseTimeoutMs: 60_000,
            protocolVersion: 2,
          });
          return {
            destroy: vi.fn().mockResolvedValue(undefined),
            extendTimeout: vi.fn().mockResolvedValue(undefined),
            externalId: "sandbox-generated-branch",
            hostId: options.hostId,
            resume: vi.fn().mockResolvedValue(undefined),
            suspend: vi.fn().mockResolvedValue(undefined),
          };
        },
      );
      const { project } = createProject(harness.db, harness.hub, {
        name: "Sandbox Generated Branch Project",
        source: {
          repoUrl: "https://github.com/example/generated-branch.git",
          type: "github_repo",
        },
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [
            {
              type: "text",
              text: "Improve sandbox generated branch naming behavior",
            },
          ],
          environment: {
            type: "sandbox-host",
            sandboxType: "e2b",
          },
        }),
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      const environment = getEnvironment(harness.db, thread.environmentId ?? "");
      if (!environment) {
        throw new Error("Expected sandbox environment to exist");
      }
      await reportNextRuntimeMaterialSyncSuccess(harness, {
        hostId: environment.hostId,
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      if (queued.command.type !== "environment.provision") {
        throw new Error("Expected environment.provision command");
      }
      expect(queued.command.branchName).toBe(
        `bb/sandbox-branch-${thread.id}`,
      );
    } finally {
      await harness.cleanup();
    }
  });
});
