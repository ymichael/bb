import { defaultFeatureFlags } from "@bb/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateCommitMessage } from "../../src/services/ai/commit-message.js";
import { InferenceTimeoutError } from "../../src/services/ai/inference.js";
import type { AppDeps, ServerRuntimeConfig } from "../../src/types.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

const piAiMocks = vi.hoisted(() => ({
  complete: vi.fn(),
  getModel: vi.fn(),
}));

type CommitMessageDeps = Pick<AppDeps, "config" | "logger">;

interface TestCommitMessageDeps {
  deps: CommitMessageDeps;
  logger: AppDeps["logger"];
}

interface MockCommitMessage {
  message: string;
}

const commitMessageArgs = {
  diffDescription: "uncommitted changes",
  files: "M\tfile.ts\n",
  patch:
    "diff --git a/file.ts b/file.ts\n@@ -1 +1,2 @@\n export {}\n+export const changed = true;\n",
  shortstat: "1 file changed, 1 insertion(+)\n",
};

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    complete: piAiMocks.complete,
    getModel: piAiMocks.getModel,
  };
});

function createCommitMessageDeps(): TestCommitMessageDeps {
  const config: ServerRuntimeConfig = {
    anthropicApiKey: "",
    appUrl: "https://bb.example.test",
    dataDir: "/tmp/bb-commit-message-test",
    e2bApiKey: "",
    e2bTemplate: "",
    externalUrl: "https://bb.example.test",
    featureFlags: defaultFeatureFlags,
    githubPat: "",
    hostDaemonPort: 3001,
    inferenceModel: "test/mock-model",
    isDevelopment: true,
    openAiApiKey: "test-openai-key",
    serverPort: 3334,
    sandboxActivityExtensionDebounceMs: 30_000,
    sandboxIdleThresholdMs: 300_000,
  };
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return {
    deps: {
      config,
      logger,
    },
    logger,
  };
}

function mockCommitMessageCompletion(commitMessage: MockCommitMessage) {
  return {
    content: [
      {
        arguments: commitMessage,
        id: "tool_result",
        name: "result",
        type: "toolCall",
      },
    ],
  };
}

function mockInvalidCommitMessageCompletion() {
  return {
    content: [
      {
        arguments: {},
        id: "tool_result",
        name: "result",
        type: "toolCall",
      },
    ],
  };
}

function mockNoResultCompletion() {
  return {
    content: [],
  };
}

describe("commit message generation", () => {
  beforeEach(() => {
    piAiMocks.complete.mockReset();
    piAiMocks.getModel.mockReset();
    piAiMocks.getModel.mockReturnValue({ provider: "test" });
  });

  it("retries once when commit message inference times out", async () => {
    piAiMocks.complete
      .mockRejectedValueOnce(new InferenceTimeoutError({ timeoutMs: 5_000 }))
      .mockResolvedValueOnce(
        mockCommitMessageCompletion({
          message: "fix: recover commit message",
        }),
      );
    const { deps, logger } = createCommitMessageDeps();

    const message = await generateCommitMessage(deps, commitMessageArgs);

    expect(message).toBe("fix: recover commit message");
    expect(piAiMocks.complete).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 2,
        reason: "timeout",
        timeoutMs: 5_000,
      }),
      "Commit message inference timed out; retrying",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 2,
        reason: "timeout",
      }),
      "Commit message inference completed after timeout retry",
    );
  });

  it("returns a timeout outcome after exhausting commit message retries", async () => {
    piAiMocks.complete.mockRejectedValue(
      new InferenceTimeoutError({ timeoutMs: 5_000 }),
    );
    const { deps, logger } = createCommitMessageDeps();

    const message = await generateCommitMessage(deps, commitMessageArgs);

    expect(message).toBeNull();
    expect(piAiMocks.complete).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 2,
        reason: "timeout",
        timeoutMs: 5_000,
      }),
      "Commit message inference timed out",
    );
  });

  it("returns no-result without retrying when inference completes without a result tool call", async () => {
    piAiMocks.complete.mockResolvedValue(mockNoResultCompletion());
    const { deps, logger } = createCommitMessageDeps();

    const message = await generateCommitMessage(deps, commitMessageArgs);

    expect(message).toBeNull();
    expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        reason: "no-result",
      }),
      "Commit message inference returned no result",
    );
  });

  it("does not retry non-timeout failures", async () => {
    piAiMocks.complete.mockResolvedValue(mockInvalidCommitMessageCompletion());
    const { deps, logger } = createCommitMessageDeps();

    const message = await generateCommitMessage(deps, commitMessageArgs);

    expect(message).toBeNull();
    expect(piAiMocks.complete).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 1,
        err: expect.any(Error),
        reason: "failed",
      }),
      "Failed to generate commit message",
    );
  });

  it("uses the route fallback message only after commit message timeout retries are exhausted", async () => {
    piAiMocks.complete.mockRejectedValue(
      new InferenceTimeoutError({ timeoutMs: 5_000 }),
    );
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/actions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "commit",
          }),
        },
      );

      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
        workspaceStatus: {
          branch: {
            currentBranch: "feature",
            defaultBranch: "main",
          },
          mergeBase: null,
          workingTree: {
            deletions: 0,
            files: [],
            hasUncommittedChanges: true,
            insertions: 1,
            state: "dirty_uncommitted",
          },
        },
      });

      const diffCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.diff" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, diffCommand, {
        diff: {
          diff: commitMessageArgs.patch,
          files: commitMessageArgs.files,
          mergeBaseRef: null,
          shortstat: commitMessageArgs.shortstat,
          truncated: false,
        },
      });

      const commitCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.commit" &&
          command.environmentId === environment.id,
      );
      expect(commitCommand.command).toMatchObject({
        message: "bb: automated commit",
      });
      expect(piAiMocks.complete).toHaveBeenCalledTimes(2);
      await reportQueuedCommandSuccess(harness, commitCommand, {
        commitSha: "abc123",
        commitSubject: "bb: automated commit",
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        action: "commit",
        commitSubject: "bb: automated commit",
        ok: true,
      });
    } finally {
      await harness.cleanup();
    }
  });
});
