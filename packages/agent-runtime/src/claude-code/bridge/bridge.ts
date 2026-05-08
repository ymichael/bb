#!/usr/bin/env node

/**
 * Claude Code bridge process.
 *
 * Thin JSON-RPC shell that manages Claude Agent SDK sessions and forwards
 * raw `SDKMessage` events to the parent process. The parent (host-daemon)
 * passes these to the adapter's `translateEvent` for conversion to
 * `ThreadEvent[]`.
 *
 * The bridge does NOT translate events — it only:
 * - Manages SDK session lifecycle (start, resume, stop, push input)
 * - Forwards raw SDK messages as `{ method: "sdk/message", params: { threadId, message } }`
 * - Forwards tool call requests to the parent and feeds responses back to the SDK
 * - Emits `thread/identity` when the SDK session ID is captured
 */

import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type {
  CanUseTool,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  PendingInteractionGrantedPermissionProfile,
  PermissionEscalation,
} from "@bb/domain";
import { z } from "zod";
import {
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  type BridgeToolCallRequest,
} from "../../shared/bridge-tool-calls.js";
import { shouldAutoDenyInteractiveRequest } from "../../shared/permission-policy.js";
import { SdkSession, type SdkSessionOptions } from "./sdk-session.js";
import { listClaudeCodeBridgeModels } from "./model-list.js";
import {
  decodeClaudeCodeJsonRpcRequest,
  type ClaudeCodeJsonRpcRequest,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadStopParams,
  type TurnStartParams,
  type TurnSteerParams,
} from "./commands.js";
import {
  buildReadonlyDenialMessage,
  buildSessionOptions,
  buildWorkspaceWriteDenialMessage,
} from "./session-options.js";
import { buildReadonlyBashUpdatedInput } from "./readonly-bash-policy.js";
import {
  buildBridgeMcpServer,
  getAllowedToolNames,
  BRIDGE_MCP_SERVER_NAME,
  type ToolCallForwarder,
} from "./tool-proxy-mcp.js";
import {
  type ClaudeInteractiveResponse,
  type ClaudePermissionMode,
  type ClaudePermissionRequestApprovalParams,
  type ClaudePermissionUpdate,
  CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
  claudeInteractiveResponseSchema,
  claudePermissionUpdateSchema,
  shouldRequestClaudePermissionApproval,
  toPendingInteractionPermissionProfile,
} from "../interactive-contract.js";
export { buildSessionOptions } from "./session-options.js";

const promptTextInputSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

// Claude Agent SDK 0.2.111 types stale resume failures as generic
// SDKResultError.errors. The bundled Claude Code CLI can also emit the same
// text on a legacy result field; keep that compatibility at this boundary.
const legacyClaudeErrorResultTextSchema = z
  .object({
    result: z.string(),
  })
  .passthrough();

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC notification carrying a raw SDK message. */
interface SdkMessageNotification {
  jsonrpc: "2.0";
  method: "sdk/message";
  params: { threadId: string; message: SDKMessage };
}

/** JSON-RPC notification for bridge-originated events. */
interface BridgeEventNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface PendingToolCall {
  resolve: (value: { content: string; isError?: boolean }) => void;
}

interface ThreadIdRef {
  current: string;
}

interface CurrentThreadSessionArgs {
  sessionSerial: number;
  threadId: string;
}

interface CreateSdkCallbackArgs {
  sessionSerial: number;
  threadIdRef: ThreadIdRef;
}

interface PendingInteractiveRequest {
  itemId: string;
  kind: "permission_request";
  originalInput: Record<string, unknown>;
  permissions: PendingInteractionGrantedPermissionProfile;
  resolve: (value: PermissionResult) => void;
  toolName: string;
}

interface ClaudeSessionPermissionGrant {
  permissions: PendingInteractionGrantedPermissionProfile;
  toolName: string | null;
}

interface ClaudeSessionPermissionCoverageArgs {
  grants: ClaudeSessionPermissionGrant[];
  permissions: PendingInteractionGrantedPermissionProfile;
  toolName: string;
}

interface ClaudeSessionPermissionGrantCoverageArgs {
  grant: ClaudeSessionPermissionGrant;
  permissions: PendingInteractionGrantedPermissionProfile;
  toolName: string;
}

