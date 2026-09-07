import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { hostDaemonSessions } from "@bb/db";
import {
  hostDaemonCommandSchema,
  hostDaemonOnlineRpcResponseMessageSchema,
  hostDaemonRpcCommandSchema,
  hostDaemonServerWsMessageSchema,
  parseHostDaemonRpcResultForCommand,
} from "@bb/host-daemon-contract";
import { type HostType, type ThreadEvent } from "@bb/domain";
import type {
  HostDaemonCommand,
  HostDaemonEventEnvelope,
  HostDaemonOnlineRpcResult,
  HostDaemonOnlineRpcRequestMessage,
  HostDaemonRpcCommand,
  HostDaemonRpcResultForCommand,
} from "@bb/host-daemon-contract";
import type { TestAppHarness } from "./test-app.js";
import { availableModelFixture } from "./available-models.js";
import { createTestDaemonHostKey } from "./test-app.js";

interface CapturedRpcRow {
  completedAt: number | null;
  createdAt: number;
  cursor: number;
  fetchedAt: number;
  hostId: string;
  id: string;
  payload: string;
  resultPayload: string | null;
  retryCount: number;
  sessionId: string | null;
  state: string;
  type: string;
}

type QueuedCommandPayload = HostDaemonRpcCommand;
type QueuedCommandResult<TCommand extends QueuedCommandPayload> =
  HostDaemonRpcResultForCommand<TCommand>;

export interface QueuedCommand<
  TCommand extends QueuedCommandPayload = QueuedCommandPayload,
> {
  command: TCommand;
  row: CapturedRpcRow;
  rpcRequest?: HostDaemonOnlineRpcRequestMessage;
}

export function listQueuedCommands(
  harness: TestAppHarness,
  type: HostDaemonRpcCommand["type"],
): HostDaemonRpcCommand[] {
  return pendingHostRpcRequests
    .filter(
      (queued) =>
        isCapturedRpcForHarness(harness, queued) &&
        queued.command.type === type,
    )
    .map((queued) => hostDaemonRpcCommandSchema.parse(queued.command));
}

type ManagedWorktreeEnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.provision"; workspaceProvisionType: "managed-worktree" }
>;

type ManagedWorktreeEnvironmentProvisionLiveCommand =
  QueuedCommand<ManagedWorktreeEnvironmentProvisionCommand>;

function isManagedWorktreeEnvironmentProvisionLiveCommand(
  queued: QueuedCommand,
): queued is ManagedWorktreeEnvironmentProvisionLiveCommand {
  return (
    queued.command.type === "environment.provision" &&
    queued.command.workspaceProvisionType === "managed-worktree"
  );
}

export function requireManagedWorktreeEnvironmentProvisionLiveCommand(
  queued: QueuedCommand,
): ManagedWorktreeEnvironmentProvisionLiveCommand {
  if (isManagedWorktreeEnvironmentProvisionLiveCommand(queued)) {
    return queued;
  }
  throw new Error("Expected managed-worktree environment.provision command");
}

export function listQueuedThreadCommands(
  harness: TestAppHarness,
  type: HostDaemonCommand["type"],
  threadId: string,
): HostDaemonCommand[] {
  return pendingHostRpcRequests
    .filter(
      (queued) =>
        isCapturedRpcForHarness(harness, queued) &&
        queued.command.type === type &&
        "threadId" in queued.command &&
        queued.command.threadId === threadId,
    )
    .map((queued) => hostDaemonCommandSchema.parse(queued.command));
}

export function listQueuedEnvironmentCommands(
  harness: TestAppHarness,
  type: HostDaemonCommand["type"],
  environmentId: string,
): HostDaemonCommand[] {
  return pendingHostRpcRequests
    .filter(
      (queued) =>
        isCapturedRpcForHarness(harness, queued) &&
        queued.command.type === type &&
        "environmentId" in queued.command &&
        queued.command.environmentId === environmentId,
    )
    .map((queued) => hostDaemonCommandSchema.parse(queued.command));
}

const pendingHostRpcRequests: QueuedCommand[] = [];
const testRpcCursorByHost = new Map<string, number>();

interface RegisterTestHostRpcCaptureArgs {
  hostId: string;
  sessionId: string;
  queueBranchOptions?: boolean;
  gitBranchOptionsResult?: HostDaemonOnlineRpcResult<"host.list_branch_options">;
  onListBranchOptions?: (
    command: Extract<
      HostDaemonRpcCommand,
      { type: "host.list_branch_options" }
    >,
  ) => void;
  gitSourceInspectionResult?: HostDaemonOnlineRpcResult<"host.inspect_git_source">;
  onInspectGitSource?: (
    command: Extract<HostDaemonRpcCommand, { type: "host.inspect_git_source" }>,
  ) => void;
}

