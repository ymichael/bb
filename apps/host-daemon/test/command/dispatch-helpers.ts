import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentRuntime,
  AgentRuntimeBridgeLaunch,
  AgentRuntimeProviderSession,
} from "@bb/agent-runtime";
import type {
  ClientTurnRequestId,
  AvailableModel,
  DynamicTool,
  GitHostPullRequest,
  PromptInput,
} from "@bb/domain";
import type { HostDaemonBridgeLaunch } from "@bb/host-daemon-contract";
import { makeWorkspaceMergeBase, makeWorkspaceStatus } from "@bb/test-helpers";
import type {
  HostWorkspace,
  ProvisionWorkspaceArgs,
  PullRequestActionOptions,
} from "@bb/host-workspace";
import { RuntimeManager } from "../../src/runtime-manager.js";
import { listFilesRecursively } from "../../src/command-handlers/file-list.js";
import { noopEventSink } from "../../src/command-dispatch-support.js";
import type { CommandDispatchOptions } from "../../src/command-dispatch-support.js";
import type { FetchProjectAttachment } from "../../src/project-attachments.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);
export const silentLogger: CommandDispatchOptions["logger"] = {
  debug: () => undefined,
  warn: () => undefined,
};

export const unexpectedProjectAttachmentFetch: FetchProjectAttachment =
  async () => {
    throw new Error("Unexpected project attachment fetch");
  };

export const unexpectedProviderMaintenance: Pick<
  CommandDispatchOptions,
  | "listModels"
  | "providerHealth"
  | "providerUsage"
  | "providerInstallationStatus"
  | "providerInstallationRun"
  | "refreshShellEnv"
> = {
  listModels: async () => {
    throw new Error("Unexpected provider.list_models call");
  },
  providerHealth: async () => {
    throw new Error("Unexpected provider.health call");
  },
  providerUsage: async () => {
    throw new Error("Unexpected provider.usage call");
  },
  providerInstallationStatus: async () => {
    throw new Error("Unexpected provider.installation.status call");
  },
  providerInstallationRun: async () => {
    throw new Error("Unexpected provider.installation.run call");
  },
  refreshShellEnv: async () => undefined,
};

type GitCommandArgs = string[];

interface RunGitCommandOptions {
  cwd: string;
}

type FakeWorkspaceDiffTarget =
  | { type: "uncommitted" }
  | { type: "branch_committed"; mergeBaseBranch: string }
  | { type: "all"; mergeBaseBranch: string }
  | { type: "commit"; sha: string };

interface FakeWorkspaceState {
  destroyed: boolean;
  lastCommitMessage: string | undefined;
  lastDiffTarget: FakeWorkspaceDiffTarget | undefined;
  lastPullRequestAction: PullRequestActionOptions | undefined;
  pullRequestActionShellPath: string | undefined;
  pullRequest: GitHostPullRequest | null;
  pullRequestLookupError: string | null;
  pullRequestLookupShellPath: string | undefined;
  statusReads: number;
}

interface FakeRuntimeThreadControls {
  clearProviderSession: (threadId: string) => void;
  endActiveTurn: (threadId: string) => void;
  setActiveTurn: (threadId: string, turnId: string) => void;
  setProviderSession: (
    threadId: string,
    session: AgentRuntimeProviderSession,
  ) => void;
}

interface FakeRuntimeState {
  archivedBridgeLaunch: AgentRuntimeBridgeLaunch | undefined;
  archivedProviderId: string | undefined;
  archivedProviderThreadId: string | undefined;
  archivedThreadId: string | undefined;
  ranTurnClientRequestId: ClientTurnRequestId | undefined;
  ranTurnInput: PromptInput[] | undefined;
  ranTurnText: string | undefined;
  renamedTitle: string | undefined;
  resumedBridgeLaunch: AgentRuntimeBridgeLaunch | undefined;
  resumedEnvironmentId: string | undefined;
  resumedProviderThreadId: string | undefined;
  resumedThreadId: string | undefined;
  runningProviders: string[];
  shutdownCount: number;
  startedDynamicTools: DynamicTool[] | undefined;
  startedBridgeLaunch: AgentRuntimeBridgeLaunch | undefined;
  startedEnvironmentId: string | undefined;
  startedInput: PromptInput[] | undefined;
  startedInputGroups: PromptInput[][] | undefined;
  startedInstructions: string | undefined;
  startedThreadId: string | undefined;
  steeredClientRequestId: ClientTurnRequestId | undefined;
  steeredTurnId: string | undefined;
  steeredTurnInstructions: string | undefined;
  stoppedThreadId: string | undefined;
  unarchivedBridgeLaunch: AgentRuntimeBridgeLaunch | undefined;
  unarchivedProviderId: string | undefined;
  unarchivedProviderThreadId: string | undefined;
  unarchivedThreadId: string | undefined;
}

