import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { promptTextInput } from "./test/prompt-input.js";
import { UNSOLICITED_TURN_THREAD_ID_ENV } from "./test/bridges/unsolicited-turn-bridge.js";
import {
  createScriptedEchoLaunch,
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  scriptedEchoProcessEnv,
  wait,
  waitForRuntimeThreadEvent,
  waitForThreadAgentMessageText,
  waitForThreadTurnCompleted,
  waitForThreadTurnStarted,
  type CreateScriptedEchoLaunchOptions,
  type LaunchBoundAgentRuntime,
  type ScriptedEchoRequestRecord,
} from "./test/runtime-test-harness.js";

interface CreateContractRuntimeArgs {
  additionalWorkspaceWriteRoots?: readonly string[];
  env?: Record<string, string>;
  launch?: CreateScriptedEchoLaunchOptions;
  onEvent?: (event: ThreadEvent) => void;
  onStderr?: (line: string) => void;
}

interface ContractRuntime {
  record: ScriptedEchoRequestRecord;
  runtime: LaunchBoundAgentRuntime;
}

const missingProviderThreadId = "t-missing";
const missingProviderThreadIdError =
  /No provider thread id available for t-missing/;
const acpLaunchSpec = {
  displayName: "Custom ACP",
  command: "custom-agent",
  args: ["serve"],
  env: { CUSTOM_AGENT_TOKEN: "token" },
};
const unsolicitedTurnBridgeModulePath = fileURLToPath(
  new URL("./test/bridges/unsolicited-turn-bridge.ts", import.meta.url),
);
const codexEmptyRolloutRenameError =
  "failed to set thread name: rollout at /tmp/new-rollout.jsonl is empty";

async function registerThreadWithoutProviderThreadId(
  runtime: LaunchBoundAgentRuntime,
): Promise<void> {
  await expect(
    runtime.resumeThread({
      environmentId: "env-1",
      threadId: missingProviderThreadId,
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    }),
  ).rejects.toThrow(missingProviderThreadIdError);
}