interface ThreadSession {
  session: SdkSession;
  sessionOptions: SdkSessionOptions;
  sessionSerial: number;
  closing: boolean;
  pendingToolCalls: Map<string | number, PendingToolCall>;
  pendingInteractiveRequests: Map<string | number, PendingInteractiveRequest>;
  permissionEscalation: PermissionEscalation | null;
  permissionMode: ClaudePermissionMode;
  providerThreadId?: string;
  resumeRecovery: ClaudeResumeRecoveryState | null;
  sessionPermissionGrants: ClaudeSessionPermissionGrant[];
  threadIdRef: ThreadIdRef;
}

interface CloseThreadSessionArgs {
  graceful: boolean;
  message: string;
  threadId: string;
}

interface ClaudeResumeRecoveryState {
  acceptedInputTexts: string[];
  attemptedProviderThreadId: string;
  retryAttempted: boolean;
}

interface CreateThreadSessionArgs {
  permissionEscalation: PermissionEscalation | null;
  permissionMode: ClaudePermissionMode;
  providerThreadId?: string;
  resumeRecovery: ClaudeResumeRecoveryState | null;
  sessionOptions: SdkSessionOptions;
  sessionPermissionGrants?: ClaudeSessionPermissionGrant[];
  threadIdRef: ThreadIdRef;
}

interface RecoverStaleResumeArgs {
  message: SDKMessage;
  threadId: string;
  threadSession: ThreadSession;
}

interface StartFreshSessionAfterStaleResumeArgs {
  threadId: string;
  threadSession: ThreadSession;
}

interface ReplaceThreadSessionArgs {
  acceptedInputTexts: string[];
  providerThreadId: string;
  replacementSession: ThreadSession;
  threadId: string;
  threadSession: ThreadSession;
}

type StaleResumeRecoveryOutcome = "forward" | "suppress";

interface ClaudeCodeThreadStopResult {
  ok: true;
}

interface ClaudeCanUseToolDecisionContext {
  blockedPath: string | undefined;
  decisionReason: string | undefined;
  suggestions: ClaudePermissionUpdate[] | undefined;
  toolName: string;
}

interface BuildInteractiveRequestParamsArgs {
  providerThreadId: string;
  threadId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  decisionReason: string | undefined;
  blockedPath: string | undefined;
  suggestions: ClaudePermissionUpdate[] | undefined;
}

interface ForwardInteractiveRequestArgs extends BuildInteractiveRequestParamsArgs {
  signal: AbortSignal;
}

const sessions = new Map<string, ThreadSession>();
const closingSessions = new Map<string, Promise<void>>();
let sessionSerialCounter = 0;
let toolCallRequestIdCounter = 0;

// Runtime waits on thread/stop until the SDK stream drains or this timeout
// forces the session closed. Stop remains a best-effort success boundary.
const THREAD_STOP_CLOSE_TIMEOUT_MS = 4_000;

function normalizePermissionPath(path: string): string {
  return resolvePath(path);
}

function permissionPathCovers(
  grantPath: string,
  requestedPath: string,
): boolean {
  const normalizedGrantPath = normalizePermissionPath(grantPath);
  const normalizedRequestedPath = normalizePermissionPath(requestedPath);
  if (normalizedGrantPath === normalizedRequestedPath) {
    return true;
  }
  const grantPrefix = normalizedGrantPath.endsWith("/")
    ? normalizedGrantPath
    : `${normalizedGrantPath}/`;
  return normalizedRequestedPath.startsWith(grantPrefix);
}

function permissionPathListCovers(
  grantedPaths: string[],
  requestedPaths: string[],
): boolean {
  return requestedPaths.every((requestedPath) =>
    grantedPaths.some((grantedPath) =>
      permissionPathCovers(grantedPath, requestedPath),
    ),
  );
}

function fileSystemPermissionsCover(
  granted: PendingInteractionGrantedPermissionProfile["fileSystem"],
  requested: PendingInteractionGrantedPermissionProfile["fileSystem"],
): boolean {
  if (requested === null) {
    return true;
  }
  if (granted === null) {
    return false;
  }
  const grantedReadPaths = [...granted.read, ...granted.write];
  return (
    permissionPathListCovers(grantedReadPaths, requested.read) &&
    permissionPathListCovers(granted.write, requested.write)
  );
}

function networkPermissionsCover(
  granted: PendingInteractionGrantedPermissionProfile["network"],
  requested: PendingInteractionGrantedPermissionProfile["network"],
): boolean {
  return requested?.enabled === true ? granted?.enabled === true : true;
}

