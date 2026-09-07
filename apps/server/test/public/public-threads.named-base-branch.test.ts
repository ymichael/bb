import { getThread } from "@bb/db";
import { threadSchema, type GitSourceInspection } from "@bb/domain";
import type { HostDaemonRpcCommand } from "@bb/host-daemon-contract";
import { threadResponseSchema } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import {
  registerTestHostRpcCapture,
  requireManagedWorktreeEnvironmentProvisionLiveCommand,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const SOURCE_PATH = "/tmp/named-base-branch-source";

function buildCheckout(
  defaultBranchRelation: GitSourceInspection["defaultBranchRelation"],
): GitSourceInspection {
  return {
    checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
    defaultBranch: "main",
    defaultBranchRelation,
    hasUncommittedChanges: false,
    operation: { kind: "none" },
    originDefaultBranch: "origin/main",
  };
}

async function createNamedBaseBranchThread(
  harness: TestAppHarness,
  args: {
    baseBranch: string;
    defaultBranchRelation: GitSourceInspection["defaultBranchRelation"];
    onInspectGitSource?: (
      command: Extract<
        HostDaemonRpcCommand,
        { type: "host.inspect_git_source" }
      >,
    ) => void;
  },
): Promise<string | null> {
  const { host, session } = seedHostSession(harness.deps);
  seedPrimaryHost(harness.deps, host.id);
  registerTestHostRpcCapture(harness, {
    hostId: host.id,
    sessionId: session.id,
    gitSourceInspectionResult: buildCheckout(args.defaultBranchRelation),
    ...(args.onInspectGitSource
      ? { onInspectGitSource: args.onInspectGitSource }
      : {}),
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: SOURCE_PATH,
  });

  const response = await harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin: "sdk",
      projectId: project.id,
      providerId: "codex",
      input: [{ type: "text", text: "Spawn a thread" }],
      environment: {
        type: "host",
        hostId: host.id,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "named", name: args.baseBranch },
        },
      },
    }),
  });
  expect(response.status).toBe(201);
  threadSchema.parse(await readJson(response));
  const queued = await waitForQueuedCommand(
    harness,
    ({ command }) => command.type === "environment.provision",
  );
  return requireManagedWorktreeEnvironmentProvisionLiveCommand(queued).command
    .baseBranch;
}

describe("named managed-worktree base branch", () => {
  it("preserves a named default branch without inspecting or reinterpreting it", async () => {
    await withTestHarness(async (harness) => {
      const onInspectGitSource = vi.fn();
      await expect(
        createNamedBaseBranchThread(harness, {
          baseBranch: "main",
          defaultBranchRelation: "local-behind",
          onInspectGitSource,
        }),
      ).resolves.toBe("main");
      expect(onInspectGitSource).not.toHaveBeenCalled();
    });
  });

  it("keeps the named default branch when local is ahead of origin", async () => {
    await withTestHarness(async (harness) => {
      await expect(
        createNamedBaseBranchThread(harness, {
          baseBranch: "main",
          defaultBranchRelation: "local-ahead",
        }),
      ).resolves.toBe("main");
    });
  });

  it("passes a named non-default branch through unchanged", async () => {
    await withTestHarness(async (harness) => {
      await expect(
        createNamedBaseBranchThread(harness, {
          baseBranch: "release/2026-05",
          defaultBranchRelation: "local-behind",
        }),
      ).resolves.toBe("release/2026-05");
    });
  });

  it("does not inspect an origin-qualified branch before provisioning", async () => {
    await withTestHarness(async (harness) => {
      const onInspectGitSource = vi.fn();
      await expect(
        createNamedBaseBranchThread(harness, {
          baseBranch: "origin/main",
          defaultBranchRelation: "local-behind",
          onInspectGitSource,
        }),
      ).resolves.toBe("origin/main");
      expect(onInspectGitSource).not.toHaveBeenCalled();
    });
  });

  it("passes a fork's explicitly named base branch through unchanged", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
        gitSourceInspectionResult: buildCheckout("local-behind"),
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: SOURCE_PATH,
      });
      const environment = seedEnvironment(harness.deps, {
        branchName: "feature/source",
        hostId: host.id,
        path: SOURCE_PATH,
        projectId: project.id,
      });
      const sourceThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        permissionMode: "full",
        providerThreadId: "provider-fork-source",
        threadId: sourceThread.id,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-fork-source",
        sequence: 3,
        threadId: sourceThread.id,
        turnId: "turn-fork-source",
      });

      const response = await harness.app.request("/api/v1/threads/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceThreadId: sourceThread.id,
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "named", name: "main" },
            },
          },
        }),
      });
      expect(response.status).toBe(201);
      const fork = threadResponseSchema.parse(await readJson(response));
      const forkEnvironmentId = getThread(harness.db, fork.id)?.environmentId;
      expect(forkEnvironmentId).not.toBeNull();
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === forkEnvironmentId,
      );
      expect(
        requireManagedWorktreeEnvironmentProvisionLiveCommand(queued).command
          .baseBranch,
      ).toBe("main");
    });
  });
});