describe("createAgentRuntime command contracts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bb-runtime-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createContractRuntime(
    args: CreateContractRuntimeArgs = {},
  ): ContractRuntime {
    const record = createScriptedEchoRequestRecord();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        workspacePath: tmpDir,
        env: { ...record.env, ...args.env },
        ...(args.additionalWorkspaceWriteRoots !== undefined
          ? {
              additionalWorkspaceWriteRoots: args.additionalWorkspaceWriteRoots,
            }
          : {}),
        onEvent: args.onEvent ?? (() => {}),
        ...(args.onStderr !== undefined ? { onStderr: args.onStderr } : {}),
        onToolCall: async () => ({
          contentItems: [{ type: "inputText", text: "ok" }],
          success: true,
        }),
      },
      ...(args.launch !== undefined ? { launch: args.launch } : {}),
    });
    return { record, runtime };
  }

  it("passes runtime workspace-write roots to the provider as provider options", async () => {
    const additionalWorkspaceWriteRoots = [
      "/repo/.git/worktrees/bb13",
      "/repo/.git/objects",
    ];
    const { record, runtime } = createContractRuntime({
      additionalWorkspaceWriteRoots,
    });

    try {
      await runtime.listModels({ providerId: "fake" });
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      expect(record.last("model/list")?.params).toEqual({
        providerOptions: { additionalWorkspaceWriteRoots },
      });
      expect(record.last("thread/start")?.params).toMatchObject({
        threadId: "t1",
        cwd: tmpDir,
        options: { providerOptions: { additionalWorkspaceWriteRoots } },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("passes a provider's declared launch spec on model list, start, and resume", async () => {
    const { record, runtime } = createContractRuntime();
    const bridgeLaunch = createScriptedEchoLaunch({
      providerOptions: { acpLaunchSpec },
    });

    try {
      await runtime.listModels({ providerId: "acp-custom", bridgeLaunch });
      await runtime.startThread({
        bridgeLaunch,
        environmentId: "env-1",
        threadId: "t-start",
        projectId: "p1",
        providerId: "acp-custom",
        options: fullRuntimeOptions,
      });
      await runtime.resumeThread({
        bridgeLaunch,
        environmentId: "env-1",
        threadId: "t-resume",
        projectId: "p1",
        providerThreadId: "provider-resume",
        providerId: "acp-custom",
        options: fullRuntimeOptions,
      });

      expect(record.last("model/list")?.params).toEqual({
        providerOptions: { acpLaunchSpec },
      });
      expect(record.last("thread/start")?.params).toMatchObject({
        threadId: "t-start",
        options: { providerOptions: { acpLaunchSpec } },
      });
      expect(record.last("thread/resume")?.params).toMatchObject({
        threadId: "t-resume",
        providerThreadId: "provider-resume",
        options: { providerOptions: { acpLaunchSpec } },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("launches the caller's bridge for archive and unarchive", async () => {
    const { record, runtime } = createContractRuntime();
    const bridgeLaunch = createScriptedEchoLaunch({
      pluginId: "provider-graduated",
    });

    try {
      await runtime.archiveThread({
        bridgeLaunch,
        threadId: "t-archive-bridge",
        providerId: "graduated",
        providerThreadId: "provider-explicit",
      });
      await runtime.unarchiveThread({
        bridgeLaunch,
        threadId: "t-archive-bridge",
        providerId: "graduated",
        providerThreadId: "provider-explicit",
      });

      const requests = record.read();
      expect(
        requests.filter((entry) => entry.method === "initialize"),
      ).toHaveLength(2);
      expect(requests).toContainEqual({
        method: "thread/archive",
        params: {
          threadId: "t-archive-bridge",
          providerThreadId: "provider-explicit",
        },
      });
      expect(requests).toContainEqual({
        method: "thread/unarchive",
        params: {
          threadId: "t-archive-bridge",
          providerThreadId: "provider-explicit",
        },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("uses a new provider process cache entry when the declared launch spec changes", async () => {
    const { record, runtime } = createContractRuntime();

    try {
      await runtime.listModels({
        providerId: "acp-custom",
        bridgeLaunch: createScriptedEchoLaunch({
          providerOptions: {
            acpLaunchSpec: { ...acpLaunchSpec, env: { CACHE_MARKER: "first" } },
          },
        }),
      });
      await runtime.listModels({
        providerId: "acp-custom",
        bridgeLaunch: createScriptedEchoLaunch({
          providerOptions: {
            acpLaunchSpec: {
              ...acpLaunchSpec,
              env: { CACHE_MARKER: "second" },
            },
          },
        }),
      });

      const requests = record.read();
      expect(
        requests.filter((entry) => entry.method === "initialize"),
      ).toHaveLength(2);
      expect(
        requests
          .filter((entry) => entry.method === "model/list")
          .map((entry) => entry.params),
      ).toEqual([
        {
          providerOptions: {
            acpLaunchSpec: { ...acpLaunchSpec, env: { CACHE_MARKER: "first" } },
          },
        },
        {
          providerOptions: {
            acpLaunchSpec: {
              ...acpLaunchSpec,
              env: { CACHE_MARKER: "second" },
            },
          },
        },
      ]);
    } finally {
      await runtime.shutdown();
    }
  }, 30000);

  it("prefixes provider rename titles and normalizes provider title events", async () => {
    const events: ThreadEvent[] = [];
    const { record, runtime } = createContractRuntime({
      onEvent: (event) => events.push(event),
    });

    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await runtime.renameThread({ threadId: "t1", title: "New Title" });
      await waitForRuntimeThreadEvent({
        events,
        label: "normalized provider title event",
        predicate: (event) =>
          event.type === "thread/name/updated" &&
          event.threadId === "t1" &&
          event.threadName === "New Title",
        runtime,
        threadId: "t1",
      });

      expect(record.last("thread/name/set")?.params).toEqual({
        threadId: "t1",
        providerThreadId: "prov-1",
        title: "[bb] New Title",
      });
      expect(events).not.toContainEqual(
        expect.objectContaining({
          threadName: "[bb] New Title",
          type: "thread/name/updated",
        }),
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("does not retry a rename: the bridge owns the not-ready-rollout ladder", async () => {
    const { record, runtime } = createContractRuntime({
      launch: {
        scripted: {
          failMethods: [
            {
              method: "thread/name/set",
              message: codexEmptyRolloutRenameError,
              times: 1,
            },
          ],
        },
      },
    });

    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "codex",
        options: fullRuntimeOptions,
      });

      await expect(
        runtime.renameThread({ threadId: "t1", title: "New Title" }),
      ).rejects.toThrow(/rollout at .+ is empty/i);
      expect(
        record.read().filter((entry) => entry.method === "thread/name/set"),
      ).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects unsupported thread rename instead of silently succeeding", async () => {
    const { record, runtime } = createContractRuntime({
      launch: { capabilities: { supportsThreadRename: false } },
    });

    try {
      await runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: fullRuntimeOptions,
      });
      await expect(
        runtime.renameThread({ threadId: "t1", title: "New Title" }),
      ).rejects.toThrow(/does not support thread rename/);
      expect(record.last("thread/name/set")).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([
    { reportedCleared: true, label: "confirms success" },
    { reportedCleared: false, label: "reconciles a stale failure" },
  ])(
    "$label after a provider persists a delayed Goal clear",
    async ({ reportedCleared }) => {
      const events: ThreadEvent[] = [];
      const { record, runtime } = createContractRuntime({
        onEvent: (event) => events.push(event),
        launch: {
          scripted: {
            goalClearNotifyDelayMs: 600,
            goalClearReportsCleared: reportedCleared,
          },
        },
      });

      try {
        await runtime.startThread({
          environmentId: "env-1",
          threadId: "t-goal",
          projectId: "p1",
          providerId: "fake",
          options: fullRuntimeOptions,
        });
        let settled = false;
        const clearPromise = runtime.clearThreadGoal({
          threadId: "t-goal",
        });
        void clearPromise.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        await vi.waitFor(() => {
          expect(record.last("thread/goal/clear")).toBeDefined();
        });
        await wait(100);
        expect(settled).toBe(false);

        await expect(clearPromise).resolves.toEqual({ cleared: true });
        expect(events).toContainEqual(
          expect.objectContaining({
            threadId: "t-goal",
            type: "thread/extensionState/updated",
            kind: "provider-codex/goal",
            payload: null,
          }),
        );
      } finally {
        await runtime.shutdown();
      }
    },
    10_000,
  );

  it("rejects thread resume when providerThreadId cannot be resolved", async () => {
    const { record, runtime } = createContractRuntime();

    await registerThreadWithoutProviderThreadId(runtime);
    expect(record.last("thread/resume")).toBeUndefined();
    await runtime.shutdown();
  });

  it("rejects turn start when providerThreadId cannot be resolved", async () => {
    const { record, runtime } = createContractRuntime();

    await registerThreadWithoutProviderThreadId(runtime);
    await expect(
      runtime.runTurn({
        clientRequestId: "creq_222222224t",
        threadId: missingProviderThreadId,
        input: [promptTextInput({ text: "hello" })],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(missingProviderThreadIdError);
    expect(record.last("turn/start")).toBeUndefined();
    await runtime.shutdown();
  });

  it("rejects thread rename when providerThreadId cannot be resolved", async () => {
    const { record, runtime } = createContractRuntime();

    await registerThreadWithoutProviderThreadId(runtime);
    await expect(
      runtime.renameThread({
        threadId: missingProviderThreadId,
        title: "New Title",
      }),
    ).rejects.toThrow(missingProviderThreadIdError);
    expect(record.last("thread/name/set")).toBeUndefined();
    await runtime.shutdown();
  });

  it("archives threads using caller-provided provider ids without runtime registry state", async () => {
    const { record, runtime } = createContractRuntime();

    await runtime.archiveThread({
      bridgeLaunch: createScriptedEchoLaunch(),
      threadId: "t-archive",
      providerId: "fake",
      providerThreadId: "provider-explicit",
    });
    expect(record.last("thread/archive")?.params).toEqual({
      threadId: "t-archive",
      providerThreadId: "provider-explicit",
    });
    await runtime.shutdown();
  });

  it("unarchives threads using caller-provided provider ids without runtime registry state", async () => {
    const { record, runtime } = createContractRuntime();

    await runtime.unarchiveThread({
      bridgeLaunch: createScriptedEchoLaunch(),
      threadId: "t-unarchive",
      providerId: "fake",
      providerThreadId: "provider-explicit",
    });
    expect(record.last("thread/unarchive")?.params).toEqual({
      threadId: "t-unarchive",
      providerThreadId: "provider-explicit",
    });
    await runtime.shutdown();
  });

  it("propagates a bridge's archive and unarchive rejections verbatim", async () => {
    const { record, runtime } = createContractRuntime({
      env: scriptedEchoProcessEnv({
        failMethods: [
          {
            method: "thread/archive",
            message: "no rollout found for thread id provider-explicit",
          },
          {
            method: "thread/unarchive",
            message:
              "no archived rollout found for thread id provider-explicit",
          },
        ],
      }),
    });
    const bridgeLaunch = createScriptedEchoLaunch();

    try {
      await expect(
        runtime.archiveThread({
          bridgeLaunch,
          threadId: "t-archive-rejected",
          providerId: "fake",
          providerThreadId: "provider-explicit",
        }),
      ).rejects.toThrow("no rollout found for thread id provider-explicit");
      await expect(
        runtime.unarchiveThread({
          bridgeLaunch,
          threadId: "t-archive-rejected",
          providerId: "fake",
          providerThreadId: "provider-explicit",
        }),
      ).rejects.toThrow(
        "no archived rollout found for thread id provider-explicit",
      );
      expect(record.last("thread/archive")).toBeDefined();
      expect(record.last("thread/unarchive")).toBeDefined();
    } finally {
      await runtime.shutdown();
    }
  });

  function createArchivedSessionRuntime(
    args: {
      env?: Record<string, string>;
      exitAfterArchivedError?: boolean;
      onEvent?: (event: ThreadEvent) => void;
    } = {},
  ): ContractRuntime {
    return createContractRuntime({
      ...(args.env !== undefined ? { env: args.env } : {}),
      ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
      launch: {
        scripted: {
          archivedSession: true,
          ...(args.exitAfterArchivedError === true
            ? { exitAfterArchivedError: true }
            : {}),
        },
      },
    });
  }

  it("unarchives Codex sessions before retrying a turn", async () => {
    const events: ThreadEvent[] = [];
    const { record, runtime } = createArchivedSessionRuntime({
      onEvent: (event) => events.push(event),
    });

    try {
      const { providerThreadId } = await runtime.startThread({
        environmentId: "env-1",
        projectId: "p1",
        providerId: "codex",
        threadId: "t-archived",
        options: fullRuntimeOptions,
      });
      await runtime.runTurn({
        clientRequestId: "creq_222222224u",
        input: [promptTextInput({ text: "continue" })],
        options: fullRuntimeOptions,
        threadId: "t-archived",
      });

      const requests = record.read();
      expect(requests).toContainEqual({
        method: "thread/unarchive",
        params: { threadId: "t-archived", providerThreadId },
      });
      expect(
        requests.filter((entry) => entry.method === "turn/start"),
      ).toHaveLength(2);
      await waitForThreadAgentMessageText({
        events,
        providerId: "codex",
        runtime,
        text: "Response to: continue",
        threadId: "t-archived",
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("unarchives Codex sessions before retrying a resume", async () => {
    const { record, runtime } = createArchivedSessionRuntime();

    try {
      await expect(
        runtime.resumeThread({
          environmentId: "env-1",
          projectId: "p1",
          providerId: "codex",
          providerThreadId: "prov-archived-resume",
          threadId: "t-archived-resume",
          options: fullRuntimeOptions,
        }),
      ).resolves.toEqual({ providerThreadId: "prov-archived-resume" });

      const requests = record.read();
      expect(requests).toContainEqual({
        method: "thread/unarchive",
        params: {
          threadId: "t-archived-resume",
          providerThreadId: "prov-archived-resume",
        },
      });
      expect(
        requests.filter((entry) => entry.method === "thread/resume"),
      ).toHaveLength(2);
    } finally {
      await runtime.shutdown();
    }
  });

  it("unarchives an archived Codex source session before retrying a fork", async () => {
    const { record, runtime } = createArchivedSessionRuntime();

    try {
      await runtime.startThread({
        environmentId: "env-1",
        fork: { sourceProviderThreadId: "prov-archived-source" },
        projectId: "p1",
        providerId: "codex",
        threadId: "t-archived-fork",
        options: fullRuntimeOptions,
      });

      const requests = record.read();
      expect(requests).toContainEqual({
        method: "thread/unarchive",
        params: {
          threadId: "t-archived-fork",
          providerThreadId: "prov-archived-source",
        },
      });
      expect(
        requests.filter((entry) => entry.method === "thread/fork"),
      ).toHaveLength(2);
    } finally {
      await runtime.shutdown();
    }
  });

  it("reports the archived-session error when unarchiving fails", async () => {
    const { record, runtime } = createArchivedSessionRuntime({
      env: scriptedEchoProcessEnv({ unarchiveFails: true }),
    });

    try {
      await expect(
        runtime.resumeThread({
          environmentId: "env-1",
          projectId: "p1",
          providerId: "codex",
          providerThreadId: "prov-unarchive-fails",
          threadId: "t-unarchive-fails",
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow(/session prov-unarchive-fails is archived/);
      const requests = record.read();
      expect(requests).toContainEqual({
        method: "thread/unarchive",
        params: {
          threadId: "t-unarchive-fails",
          providerThreadId: "prov-unarchive-fails",
        },
      });
      expect(
        requests.filter((entry) => entry.method === "thread/resume"),
      ).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps the archived-session error when the provider exits mid-recovery", async () => {
    const { runtime } = createArchivedSessionRuntime({
      exitAfterArchivedError: true,
    });

    try {
      await expect(
        runtime.resumeThread({
          environmentId: "env-1",
          projectId: "p1",
          providerId: "codex",
          providerThreadId: "prov-exit-recovery",
          threadId: "t-exit-recovery",
          options: fullRuntimeOptions,
        }),
      ).rejects.toThrow(/session prov-exit-recovery is archived/);
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects turn steer when providerThreadId cannot be resolved", async () => {
    const events: ThreadEvent[] = [];
    const { runtime } = createContractRuntime({
      onEvent: (event) => events.push(event),
      env: { [UNSOLICITED_TURN_THREAD_ID_ENV]: missingProviderThreadId },
      launch: {
        modulePath: unsolicitedTurnBridgeModulePath,
        pluginId: "provider-unsolicited-turn",
      },
    });

    await registerThreadWithoutProviderThreadId(runtime);
    const { turnId } = await waitForThreadTurnStarted({
      events,
      label: "synthetic active turn without provider identity",
      providerId: "fake",
      runtime,
      threadId: missingProviderThreadId,
      timeoutMs: 1000,
    });
    expect(runtime.getActiveTurnId(missingProviderThreadId)).toBe(turnId);
    await expect(
      runtime.steerTurn({
        clientRequestId: "creq_222222224u",
        threadId: missingProviderThreadId,
        expectedTurnId: turnId,
        input: [promptTextInput({ text: "steer" })],
        options: fullRuntimeOptions,
      }),
    ).rejects.toThrow(missingProviderThreadIdError);
    await runtime.shutdown();
  });

  it("rejects unsupported execution options before they reach the provider", async () => {
    const { record, runtime } = createContractRuntime();

    await expect(
      runtime.startThread({
        environmentId: "env-1",
        threadId: "t1",
        projectId: "p1",
        providerId: "fake",
        options: {
          ...fullRuntimeOptions,
          serviceTier: "fast",
        },
      }),
    ).rejects.toThrow(/does not support service tiers/);
    expect(record.last("thread/start")).toBeUndefined();
    await runtime.shutdown();
  });

  it("interrupts an active turn on stop and releases an idle thread", async () => {
    const events: ThreadEvent[] = [];
    const { record, runtime } = createContractRuntime({
      onEvent: (event) => events.push(event),
    });

    const startResult = await runtime.startThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await expect(runtime.stopThread({ threadId: "t1" })).resolves.toEqual({
      providerCheckpointId: null,
    });
    expect(record.last("thread/stop")?.params).toEqual({
      threadId: "t1",
      providerThreadId: startResult.providerThreadId,
      intent: "release",
      activeTurnId: null,
    });

    expect(runtime.hasThread("t1")).toBe(false);
    await runtime.resumeThread({
      environmentId: "env-1",
      threadId: "t1",
      projectId: "p1",
      providerThreadId: startResult.providerThreadId,
      providerId: "fake",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      clientRequestId: "creq_222222224v",
      threadId: "t1",
      input: [promptTextInput({ text: "delay:500" })],
      options: fullRuntimeOptions,
    });
    const { turnId } = await waitForThreadTurnStarted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
    });
    await runtime.stopThread({ threadId: "t1" });
    expect(record.last("thread/stop")?.params).toEqual({
      threadId: "t1",
      providerThreadId: startResult.providerThreadId,
      intent: "interrupt",
      activeTurnId: "turn-1",
    });
    await waitForThreadTurnCompleted({
      events,
      providerId: "fake",
      runtime,
      threadId: "t1",
      turnId,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        threadId: "t1",
        status: "interrupted",
      }),
    );

    await runtime.shutdown();
  });
});