function sessionPermissionGrantCovers(
  args: ClaudeSessionPermissionGrantCoverageArgs,
): boolean {
  if (args.grant.toolName !== null && args.grant.toolName !== args.toolName) {
    return false;
  }
  return (
    networkPermissionsCover(
      args.grant.permissions.network,
      args.permissions.network,
    ) &&
    fileSystemPermissionsCover(
      args.grant.permissions.fileSystem,
      args.permissions.fileSystem,
    )
  );
}

function hasClaudeSessionPermissionGrant(
  args: ClaudeSessionPermissionCoverageArgs,
): boolean {
  return args.grants.some((grant) =>
    sessionPermissionGrantCovers({
      grant,
      permissions: args.permissions,
      toolName: args.toolName,
    }),
  );
}

function shouldCacheClaudeSessionPermission(
  response: ClaudeInteractiveResponse,
): boolean {
  return (
    response.behavior === "allow" &&
    (response.decisionClassification === "user_permanent" ||
      response.updatedPermissions !== undefined)
  );
}

function send(
  msg:
    | JsonRpcResponse
    | SdkMessageNotification
    | BridgeEventNotification
    | BridgeToolCallRequest,
): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendSdkMessage(threadId: string, message: SDKMessage): void {
  send({
    jsonrpc: "2.0",
    method: "sdk/message",
    params: { threadId, message },
  });
}

function sendThreadIdentity(threadId: string, providerThreadId: string): void {
  send({
    jsonrpc: "2.0",
    method: "thread/identity",
    params: {
      threadId,
      providerThreadId,
    },
  });
}

function nextSessionSerial(): number {
  sessionSerialCounter += 1;
  return sessionSerialCounter;
}

function createThreadSession(args: CreateThreadSessionArgs): ThreadSession {
  const sessionSerial = nextSessionSerial();
  const session = new SdkSession(
    args.sessionOptions,
    createOnSdkMessage({
      sessionSerial,
      threadIdRef: args.threadIdRef,
    }),
    createOnSdkDone({
      sessionSerial,
      threadIdRef: args.threadIdRef,
    }),
  );

  return {
    session,
    sessionOptions: args.sessionOptions,
    sessionSerial,
    closing: false,
    pendingToolCalls: new Map(),
    pendingInteractiveRequests: new Map(),
    permissionEscalation: args.permissionEscalation,
    permissionMode: args.permissionMode,
    ...(args.providerThreadId
      ? { providerThreadId: args.providerThreadId }
      : {}),
    resumeRecovery: args.resumeRecovery,
    sessionPermissionGrants: [...(args.sessionPermissionGrants ?? [])],
    threadIdRef: args.threadIdRef,
  };
}

function readLegacyClaudeErrorResultText(
  message: SDKResultMessage,
): string | null {
  const parsed = legacyClaudeErrorResultTextSchema.safeParse(message);
  return parsed.success ? parsed.data.result : null;
}

function readSingleClaudeErrorText(message: SDKResultMessage): string | null {
  if (message.subtype !== "error_during_execution") {
    return null;
  }
  const typedErrorText =
    Array.isArray(message.errors) && message.errors.length === 1
      ? message.errors[0]
      : null;
  const legacyResultText =
    !Array.isArray(message.errors) || message.errors.length === 0
      ? readLegacyClaudeErrorResultText(message)
      : null;
  return typedErrorText ?? legacyResultText;
}

function readExactClaudeStaleResumeError(
  args: Pick<ClaudeResumeRecoveryState, "attemptedProviderThreadId"> & {
    message: SDKMessage;
  },
): string | null {
  const expectedMessage = `No conversation found with session ID: ${args.attemptedProviderThreadId}`;
  const { message } = args;
  if (message.type !== "result") {
    return null;
  }
  if (message.is_error !== true) {
    return null;
  }
  const errorText = readSingleClaudeErrorText(message);
  if (errorText !== expectedMessage) {
    return null;
  }
  return expectedMessage;
}

