import type { JsonValue } from "@bb/domain";
import { threadSchema, type GitSourceInspection } from "@bb/domain";
import type { HostDaemonRpcCommand } from "@bb/host-daemon-contract";
import { threadResponseSchema } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import { registerTestHostRpcCapture } from "../helpers/commands.js";
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
import { installFakeGitWorktreeProvider } from "../helpers/environment-provider.js";

const SOURCE_PATH = "/tmp/named-base-branch-source";

function buildCheckout(
  defaultBranchRelation: GitSourceInspection["defaultBranchRelation"],
): GitSourceInspection {
  return {
    isWorktree: false,
    checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
    defaultBranch: "main",
    defaultBranchRelation,
    hasUncommittedChanges: false,
    operation: { kind: "none" },
    originDefaultBranch: "origin/main",
  };
}

function buildDetachedSingleBranchCheckout(): GitSourceInspection {
  return {
    isWorktree: false,
    checkout: { kind: "detached", headSha: "abc123" },
    defaultBranch: null,
    defaultBranchRelation: null,
    hasUncommittedChanges: false,
    operation: { kind: "none" },
    originDefaultBranch: null,
  };
}

async function createNamedBaseBranchThread(
  harness: TestAppHarness,
  args: {
    baseBranch: string;
    onInspectGitSource?: (
      command: Extract<
        HostDaemonRpcCommand,
        { type: "host.inspect_git_source" }
      >,
    ) => void;
  },
): Promise<JsonValue> {
  const provider = installFakeGitWorktreeProvider();
  const { host, session } = seedHostSession(harness.deps);
  seedPrimaryHost(harness.deps, host.id);
  registerTestHostRpcCapture(harness, {
    hostId: host.id,
    sessionId: session.id,
    gitSourceInspectionResult: buildCheckout("local-behind"),
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
  const context = await provider.waitForProvision();
  return context.inputs;
}

describe("named managed-worktree base branch", () => {
  it("accepts an explicit base for a detached single-branch checkout", async () => {
    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
        gitSourceInspectionResult: buildDetachedSingleBranchCheckout(),
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: SOURCE_PATH,
      });

      const availabilityResponse = await harness.app.request(
        `/api/v1/system/environment-providers?projectId=${project.id}&hostId=${host.id}`,
      );
      expect(availabilityResponse.status).toBe(200);
      const availability = (await readJson(availabilityResponse)) as {
        providers: Array<{ id: string; availability: unknown }>;
      };
      expect(
        availability.providers.find(
          (candidate) => candidate.id === "git-worktree",
        )?.availability,
      ).toEqual({ status: "available" });

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
              baseBranch: { kind: "named", name: "v1.0" },
            },
          },
        }),
      });
      expect(response.status).toBe(201);
      threadSchema.parse(await readJson(response));
      const context = await provider.waitForProvision();
      expect(context.inputs).toEqual({
        branch: { kind: "named", name: "v1.0" },
      });
    });
  });

  it("checks checkout eligibility before handing the named branch to the worktree provider", async () => {
    await withTestHarness(async (harness) => {
      const onInspectGitSource = vi.fn();
      const inputs = await createNamedBaseBranchThread(harness, {
        baseBranch: "main",
        onInspectGitSource,
      });
      expect(inputs).toEqual({ branch: { kind: "named", name: "main" } });
      expect(onInspectGitSource).toHaveBeenCalledWith({
        type: "host.inspect_git_source",
        path: SOURCE_PATH,
        remoteRefresh: "background",
      });
    });
  });

  it("passes a named non-default branch through unchanged", async () => {
    await withTestHarness(async (harness) => {
      await expect(
        createNamedBaseBranchThread(harness, {
          baseBranch: "release/2026-05",
        }),
      ).resolves.toEqual({
        branch: { kind: "named", name: "release/2026-05" },
      });
    });
  });

  it("does not reinterpret an origin-qualified branch", async () => {
    await withTestHarness(async (harness) => {
      const onInspectGitSource = vi.fn();
      const inputs = await createNamedBaseBranchThread(harness, {
        baseBranch: "origin/main",
        onInspectGitSource,
      });
      expect(inputs).toEqual({
        branch: { kind: "named", name: "origin/main" },
      });
      expect(onInspectGitSource).toHaveBeenCalledWith({
        type: "host.inspect_git_source",
        path: SOURCE_PATH,
        remoteRefresh: "background",
      });
    });
  });

  it("passes a fork's explicitly named base branch through unchanged", async () => {
    await withTestHarness(async (harness) => {
      const provider = installFakeGitWorktreeProvider();
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
      const context = await provider.waitForProvision();
      expect(context.thread.id).toBe(fork.id);
      expect(context.host?.id).toBe(host.id);
      expect(context.inputs).toEqual({
        branch: { kind: "named", name: "main" },
      });
    });
  });
});
