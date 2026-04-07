import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@bb/agent-runtime";
import type { AvailableModel, DynamicTool, ThreadExecutionOptions } from "@bb/domain";
import type {
  HostWorkspace,
  ProvisionWorkspaceArgs,
} from "@bb/host-workspace";
import { RuntimeManager } from "../../src/runtime-manager.js";
import { listFilesRecursively } from "../../src/command-handlers/file-list.js";

const tempDirs: string[] = [];

export function createFakeWorkspace(pathname: string) {
  const state = {
    statusReads: 0,
    lastDiffTarget: undefined as
      | { type: "uncommitted" }
      | { type: "branch_committed"; mergeBaseBranch: string }
      | { type: "all"; mergeBaseBranch: string }
      | { type: "commit"; sha: string }
      | undefined,
    lastCommitMessage: undefined as string | undefined,
    resetCount: 0,
    promotedPrimaryPath: undefined as string | undefined,
    demotedPrimaryPath: undefined as string | undefined,
    demotedDefaultBranch: undefined as string | undefined,
    destroyed: false,
    listedModelsProviderId: undefined as string | undefined,
  };
  const workspace = {
    path: pathname,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    async getCurrentBranch() {
      return "main";
    },
    async getHeadSha() {
      return "commit-1";
    },
    async getLocalStateFingerprint() {
      return JSON.stringify({
        currentBranch: "main",
        headSha: "commit-1",
        workingTree: {
          hasUncommittedChanges: false,
          state: "clean",
          changedFiles: 0,
          insertions: 0,
          deletions: 0,
          files: [],
        },
      });
    },
    async getSharedGitRefsFingerprint() {
      return JSON.stringify({
        refs: ["refs/heads/main\u0000commit-1"],
        remoteHead: "refs/remotes/origin/main",
      });
    },
    async getStatus(options?: { mergeBaseBranch?: string }) {
      state.statusReads += 1;
      return {
        workingTree: {
          hasUncommittedChanges: false,
          state: "clean" as const,
          changedFiles: 0,
          insertions: 0,
          deletions: 0,
          files: [],
        },
        branch: {
          currentBranch: "main",
          defaultBranch: "main",
        },
        mergeBase: options?.mergeBaseBranch
          ? {
              mergeBaseBranch: options.mergeBaseBranch,
              baseRef: options.mergeBaseBranch,
              aheadCount: 0,
              behindCount: 0,
              hasCommittedUnmergedChanges: false,
              commits: [],
            }
          : null,
      };
    },
    async getDiff(options?: {
      target?:
        | { type: "uncommitted" }
        | { type: "branch_committed"; mergeBaseBranch: string }
        | { type: "all"; mergeBaseBranch: string }
        | { type: "commit"; sha: string };
    }) {
      state.lastDiffTarget = options?.target;
      return {
        diff: "",
        truncated: false,
        shortstat: "",
        files: "",
      };
    },
    async listBranches() {
      return ["main"];
    },
    async listFiles() {
      return listFilesRecursively(pathname, pathname);
    },
    async commit(options: { message: string; noVerify: boolean }) {
      state.lastCommitMessage = options.message;
      return {
        commitSha: "commit-1",
        commitSubject: options.message,
      };
    },
    async reset() {
      state.resetCount += 1;
    },
    async fetch() {},
    async squashMerge(options: { targetBranch: string; commitMessage: string }) {
      return {
        merged: true,
        commitSha: `merge-${options.targetBranch}`,
        targetBranch: options.targetBranch,
      };
    },
    async promote(primary: HostWorkspace) {
      state.promotedPrimaryPath = primary.path;
    },
    async demote(args: {
      primary: HostWorkspace;
      defaultBranch: string;
      envBranch?: string;
    }) {
      state.demotedPrimaryPath = args.primary.path;
      state.demotedDefaultBranch = args.defaultBranch;
    },
    async destroy() {
      state.destroyed = true;
    },
  } satisfies HostWorkspace;

  return { workspace, state };
}