export interface TestHostRpcSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

function isRuntimeWorkspaceFileCommand(command: HostDaemonRpcCommand): boolean {
  if (command.type === "host.list_files") {
    return command.path.endsWith(path.join(".bb", "skills"));
  }
  if (command.type !== "host.read_file") return false;
  return (
    command.path.endsWith(path.join(".bb", "AGENTS.md")) ||
    command.path.includes(`${path.sep}.bb${path.sep}skills${path.sep}`)
  );
}

function respondToRuntimeWorkspaceFileCommand(
  deps: Pick<TestAppHarness, "hub">,
  args: RegisterTestHostRpcCaptureArgs,
  message: HostDaemonOnlineRpcRequestMessage,
): boolean {
  const command = message.command;
  if (!isRuntimeWorkspaceFileCommand(command)) return false;

  if (command.type === "host.list_files") {
    let files: Array<{ name: string; path: string }> = [];
    try {
      files = readdirSync(command.path, { withFileTypes: true })
        .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory())
        .flatMap((entry) => {
          const skillFilePath = path.join(command.path, entry.name, "SKILL.md");
          try {
            return lstatSync(skillFilePath).isFile()
              ? [{ name: "SKILL.md", path: `${entry.name}/SKILL.md` }]
              : [];
          } catch {
            return [];
          }
        })
        .slice(0, command.limit);
    } catch {
      files = [];
    }
    deps.hub.recordHostOnlineRpcResponse({
      message: hostDaemonOnlineRpcResponseMessageSchema.parse({
        type: "host-rpc.response",
        requestId: message.requestId,
        commandType: command.type,
        ok: true,
        result: { files, truncated: false },
      }),
      sessionId: args.sessionId,
    });
    return true;
  }

  if (command.type !== "host.read_file") return false;
  let bytes: Buffer;
  let modifiedAtMs: number;
  try {
    const stat = lstatSync(command.path);
    bytes = readFileSync(command.path);
    modifiedAtMs = stat.mtimeMs;
  } catch {
    deps.hub.recordHostOnlineRpcResponse({
      message: {
        type: "host-rpc.response",
        requestId: message.requestId,
        commandType: command.type,
        ok: false,
        errorCode: "ENOENT",
        errorMessage: `Path does not exist: ${command.path}`,
      },
      sessionId: args.sessionId,
    });
    return true;
  }
  const contentEncoding = isUtf8(bytes) ? "utf8" : "base64";
  deps.hub.recordHostOnlineRpcResponse({
    message: hostDaemonOnlineRpcResponseMessageSchema.parse({
      type: "host-rpc.response",
      requestId: message.requestId,
      commandType: command.type,
      ok: true,
      result: {
        path: command.path,
        content: bytes.toString(contentEncoding),
        contentEncoding,
        modifiedAtMs,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
      },
    }),
    sessionId: args.sessionId,
  });
  return true;
}

function respondToProviderModelListCommand(
  deps: Pick<TestAppHarness, "hub">,
  args: RegisterTestHostRpcCaptureArgs,
  message: HostDaemonOnlineRpcRequestMessage,
): boolean {
  if (message.command.type !== "provider.list_models") return false;

  deps.hub.recordHostOnlineRpcResponse({
    message: hostDaemonOnlineRpcResponseMessageSchema.parse({
      type: "host-rpc.response",
      requestId: message.requestId,
      commandType: message.command.type,
      ok: true,
      result: {
        models: [
          availableModelFixture({
            model: "test-provider-default",
            reasoningLevels: ["low", "medium", "high"],
            defaultReasoningLevel: "medium",
            isDefault: true,
          }),
        ],
        selectedOnlyModels: [],
      },
    }),
    sessionId: args.sessionId,
  });
  return true;
}

function buildDefaultGitSourceInspectionResult(): HostDaemonOnlineRpcResult<"host.inspect_git_source"> {
  return {
    checkout: {
      kind: "branch",
      branchName: "main",
      headSha: "abc123",
    },
    defaultBranch: "main",
    defaultBranchRelation: "equal",
    hasUncommittedChanges: false,
    operation: { kind: "none" },
    originDefaultBranch: "origin/main",
  };
}