type FakeHostWorkspace = {
  -readonly [K in keyof HostWorkspace]: HostWorkspace[K];
};

export function createFakeWorkspace(pathname: string) {
  const state: FakeWorkspaceState = {
    statusReads: 0,
    lastDiffTarget: undefined,
    lastCommitMessage: undefined,
    destroyed: false,
    lastPullRequestAction: undefined,
    pullRequestActionShellPath: undefined,
    pullRequest: null,
    pullRequestLookupError: null,
    pullRequestLookupShellPath: undefined,
  };
  const workspace: FakeHostWorkspace = {
    path: pathname,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    async getDefaultBranch() {
      return "main";
    },
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
    async getAdditionalWorkspaceWriteRoots() {
      return [];
    },
    async getStatus(options?: { mergeBaseBranch?: string }) {
      state.statusReads += 1;
      return makeWorkspaceStatus({
        mergeBase: options?.mergeBaseBranch
          ? makeWorkspaceMergeBase({
              mergeBaseBranch: options.mergeBaseBranch,
              baseRef: options.mergeBaseBranch,
            })
          : null,
      });
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
        mergeBaseRef: null,
      };
    },
    async diffFiles() {
      return {
        files: [],
        shortstat: "",
        mergeBaseRef: null,
        truncated: false,
      };
    },
    async diffPatch() {
      return [];
    },
    async getPullRequest(options) {
      state.pullRequestLookupShellPath = options?.shellPath;
      if (state.pullRequestLookupError !== null) {
        return {
          outcome: "unavailable" as const,
          message: state.pullRequestLookupError,
        };
      }
      return state.pullRequest === null
        ? { outcome: "none" as const }
        : { outcome: "found" as const, pullRequest: state.pullRequest };
    },
    async runPullRequestAction(action, options) {
      state.lastPullRequestAction = action;
      state.pullRequestActionShellPath = options?.shellPath;
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
    async reset() {},
    async destroy() {
      state.destroyed = true;
    },
  };

  return { workspace, state };
}