function startFreshSessionAfterStaleResume(
  args: StartFreshSessionAfterStaleResumeArgs,
): void {
  const providerThreadId = randomUUID();
  const replacementOptions: SdkSessionOptions = {
    ...args.threadSession.sessionOptions,
    sessionId: providerThreadId,
  };
  const acceptedInputTexts = [
    ...(args.threadSession.resumeRecovery?.acceptedInputTexts ?? []),
  ];
  const replacementSession = createThreadSession({
    permissionEscalation: args.threadSession.permissionEscalation,
    permissionMode: args.threadSession.permissionMode,
    providerThreadId,
    resumeRecovery: null,
    sessionOptions: replacementOptions,
    sessionPermissionGrants: args.threadSession.sessionPermissionGrants,
    threadIdRef: args.threadSession.threadIdRef,
  });

  replaceThreadSession({
    acceptedInputTexts,
    providerThreadId,
    replacementSession,
    threadId: args.threadId,
    threadSession: args.threadSession,
  });
}

function replaceThreadSession(args: ReplaceThreadSessionArgs): void {
  args.threadSession.closing = true;
  resolvePendingSessionWork(
    args.threadSession,
    "Thread session replaced after stale Claude resume",
  );
  args.threadSession.session.stop();

  // This is not a user-requested thread close: the thread remains active and
  // immediately owns the replacement session. `closingSessions` only gates
  // external stop/replace requests, so a stop after this point should target
  // the replacement, not wait on the poisoned resume session.
  sessions.set(args.threadId, args.replacementSession);
  args.replacementSession.session.start();
  sendThreadIdentity(args.threadId, args.providerThreadId);

  for (const inputText of args.acceptedInputTexts) {
    args.replacementSession.session.pushInput(inputText);
  }
}

function handleStaleResumeRecovery(
  args: RecoverStaleResumeArgs,
): StaleResumeRecoveryOutcome {
  const { resumeRecovery } = args.threadSession;
  if (!resumeRecovery || resumeRecovery.retryAttempted) {
    return "forward";
  }

  const staleErrorMessage = readExactClaudeStaleResumeError({
    attemptedProviderThreadId: resumeRecovery.attemptedProviderThreadId,
    message: args.message,
  });
  if (!staleErrorMessage) {
    if (args.message.type === "result") {
      args.threadSession.resumeRecovery = null;
    }
    return "forward";
  }

  resumeRecovery.retryAttempted = true;
  startFreshSessionAfterStaleResume({
    threadId: args.threadId,
    threadSession: args.threadSession,
  });
  return "suppress";
}

function getCurrentThreadSession(
  args: CurrentThreadSessionArgs,
): ThreadSession | undefined {
  const threadSession = sessions.get(args.threadId);
  if (
    !threadSession ||
    threadSession.closing ||
    threadSession.sessionSerial !== args.sessionSerial
  ) {
    return undefined;
  }
  return threadSession;
}

function createOnSdkMessage(
  args: CreateSdkCallbackArgs,
): (message: SDKMessage) => void {
  return (message: SDKMessage) => {
    const threadSession = getCurrentThreadSession({
      sessionSerial: args.sessionSerial,
      threadId: args.threadIdRef.current,
    });
    if (!threadSession) return;
    const recoveryOutcome = handleStaleResumeRecovery({
      message,
      threadId: args.threadIdRef.current,
      threadSession,
    });
    if (recoveryOutcome === "suppress") {
      return;
    }
    const providerThreadId = message.session_id?.trim() ?? "";
    if (
      providerThreadId.length > 0 &&
      threadSession.providerThreadId !== providerThreadId
    ) {
      threadSession.providerThreadId = providerThreadId;
      sendThreadIdentity(args.threadIdRef.current, providerThreadId);
    }
    sendSdkMessage(args.threadIdRef.current, message);
  };
}

function createOnSdkDone(
  args: CreateSdkCallbackArgs,
): (error?: unknown) => void {
  return (error?: unknown) => {
    if (!error) return;
    const threadSession = getCurrentThreadSession({
      sessionSerial: args.sessionSerial,
      threadId: args.threadIdRef.current,
    });
    if (!threadSession) return;

    const message = error instanceof Error ? error.message : String(error);

    send({
      jsonrpc: "2.0",
      method: "error",
      params: { threadId: args.threadIdRef.current, message },
    });
  };
}

function createForwardToolCall(threadIdRef: ThreadIdRef): ToolCallForwarder {
  return (toolName, args) => {
    return new Promise<{ content: string; isError?: boolean }>((resolve) => {
      const threadSession = sessions.get(threadIdRef.current);
      if (!threadSession || threadSession.closing) {
        resolve({ content: "Thread session not found", isError: true });
        return;
      }
      toolCallRequestIdCounter += 1;
      const requestId = toolCallRequestIdCounter;
      threadSession.pendingToolCalls.set(requestId, { resolve });
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "item/tool/call",
        params: {
          threadId: threadIdRef.current,
          providerThreadId:
            threadSession.providerThreadId ?? threadIdRef.current,
          turnId: null,
          callId: `call-${requestId}`,
          tool: toolName,
          arguments: args,
        },
      });
    });
  };
}