function buildDefaultGitBranchOptionsResult(
  selectedBranch: string | undefined,
): HostDaemonOnlineRpcResult<"host.list_branch_options"> {
  return {
    branches: ["main"],
    branchesTruncated: false,
    remoteBranches: ["origin/main"],
    remoteBranchesTruncated: false,
    selectedBranch: selectedBranch
      ? {
          name: selectedBranch,
          kind: selectedBranch.startsWith("origin/") ? "remote" : "local",
        }
      : null,
  };
}

interface CreateTestDaemonEventEnvelopeArgs {
  event: ThreadEvent;
  threadId?: string;
}

export function createTestDaemonEventEnvelope(
  args: CreateTestDaemonEventEnvelopeArgs,
): HostDaemonEventEnvelope {
  return {
    threadId: args.threadId ?? args.event.threadId,
    event: args.event,
  };
}

export function internalAuthHeaders(
  harness: TestAppHarness,
  args: { hostId?: string; hostType?: HostType } = {},
): HeadersInit {
  const activeSessions = harness.db
    .select({
      hostId: hostDaemonSessions.hostId,
      hostType: hostDaemonSessions.hostType,
    })
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.status, "active"))
    .all();

  const inferredHost = activeSessions.length === 1 ? activeSessions[0] : null;

  return {
    authorization: `Bearer ${createTestDaemonHostKey({
      hostId: args.hostId ?? inferredHost?.hostId ?? "host-1",
      hostType: args.hostType ?? inferredHost?.hostType ?? "persistent",
    })}`,
    "content-type": "application/json",
  };
}

function nextTestRpcCursor(
  deps: Pick<TestAppHarness, "db">,
  hostId: string,
): number {
  void deps;
  const previousCursor = Math.max(testRpcCursorByHost.get(hostId) ?? 0);
  const nextCursor = previousCursor + 0.0001;
  testRpcCursorByHost.set(hostId, nextCursor);
  return nextCursor;
}

/**
 * Registers the capturing daemon socket for a host and returns it, so a test
 * that reconnects a host can hand the same socket to the real
 * `onDaemonSocketOpen` instead of replacing the capture with a stub.
 */
export function registerTestHostRpcCapture(
  deps: Pick<TestAppHarness, "db" | "hub">,
  args: RegisterTestHostRpcCaptureArgs,
): TestHostRpcSocket {
  testRpcCursorByHost.delete(args.hostId);
  for (let index = pendingHostRpcRequests.length - 1; index >= 0; index -= 1) {
    const queued = pendingHostRpcRequests[index];
    if (queued?.row.hostId === args.hostId) {
      pendingHostRpcRequests.splice(index, 1);
    }
  }
  const socket: TestHostRpcSocket = {
    close() {},
    send(data) {
      const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(data));
      if (message.type !== "host-rpc.request") {
        return;
      }
      const command = hostDaemonRpcCommandSchema.parse(message.command);
      if (
        command.type === "plugin.host.dispose" ||
        command.type === "plugin.host.cancel"
      ) {
        deps.hub.recordHostOnlineRpcResponse({
          message: hostDaemonOnlineRpcResponseMessageSchema.parse({
            type: "host-rpc.response",
            requestId: message.requestId,
            commandType: command.type,
            ok: true,
            result:
              command.type === "plugin.host.dispose"
                ? { disposed: true }
                : { cancelled: true },
          }),
          sessionId: args.sessionId,
        });
        return;
      }
      if (respondToRuntimeWorkspaceFileCommand(deps, args, message)) {
        return;
      }
      if (respondToProviderModelListCommand(deps, args, message)) {
        return;
      }
      if (
        command.type === "host.list_branch_options" &&
        !args.queueBranchOptions
      ) {
        args.onListBranchOptions?.(command);
        deps.hub.recordHostOnlineRpcResponse({
          message: hostDaemonOnlineRpcResponseMessageSchema.parse({
            type: "host-rpc.response",
            requestId: message.requestId,
            commandType: command.type,
            ok: true,
            result:
              args.gitBranchOptionsResult ??
              buildDefaultGitBranchOptionsResult(command.selectedBranch),
          }),
          sessionId: args.sessionId,
        });
        return;
      }
      if (command.type === "host.inspect_git_source") {
        args.onInspectGitSource?.(command);
        deps.hub.recordHostOnlineRpcResponse({
          message: hostDaemonOnlineRpcResponseMessageSchema.parse({
            type: "host-rpc.response",
            requestId: message.requestId,
            commandType: command.type,
            ok: true,
            result:
              args.gitSourceInspectionResult ??
              buildDefaultGitSourceInspectionResult(),
          }),
          sessionId: args.sessionId,
        });
        return;
      }
      const now = Date.now();
      const row: CapturedRpcRow = {
        id: `rpc-${message.requestId}`,
        hostId: args.hostId,
        sessionId: args.sessionId,
        cursor: nextTestRpcCursor(deps, args.hostId),
        type: command.type,
        payload: JSON.stringify(command),
        state: "pending",
        retryCount: 0,
        resultPayload: null,
        createdAt: now,
        fetchedAt: now,
        completedAt: null,
      };
      pendingHostRpcRequests.push({
        command,
        row,
        rpcRequest: message,
      });
    },
  };
  deps.hub.registerDaemon(args.sessionId, args.hostId, socket);
  return socket;
}