export function createFakeRuntime() {
  const state: FakeRuntimeState = {
    archivedBridgeLaunch: undefined,
    archivedProviderId: undefined,
    archivedProviderThreadId: undefined,
    archivedThreadId: undefined,
    ranTurnClientRequestId: undefined,
    ranTurnInput: undefined,
    ranTurnText: undefined,
    renamedTitle: undefined,
    resumedBridgeLaunch: undefined,
    resumedEnvironmentId: undefined,
    resumedProviderThreadId: undefined,
    resumedThreadId: undefined,
    runningProviders: [],
    shutdownCount: 0,
    startedDynamicTools: undefined,
    startedBridgeLaunch: undefined,
    startedEnvironmentId: undefined,
    startedInput: undefined,
    startedInputGroups: undefined,
    startedInstructions: undefined,
    startedThreadId: undefined,
    steeredClientRequestId: undefined,
    steeredTurnId: undefined,
    steeredTurnInstructions: undefined,
    stoppedThreadId: undefined,
    unarchivedBridgeLaunch: undefined,
    unarchivedProviderId: undefined,
    unarchivedProviderThreadId: undefined,
    unarchivedThreadId: undefined,
  };
  const activeTurnsByThreadId = new Map<string, string>();
  const providerSessionsByThreadId = new Map<
    string,
    AgentRuntimeProviderSession
  >();
  let nextTurnNumber = 1;
  const threadControls: FakeRuntimeThreadControls = {
    clearProviderSession(threadId) {
      providerSessionsByThreadId.delete(threadId);
    },
    endActiveTurn(threadId) {
      activeTurnsByThreadId.delete(threadId);
    },
    setActiveTurn(threadId, turnId) {
      if (!providerSessionsByThreadId.has(threadId)) {
        providerSessionsByThreadId.set(threadId, {
          providerId: "fake",
          providerThreadId: `provider-${threadId}`,
        });
      }
      activeTurnsByThreadId.set(threadId, turnId);
    },
    setProviderSession(threadId, session) {
      providerSessionsByThreadId.set(threadId, session);
    },
  };
  const runtime: AgentRuntime = {
    async ensureProvider() {},
    async startThread(args) {
      state.startedBridgeLaunch = args.bridgeLaunch;
      state.startedEnvironmentId = args.environmentId;
      state.startedThreadId = args.threadId;
      state.startedDynamicTools = args.dynamicTools;
      state.startedInput = args.input;
      state.startedInputGroups = args.inputGroups;
      state.startedInstructions = args.instructions;
      providerSessionsByThreadId.set(args.threadId, {
        providerId: args.providerId,
        providerThreadId: `provider-${args.threadId}`,
      });
      if (args.input && args.input.length > 0) {
        activeTurnsByThreadId.set(args.threadId, `turn-${nextTurnNumber++}`);
      }
      return { providerThreadId: `provider-${args.threadId}` };
    },
    async prepareThreadRewind(args) {
      return {
        providerThreadId: `provider-rewind-${args.threadId}-${args.leaseId}`,
      };
    },
    async discardThreadRewind() {},
    async resumeThread(args) {
      state.resumedBridgeLaunch = args.bridgeLaunch;
      state.resumedEnvironmentId = args.environmentId;
      state.resumedThreadId = args.threadId;
      state.resumedProviderThreadId = args.providerThreadId;
      const providerThreadId =
        args.providerThreadId ?? `provider-${args.threadId}`;
      providerSessionsByThreadId.set(args.threadId, {
        providerId: args.providerId,
        providerThreadId,
      });
      return { providerThreadId };
    },
    async runTurn(args) {
      const firstInput = args.input[0];
      state.ranTurnText =
        firstInput?.type === "text" ? firstInput.text : undefined;
      state.ranTurnClientRequestId = args.clientRequestId;
      state.ranTurnInput = args.input;
      activeTurnsByThreadId.set(args.threadId, `turn-${nextTurnNumber++}`);
    },
    async steerTurn(args) {
      state.steeredTurnId = args.expectedTurnId;
      state.steeredClientRequestId = args.clientRequestId;
      state.steeredTurnInstructions = args.instructions;
      return { status: "steered" };
    },
    async stopThread(args) {
      state.stoppedThreadId = args.threadId;
      activeTurnsByThreadId.delete(args.threadId);
      providerSessionsByThreadId.delete(args.threadId);
      return { providerCheckpointId: null };
    },
    async clearThreadGoal() {
      return { cleared: true };
    },
    async renameThread(args) {
      state.renamedTitle = args.title;
    },
    async archiveThread(args) {
      state.archivedThreadId = args.threadId;
      state.archivedProviderId = args.providerId;
      state.archivedProviderThreadId = args.providerThreadId;
      state.archivedBridgeLaunch = args.bridgeLaunch;
      activeTurnsByThreadId.delete(args.threadId);
      providerSessionsByThreadId.delete(args.threadId);
    },
    async unarchiveThread(args) {
      state.unarchivedThreadId = args.threadId;
      state.unarchivedProviderId = args.providerId;
      state.unarchivedProviderThreadId = args.providerThreadId;
      state.unarchivedBridgeLaunch = args.bridgeLaunch;
    },
    listRunningProviders() {
      return state.runningProviders;
    },
    getActiveTurnId(threadId) {
      return activeTurnsByThreadId.get(threadId) ?? null;
    },
    async waitForActiveTurn(threadId) {
      return activeTurnsByThreadId.get(threadId) ?? null;
    },
    getProviderSession(threadId) {
      return providerSessionsByThreadId.get(threadId) ?? null;
    },
    async reapIdleProviderSessions() {
      return { reapedSessions: [] };
    },
    hasThread(threadId) {
      return providerSessionsByThreadId.has(threadId);
    },
    getLiveThreadIds() {
      return [...activeTurnsByThreadId.keys()];
    },
    hasOpenBackgroundWork() {
      return false;
    },
    async listModels() {
      return {
        models: [] satisfies AvailableModel[],
        selectedOnlyModels: [] satisfies AvailableModel[],
      };
    },
    async providerHealth() {
      return { supported: false as const };
    },
    async providerUsage() {
      return { supported: false as const };
    },
    async providerInstallationStatus() {
      throw new Error("Unexpected provider installation status call");
    },
    async providerInstallationRun() {
      throw new Error("Unexpected provider installation run call");
    },
    async shutdown() {
      state.shutdownCount += 1;
    },
  };

  return {
    runtime,
    state,
    threadControls,
  };
}

