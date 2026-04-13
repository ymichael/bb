import { threadSchema } from "@bb/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { generateThreadMetadataWithOutcome } from "../../src/services/threads/title-generation.js";

const piAiMocks = vi.hoisted(() => ({
  complete: vi.fn(),
  getModel: vi.fn(),
}));

interface MockThreadMetadata {
  branchSlug?: string;
  title?: string;
}

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: piAiMocks.complete,
    getModel: piAiMocks.getModel,
  };
});

function mockThreadMetadata(metadata: MockThreadMetadata): void {
  piAiMocks.getModel.mockReturnValue({ provider: "test" });
  piAiMocks.complete.mockResolvedValue({
    content: [
      {
        arguments: metadata,
        id: "tool_result",
        name: "result",
        type: "toolCall",
      },
    ],
  });
}

describe("generated managed branch names", () => {
  beforeEach(() => {
    piAiMocks.complete.mockReset();
    piAiMocks.getModel.mockReset();
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
      expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("uses generated branch slugs without retrying title inference when no title is returned", async () => {
    mockThreadMetadata({
      branchSlug: "Slug Only Branch",
    });
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-generated-branch-slug-only",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/generated-branch-slug-only-project",
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
              text: "Improve branch names using slug only metadata path",
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
      expect(thread.title).toBeNull();

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.provision",
      );
      if (queued.command.type !== "environment.provision") {
        throw new Error("Expected environment.provision command");
      }
      expect(queued.command.branchName).toBe(
        `bb/slug-only-branch-${thread.id}`,
      );
      expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
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
      expect(piAiMocks.complete).not.toHaveBeenCalled();
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
      expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
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
        generateThreadMetadataWithOutcome(harness.deps, {
          input: [
            {
              type: "text",
              text: "Improve timed out metadata generation behavior",
            },
          ],
          threadId: "thr_timeout",
          timeoutMs: 1,
        }),
      ).resolves.toMatchObject({
        metadata: null,
        reason: "timeout",
      });
      expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });
});