function removePendingHostRpcRequest(requestId: string): void {
  const index = pendingHostRpcRequests.findIndex(
    (queued) => queued.rpcRequest?.requestId === requestId,
  );
  if (index >= 0) {
    pendingHostRpcRequests.splice(index, 1);
  }
}

function isCapturedRpcForHarness(
  harness: TestAppHarness,
  queued: QueuedCommand,
): boolean {
  return (
    harness.db
      .select({ id: hostDaemonSessions.id })
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.hostId, queued.row.hostId))
      .get() !== undefined
  );
}

export async function waitForQueuedCommand(
  harness: TestAppHarness,
  predicate: (queued: QueuedCommand) => boolean,
  timeoutMs = 1_000,
): Promise<QueuedCommand> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const queued of pendingHostRpcRequests) {
      if (isCapturedRpcForHarness(harness, queued) && predicate(queued)) {
        return queued;
      }
    }

    await sleep(10);
  }

  const captured = pendingHostRpcRequests
    .filter((queued) => isCapturedRpcForHarness(harness, queued))
    .map((queued) =>
      queued.command.type === "plugin.host.call"
        ? `${queued.command.type}:${queued.command.pluginId}/${queued.command.method}`
        : queued.command.type,
    );
  throw new Error(
    `Timed out waiting for queued command; captured: ${captured.join(", ") || "none"}`,
  );
}

export async function waitForQueuedCommandAfter(
  harness: TestAppHarness,
  afterCursor: number,
  predicate: (queued: QueuedCommand) => boolean,
  timeoutMs = 1_000,
): Promise<QueuedCommand> {
  return waitForQueuedCommand(
    harness,
    (queued) => queued.row.cursor > afterCursor && predicate(queued),
    timeoutMs,
  );
}

export async function reportQueuedCommandSuccess<
  TCommand extends QueuedCommandPayload,
>(
  harness: TestAppHarness,
  queued: QueuedCommand<TCommand>,
  result: QueuedCommandResult<TCommand>,
  args: { hostId?: string; hostType?: HostType } = {},
): Promise<Response> {
  const sessionId = queued.row.sessionId;
  if (!sessionId) {
    throw new Error("Queued host RPC is missing sessionId");
  }
  if (!queued.rpcRequest) {
    throw new Error("Queued command is missing RPC request metadata");
  }
  const parsedResult = parseHostDaemonRpcResultForCommand(
    queued.rpcRequest.command,
    result,
  );
  harness.hub.recordHostOnlineRpcResponse({
    message: hostDaemonOnlineRpcResponseMessageSchema.parse({
      type: "host-rpc.response",
      requestId: queued.rpcRequest.requestId,
      commandType: queued.rpcRequest.command.type,
      ok: true,
      result: parsedResult,
    }),
    sessionId,
  });
  removePendingHostRpcRequest(queued.rpcRequest.requestId);
  await sleep(0);
  void args;
  return new Response(null, { status: 200 });
}

export async function reportQueuedCommandError(
  harness: TestAppHarness,
  queued: QueuedCommand,
  args: { errorCode: string; errorMessage: string },
  auth: { hostId?: string; hostType?: HostType } = {},
): Promise<Response> {
  const sessionId = queued.row.sessionId;
  if (!sessionId) {
    throw new Error("Queued host RPC is missing sessionId");
  }
  if (!queued.rpcRequest) {
    throw new Error("Queued command is missing RPC request metadata");
  }
  harness.hub.recordHostOnlineRpcResponse({
    message: {
      type: "host-rpc.response",
      requestId: queued.rpcRequest.requestId,
      commandType: queued.rpcRequest.command.type,
      ok: false,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
    },
    sessionId,
  });
  removePendingHostRpcRequest(queued.rpcRequest.requestId);
  await sleep(0);
  void auth;
  return new Response(null, { status: 200 });
}