export function createHarness(
  args: {
    workspacePath?: string;
    currentBranch?: string;
    isWorktree?: boolean;
  } = {},
) {
  const { workspace, state: workspaceState } = createFakeWorkspace(
    args.workspacePath ?? "/tmp/env-1",
  );
  workspace.getCurrentBranch = async () => args.currentBranch ?? "main";
  workspace.isWorktree = args.isWorktree ?? false;
  let provisionedWorkspace: HostWorkspace = workspace;
  const { runtime, state: runtimeState, threadControls } = createFakeRuntime();
  const provisions: ProvisionWorkspaceArgs[] = [];
  const manager = new RuntimeManager({
    provisionWorkspace: async (options) => {
      provisions.push(options);
      if ("path" in options && options.path !== workspace.path) {
        return createFakeWorkspace(options.path).workspace;
      }
      return provisionedWorkspace;
    },
    createRuntime: () => runtime,
  });

  return {
    manager,
    provisions,
    runtime,
    runtimeState,
    threadControls,
    workspaceState,
    workspace,
    setProvisionedWorkspace(nextWorkspace: HostWorkspace): void {
      provisionedWorkspace = nextWorkspace;
    },
    dispatchOptions(
      overrides: { dataDir?: string; threadStorageRootPath?: string } = {},
    ): CommandDispatchOptions {
      return {
        dataDir: overrides.dataDir ?? DISPATCH_TEST_DATA_DIR,
        logger: silentLogger,
        eventSink: noopEventSink,
        fetchProjectAttachment: unexpectedProjectAttachmentFetch,
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath:
          overrides.threadStorageRootPath ?? "/tmp/bb-test-thread-storage",
      };
    },
  };
}

export function makeDispatchOptions(
  overrides: Partial<CommandDispatchOptions> &
    Pick<CommandDispatchOptions, "runtimeManager">,
): CommandDispatchOptions {
  return {
    dataDir: DISPATCH_TEST_DATA_DIR,
    logger: silentLogger,
    eventSink: noopEventSink,
    fetchProjectAttachment: unexpectedProjectAttachmentFetch,
    fetchPluginHostArtifact: fetchDispatchTestArtifact,
    ...unexpectedProviderMaintenance,
    threadStorageRootPath: "/tmp/bb-test-thread-storage",
    ...overrides,
  };
}

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function runGitCommand(
  args: GitCommandArgs,
  options: RunGitCommandOptions,
): Promise<void> {
  await execFileAsync("git", args, { cwd: options.cwd });
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
}

export const DISPATCH_TEST_ARTIFACT_BYTES = Buffer.from(
  "export const bridge = true;\n",
);
const DISPATCH_TEST_ARTIFACT_DIGEST = createHash("sha256")
  .update(DISPATCH_TEST_ARTIFACT_BYTES)
  .digest("hex");
const DISPATCH_TEST_DATA_DIR = "/tmp/bb-test-data";

export const fetchDispatchTestArtifact = async (): Promise<Uint8Array> =>
  new Uint8Array(DISPATCH_TEST_ARTIFACT_BYTES);

export const DISPATCH_TEST_BRIDGE_LAUNCH: HostDaemonBridgeLaunch = {
  pluginId: "provider-pi",
  source: {
    kind: "artifact",
    digest: DISPATCH_TEST_ARTIFACT_DIGEST,
    byteLength: DISPATCH_TEST_ARTIFACT_BYTES.byteLength,
  },
  providerOptions: {},
  envPassthrough: [],
  capabilities: {
    providerInstallation: false,
    supportsServiceTier: true,
    permissionModes: ["accept-edits", "auto", "full"],
    supportsThreadArchive: true,
    supportsThreadRename: true,
    fork: "checkpoint",
  },
};

export function dispatchTestRuntimeBridgeLaunch(
  dataDir: string = DISPATCH_TEST_DATA_DIR,
): AgentRuntimeBridgeLaunch {
  return {
    pluginId: "provider-pi",
    dataDir: path.join(dataDir, "plugins", "provider-pi", "bridge-data"),
    source: {
      kind: "artifact",
      digest: DISPATCH_TEST_ARTIFACT_DIGEST,
      artifactPath: path.join(
        dataDir,
        "plugin-host-artifacts",
        "provider-pi",
        DISPATCH_TEST_ARTIFACT_DIGEST,
        "host.mjs",
      ),
    },
    capabilities: DISPATCH_TEST_BRIDGE_LAUNCH.capabilities,
    providerOptions: {},
    envPassthrough: [],
  };
}

export const DISPATCH_TEST_RUNTIME_BRIDGE_LAUNCH: AgentRuntimeBridgeLaunch =
  dispatchTestRuntimeBridgeLaunch();