function findSessionByPendingToolCall(
  id: string | number,
): ThreadSession | undefined {
  for (const session of sessions.values()) {
    if (session.pendingToolCalls.has(id)) return session;
  }
  return undefined;
}

function findSessionByPendingInteractiveRequest(
  id: string | number,
): ThreadSession | undefined {
  for (const session of sessions.values()) {
    if (session.pendingInteractiveRequests.has(id)) {
      return session;
    }
  }

  return undefined;
}

function resolvePendingInteractiveRequests(
  threadSession: ThreadSession,
  message: string,
): void {
  for (const [requestId, pending] of threadSession.pendingInteractiveRequests) {
    threadSession.pendingInteractiveRequests.delete(requestId);
    pending.resolve({
      behavior: "deny",
      interrupt: true,
      message,
      toolUseID: pending.itemId,
    });
  }
}

function resolvePendingToolCalls(
  threadSession: ThreadSession,
  message: string,
): void {
  for (const [requestId, pending] of threadSession.pendingToolCalls) {
    threadSession.pendingToolCalls.delete(requestId);
    pending.resolve({ content: message, isError: true });
  }
}

function resolvePendingSessionWork(
  threadSession: ThreadSession,
  message: string,
): void {
  resolvePendingToolCalls(threadSession, message);
  resolvePendingInteractiveRequests(threadSession, message);
}

async function closeThreadSession(args: CloseThreadSessionArgs): Promise<void> {
  const existingClose = closingSessions.get(args.threadId);
  if (existingClose) {
    await existingClose;
    return;
  }

  const threadSession = sessions.get(args.threadId);
  if (!threadSession) {
    return;
  }

  threadSession.closing = true;
  resolvePendingSessionWork(threadSession, args.message);
  const closePromise = (async () => {
    if (args.graceful) {
      await threadSession.session.closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS);
      return;
    }
    threadSession.session.stop();
  })().finally(() => {
    if (sessions.get(args.threadId) === threadSession) {
      sessions.delete(args.threadId);
    }
    closingSessions.delete(args.threadId);
  });
  closingSessions.set(args.threadId, closePromise);
  await closePromise;
}

async function closeThreadSessionsGracefully(message: string): Promise<void> {
  await Promise.all(
    Array.from(sessions.keys()).map((threadId) =>
      closeThreadSession({ graceful: true, message, threadId }),
    ),
  );
}

function extractEnvOverrides(
  config: Record<string, unknown> | undefined,
): Record<string, string> {
  const envOverrides: Record<string, string> = {};
  if (config) {
    for (const [key, value] of Object.entries(config)) {
      if (
        key.startsWith("shell_environment_policy.set.") &&
        typeof value === "string"
      ) {
        const envVar = key.slice("shell_environment_policy.set.".length);
        envOverrides[envVar] = value;
      }
    }
  }
  return envOverrides;
}

function buildSessionEnv(
  envOverrides: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...envOverrides,
    CLAUDE_AGENT_SDK_CLIENT_APP: "bb/1.0.0",
  };
}

function parseClaudePermissionUpdates(
  value: unknown,
): ClaudePermissionUpdate[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsedUpdates = value.flatMap((entry) => {
    const parsed = claudePermissionUpdateSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });

  return parsedUpdates.length > 0 ? parsedUpdates : undefined;
}

function buildInteractiveRequestParams(
  args: BuildInteractiveRequestParamsArgs,
): ClaudePermissionRequestApprovalParams {
  return {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    turnId: null,
    itemId: args.toolUseId,
    toolName: args.toolName,
    input: args.input,
    reason: args.decisionReason ?? null,
    permissions: toPendingInteractionPermissionProfile({
      toolName: args.toolName,
      blockedPath: args.blockedPath,
      suggestions: args.suggestions,
    }),
  };
}