export function createFakeRuntime() {
  const state = {
    resumedEnvironmentId: undefined as string | undefined,
    startedThreadId: undefined as string | undefined,
    startedEnvironmentId: undefined as string | undefined,
    startedDynamicTools: undefined as DynamicTool[] | undefined,
    startedOptions: undefined as ThreadExecutionOptions | undefined,
    startedInstructions: undefined as string | undefined,
    resumedThreadId: undefined as string | undefined,
    resumedDynamicTools: undefined as DynamicTool[] | undefined,
    resumedOptions: undefined as ThreadExecutionOptions | undefined,
    resumedInstructions: undefined as string | undefined,
    resumedProviderThreadId: undefined as string | undefined,
    ranTurnText: undefined as string | undefined,
    ranTurnOptions: undefined as ThreadExecutionOptions | undefined,
    ranTurnInstructions: undefined as string | undefined,
    steeredTurnId: undefined as string | undefined,
    steeredTurnOptions: undefined as ThreadExecutionOptions | undefined,
    steeredTurnInstructions: undefined as string | undefined,
    stoppedThreadId: undefined as string | undefined,
    renamedTitle: undefined as string | undefined,
    runningProviders: [] as string[],
    shutdownCount: 0,
  };
  const runtime = {
    async ensureProvider() {},
    async startThread(args: {
      dynamicTools?: DynamicTool[];
      environmentId: string;
      instructions?: string;
      options?: ThreadExecutionOptions;
      threadId: string;
    }) {
      state.startedEnvironmentId = args.environmentId;
      state.startedThreadId = args.threadId;
      state.startedDynamicTools = args.dynamicTools;
      state.startedOptions = args.options;
      state.startedInstructions = args.instructions;
      return { providerThreadId: `provider-${args.threadId}` };
    },
    async resumeThread(args: {
      dynamicTools?: DynamicTool[];
      environmentId: string;
      instructions?: string;
      options?: ThreadExecutionOptions;
      providerThreadId?: string;
      threadId: string;
    }) {
      state.resumedEnvironmentId = args.environmentId;
      state.resumedThreadId = args.threadId;
      state.resumedDynamicTools = args.dynamicTools;
      state.resumedOptions = args.options;
      state.resumedInstructions = args.instructions;
      state.resumedProviderThreadId = args.providerThreadId;
      return { providerThreadId: args.providerThreadId ?? `provider-${args.threadId}` };
    },
    async runTurn(args: {
      input: Array<{ text?: string; type: string }>;
      instructions?: string;
      options?: ThreadExecutionOptions;
    }) {
      state.ranTurnText = args.input[0]?.text;
      state.ranTurnOptions = args.options;
      state.ranTurnInstructions = args.instructions;
    },
    async steerTurn(args: {
      expectedTurnId: string;
      instructions?: string;
      options?: ThreadExecutionOptions;
    }) {
      state.steeredTurnId = args.expectedTurnId;
      state.steeredTurnOptions = args.options;
      state.steeredTurnInstructions = args.instructions;
    },
    async stopThread(args: { threadId: string }) {
      state.stoppedThreadId = args.threadId;
    },
    async renameThread(args: { title: string }) {
      state.renamedTitle = args.title;
    },
    listRunningProviders() {
      return state.runningProviders;
    },
    async listModels(args: { providerId: string }) {
      state.listedModelsProviderId = args.providerId;
      return [] satisfies AvailableModel[];
    },
    async shutdown() {
      state.shutdownCount += 1;
    },
  };

  return {
    runtime: runtime satisfies AgentRuntime,
    state,
  };
}

export function createHarness(args: {
  workspacePath?: string;
  currentBranch?: string;
  isWorktree?: boolean;
} = {}) {
  const { workspace, state: workspaceState } = createFakeWorkspace(
    args.workspacePath ?? "/tmp/env-1",
  );
  workspace.getCurrentBranch = async () => args.currentBranch ?? "main";
  workspace.isWorktree = args.isWorktree ?? false;
  const { runtime, state: runtimeState } = createFakeRuntime();
  const provisions: ProvisionWorkspaceArgs[] = [];
  const manager = new RuntimeManager({
    provisionWorkspace: async (options) => {
      provisions.push(options);
      if ("path" in options && options.path !== workspace.path) {
        return createFakeWorkspace(options.path).workspace;
      }
      return workspace;
    },
    createRuntime: () => runtime,
  });

  return {
    manager,
    provisions,
    runtimeState,
    workspaceState,
    workspace,
  };
}

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
}