function buildInteractivePermissionResult(
  pending: PendingInteractiveRequest,
  response: ClaudeInteractiveResponse,
): PermissionResult {
  if (pending.kind !== response.kind) {
    return {
      behavior: "deny",
      message: "Interactive response kind mismatch",
      toolUseID: pending.itemId,
    };
  }

  switch (response.kind) {
    case "permission_request":
      if (response.behavior === "deny") {
        return {
          behavior: "deny",
          message: response.message,
          ...(response.interrupt === undefined
            ? {}
            : { interrupt: response.interrupt }),
          ...(response.decisionClassification === undefined
            ? {}
            : { decisionClassification: response.decisionClassification }),
          toolUseID: pending.itemId,
        };
      }
      return {
        behavior: "allow",
        updatedInput: pending.originalInput,
        ...(response.updatedPermissions === undefined
          ? {}
          : { updatedPermissions: response.updatedPermissions }),
        ...(response.decisionClassification === undefined
          ? {}
          : { decisionClassification: response.decisionClassification }),
        toolUseID: pending.itemId,
      };
  }
}

function createForwardInteractiveRequest(
  threadIdRef: ThreadIdRef,
): (args: ForwardInteractiveRequestArgs) => Promise<PermissionResult> {
  return (args) =>
    new Promise<PermissionResult>((resolve) => {
      const threadSession = sessions.get(threadIdRef.current);
      if (!threadSession) {
        resolve({
          behavior: "deny",
          message: "Thread session not found",
          toolUseID: args.toolUseId,
        });
        return;
      }

      let params: ClaudePermissionRequestApprovalParams;
      try {
        params = buildInteractiveRequestParams(args);
      } catch (error) {
        resolve({
          behavior: "deny",
          message: error instanceof Error ? error.message : String(error),
          toolUseID: args.toolUseId,
        });
        return;
      }

      toolCallRequestIdCounter += 1;
      const requestId = toolCallRequestIdCounter;

      const finish = (result: PermissionResult): void => {
        args.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const onAbort = (): void => {
        if (!threadSession.pendingInteractiveRequests.delete(requestId)) {
          return;
        }
        finish({
          behavior: "deny",
          message: "Interactive request cancelled",
          toolUseID: args.toolUseId,
        });
      };

      args.signal.addEventListener("abort", onAbort, { once: true });
      threadSession.pendingInteractiveRequests.set(requestId, {
        itemId: args.toolUseId,
        kind: "permission_request",
        originalInput: args.input,
        permissions: params.permissions,
        resolve: finish,
        toolName: args.toolName,
      });

      send({
        jsonrpc: "2.0",
        id: requestId,
        method: CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD,
        params,
      });
    });
}

function createCanUseTool(threadIdRef: ThreadIdRef): CanUseTool {
  const forwardInteractiveRequest =
    createForwardInteractiveRequest(threadIdRef);

  return async (toolName, input, options) => {
    const threadSession = sessions.get(threadIdRef.current);
    if (!threadSession) {
      return {
        behavior: "deny",
        message: "Thread session not found",
        toolUseID: options.toolUseID,
      };
    }
    const suggestions = parseClaudePermissionUpdates(options.suggestions);

    const requestContext: ClaudeCanUseToolDecisionContext = {
      toolName,
      blockedPath: options.blockedPath,
      decisionReason: options.decisionReason,
      suggestions,
    };
    const requestedPermissions =
      toPendingInteractionPermissionProfile(requestContext);
    if (
      hasClaudeSessionPermissionGrant({
        grants: threadSession.sessionPermissionGrants,
        permissions: requestedPermissions,
        toolName,
      })
    ) {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: options.toolUseID,
        decisionClassification: "user_permanent",
      };
    }

    if (
      toolName === "Bash" &&
      (threadSession.permissionMode === "default" ||
        threadSession.permissionMode === "dontAsk")
    ) {
      // Defensive mirror of the readonly PreToolUse allowlist: Claude may still
      // call canUseTool after hook input rewriting, and safe policy allows are
      // not user decisions, so no decisionClassification is attached.
      const updatedInput = buildReadonlyBashUpdatedInput(input);
      if (updatedInput) {
        return {
          behavior: "allow",
          updatedInput,
          toolUseID: options.toolUseID,
        };
      }
    }

    const shouldRequestApproval =
      shouldRequestClaudePermissionApproval(requestContext) ||
      (options.suggestions?.length ?? 0) > 0;

    if (!shouldRequestApproval) {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: options.toolUseID,
      };
    }

    if (threadSession.permissionMode === "bypassPermissions") {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: options.toolUseID,
      };
    }

    if (
      shouldAutoDenyInteractiveRequest(threadSession) ||
      threadSession.permissionMode === "dontAsk"
    ) {
      const policyMessage =
        threadSession.permissionMode === "acceptEdits"
          ? buildWorkspaceWriteDenialMessage()
          : buildReadonlyDenialMessage();
      return {
        behavior: "deny",
        message: options.decisionReason ?? policyMessage,
        toolUseID: options.toolUseID,
      };
    }

    return forwardInteractiveRequest({
      threadId: threadIdRef.current,
      providerThreadId: threadSession.providerThreadId ?? threadIdRef.current,
      toolName,
      toolUseId: options.toolUseID,
      input,
      decisionReason: options.decisionReason,
      blockedPath: options.blockedPath,
      suggestions,
      signal: options.signal,
    });
  };
}

async function handleRequest(request: ClaudeCodeJsonRpcRequest): Promise<void> {
  switch (request.method) {
    case "initialize":
      sendResult(request.id, { ok: true });
      break;
    case "model/list":
      sendResult(
        request.id,
        await listClaudeCodeBridgeModels({
          selectedModel: request.params.selectedModel,
        }),
      );
      break;
    case "thread/start":
      await handleThreadStart(request.id, request.params);
      break;
    case "thread/resume":
      await handleThreadResume(request.id, request.params);
      break;
    case "turn/start":
      handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      handleTurnSteer(request.id, request.params);
      break;
    case "thread/stop":
      sendResult(request.id, await handleThreadStop(request.params));
      break;
  }
}

async function handleThreadStart(
  id: string | number,
  params: ThreadStartParams,
): Promise<void> {
  const threadIdRef = { current: params.threadId };

  const existing = sessions.get(threadIdRef.current);
  if (existing) {
    await closeThreadSession({
      graceful: false,
      message: "Thread session replaced while awaiting permission approval",
      threadId: threadIdRef.current,
    });
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  const providerThreadId = randomUUID();
  sessionOptions.sessionId = providerThreadId;
  sessionOptions.canUseTool = createCanUseTool(threadIdRef);
  if (params.dynamicTools && params.dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(
      params.dynamicTools,
      createForwardToolCall(threadIdRef),
    );
    sessionOptions.mcpServers = { [BRIDGE_MCP_SERVER_NAME]: mcpServer };
    sessionOptions.allowedTools = getAllowedToolNames(params.dynamicTools);
  }

  const threadSession = createThreadSession({
    permissionEscalation: params.permissionEscalation,
    permissionMode: params.permissionMode,
    providerThreadId,
    resumeRecovery: null,
    sessionOptions,
    sessionPermissionGrants: [],
    threadIdRef,
  });
  sessions.set(threadIdRef.current, threadSession);
  threadSession.session.start();

  sendResult(id, { threadId: threadIdRef.current, providerThreadId });
  sendThreadIdentity(threadIdRef.current, providerThreadId);
}

async function handleThreadResume(
  id: string | number,
  params: ThreadResumeParams,
): Promise<void> {
  const threadId = params.threadId;
  const requestedProviderThreadId = params.providerThreadId ?? undefined;

  const existing = sessions.get(threadId);
  if (existing) {
    await closeThreadSession({
      graceful: false,
      message: "Thread session replaced while awaiting permission approval",
      threadId,
    });
  }

  const envOverrides = extractEnvOverrides(params.config);
  const sessionEnv = buildSessionEnv(envOverrides);
  const threadIdRef = { current: threadId };
  const sessionOptions = buildSessionOptions(params, sessionEnv);
  sessionOptions.canUseTool = createCanUseTool(threadIdRef);
  if (params.dynamicTools && params.dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(
      params.dynamicTools,
      createForwardToolCall(threadIdRef),
    );
    sessionOptions.mcpServers = { [BRIDGE_MCP_SERVER_NAME]: mcpServer };
    sessionOptions.allowedTools = getAllowedToolNames(params.dynamicTools);
  }
  const threadSession = createThreadSession({
    permissionEscalation: params.permissionEscalation,
    permissionMode: params.permissionMode,
    ...(requestedProviderThreadId
      ? { providerThreadId: requestedProviderThreadId }
      : {}),
    resumeRecovery: requestedProviderThreadId
      ? {
          acceptedInputTexts: [],
          attemptedProviderThreadId: requestedProviderThreadId,
          retryAttempted: false,
        }
      : null,
    sessionOptions,
    sessionPermissionGrants: [],
    threadIdRef,
  });
  sessions.set(threadId, threadSession);
  threadSession.session.start(requestedProviderThreadId);

  sendResult(id, {
    threadId,
    providerThreadId: requestedProviderThreadId ?? null,
  });
}

function handleTurnStart(id: string | number, params: TurnStartParams): void {
  const threadSession = sessions.get(params.threadId);
  if (!threadSession || threadSession.closing) {
    sendError(id, -32000, "No active session");
    return;
  }

  const input = extractInputText(params.input);
  if (!input) {
    sendError(id, -32602, "Missing input text");
    return;
  }

  threadSession.resumeRecovery?.acceptedInputTexts.push(input);
  threadSession.session.pushInput(input);
  sendResult(id, { threadId: params.threadId });
}

function handleTurnSteer(id: string | number, params: TurnSteerParams): void {
  const threadSession = sessions.get(params.threadId);
  if (!threadSession || threadSession.closing) {
    sendError(id, -32000, "No active session");
    return;
  }

  const input = extractInputText(params.input);
  if (!input) {
    sendError(id, -32602, "Missing input text");
    return;
  }

  threadSession.resumeRecovery?.acceptedInputTexts.push(input);
  threadSession.session.pushInput(input);
  sendResult(id, { threadId: params.threadId });
}

async function handleThreadStop(
  params: ThreadStopParams,
): Promise<ClaudeCodeThreadStopResult> {
  await closeThreadSession({
    graceful: true,
    message: "Thread stopped while awaiting permission approval",
    threadId: params.threadId,
  });
  return { ok: true };
}

function extractInputText(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return undefined;

  const chunks: string[] = [];
  for (const item of input) {
    const parsed = promptTextInputSchema.safeParse(item);
    if (parsed.success) {
      chunks.push(parsed.data.text);
    }
  }

  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

export function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response && findSessionByPendingToolCall(response.id)) {
    const threadSession = findSessionByPendingToolCall(response.id)!;
    const pending = threadSession.pendingToolCalls.get(response.id)!;
    threadSession.pendingToolCalls.delete(response.id);
    if ("error" in response) {
      pending.resolve({
        content: response.error.message ?? "Tool call failed",
        isError: true,
      });
    } else {
      pending.resolve(decodeToolCallResponsePayload(response.result));
    }
    return;
  }

  if (response && findSessionByPendingInteractiveRequest(response.id)) {
    const threadSession = findSessionByPendingInteractiveRequest(response.id)!;
    const pending = threadSession.pendingInteractiveRequests.get(response.id)!;
    threadSession.pendingInteractiveRequests.delete(response.id);
    if ("error" in response) {
      pending.resolve({
        behavior: "deny",
        message: response.error.message ?? "Interactive request failed",
        toolUseID: pending.itemId,
      });
      return;
    }

    const parsedResponse = claudeInteractiveResponseSchema.safeParse(
      response.result,
    );
    if (!parsedResponse.success) {
      pending.resolve({
        behavior: "deny",
        message: "Invalid interactive response payload",
        toolUseID: pending.itemId,
      });
      return;
    }

    const interactiveResponse = parsedResponse.data;
    if (shouldCacheClaudeSessionPermission(interactiveResponse)) {
      threadSession.sessionPermissionGrants.push({
        permissions: pending.permissions,
        toolName: pending.toolName,
      });
    }

    pending.resolve(
      buildInteractivePermissionResult(pending, interactiveResponse),
    );
    return;
  }

  const request = decodeClaudeCodeJsonRpcRequest(parsed);
  if (!request) return;
  void handleRequest(request).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    sendError(request.id, -32000, message);
  });
}

// Main entry point
let shuttingDown = false;

function shutdownGracefully(message: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  void closeThreadSessionsGracefully(message).finally(() => {
    process.exit(0);
  });
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return (
    entryPoint !== undefined &&
    import.meta.url === pathToFileURL(resolvePath(entryPoint)).href
  );
}

if (isMainModule()) {
  process.once("SIGTERM", () => {
    shutdownGracefully(
      "Bridge shutting down while awaiting permission approval",
    );
  });

  process.once("SIGINT", () => {
    shutdownGracefully("Bridge interrupted while awaiting permission approval");
  });

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", handleLine);
  rl.on("close", () => {
    shutdownGracefully("Bridge closed while awaiting permission approval");
  });
}
