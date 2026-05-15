/**
 * Codex provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the OpenAI Codex app-server
 * JSON-RPC protocol. Validates the outer JSON-RPC envelope before translating
 * the provider-specific payloads.
 *
 * Reference: https://github.com/openai/codex (codex-rs/app-server-protocol/)
 */

import fs from "node:fs";
import path from "node:path";
import { getBuiltInAgentProviderInfo } from "@bb/agent-providers";
import {
  jsonValueSchema,
  requireThreadEventScopeTurnId,
  turnScope,
} from "@bb/domain";
import type {
  ClientTurnRequestId,
  PermissionEscalation,
  PromptInput,
  ProviderCapabilities,
  ServiceTier,
  ThreadEvent,
} from "@bb/domain";
import type { ClientRequest as CodexClientRequest } from "./generated/codex-app-server/schema/ClientRequest.js";
import type { JsonValue } from "./generated/codex-app-server/schema/serde_json/JsonValue.js";
import type { ServerNotification as CodexServerNotification } from "./generated/codex-app-server/schema/ServerNotification.js";
import type { SandboxPolicy } from "./generated/codex-app-server/schema/v2/SandboxPolicy.js";
import type { DynamicToolSpec } from "./generated/codex-app-server/schema/v2/DynamicToolSpec.js";
import type { SandboxMode as CodexSandboxMode } from "./generated/codex-app-server/schema/v2/SandboxMode.js";
import type { ThreadResumeParams } from "./generated/codex-app-server/schema/v2/ThreadResumeParams.js";
import type { ThreadStartParams } from "./generated/codex-app-server/schema/v2/ThreadStartParams.js";
import type { UserInput as CodexUserInput } from "./generated/codex-app-server/schema/v2/UserInput.js";
import type { AskForApproval } from "./generated/codex-app-server/schema/v2/AskForApproval.js";
import { parseModelsResponse } from "./models.js";
import {
  buildShellEnvironmentPolicyConfig,
  extractResultText,
} from "../shared/adapter-utils.js";
import { buildAcceptedUserMessageEvent } from "../shared/accepted-user-messages.js";
import { decodeNativeProviderToolCallRequest } from "../shared/provider-tool-call-contract.js";
import { resolveAdapterPermissionPolicy } from "../shared/permission-policy.js";
import type {
  AdapterCommand,
  DecodedToolCallRequest,
  PreparedProviderCommandDispatch,
  ProviderAdapter,
  ProviderAdapterFactoryOptions,
  ProviderCommandPlan,
  ProviderExecutionContext,
} from "../provider-adapter.js";
import type {
  JsonRpcMessage,
  ProviderInboundRequest,
  ProviderRuntimeEvent,
} from "../runtime-json-rpc.js";
import { translateCodexEvent } from "./event-translation.js";
import {
  buildCodexInteractiveResponse,
  decodeCodexInteractiveRequest,
} from "./interactive-requests.js";
import {
  codexBridgeEnvelopeSchema,
  codexRawResponseItemCompletedParamsSchema,
  codexThreadClosedParamsSchema,
} from "./schemas.js";

interface CodexPermissionSettings {
  approvalPolicy: AskForApproval;
  sandbox: CodexSandboxMode;
  sandboxPolicy: SandboxPolicy;
}

interface CodexThreadPermissionSettings {
  approvalPolicy: AskForApproval;
  sandbox: CodexSandboxMode;
}

interface ToCodexPermissionSettingsArgs {
  additionalWorkspaceWriteRoots: readonly string[];
  gitWritableRoots: readonly string[];
  options: ProviderExecutionContext;
}

interface BuildCodexConfigArgs {
  additionalWorkspaceWriteRoots: readonly string[];
  gitWritableRoots: readonly string[];
  options?: ProviderExecutionContext;
  threadId: string;
}

interface RealpathContainedDirectoryArgs {
  candidatePath: string;
  trustedParentPath: string;
}

interface RegularFileInsideDirectoryArgs {
  filePath: string;
  trustedParentPath: string;
}

interface AddRefWritableRootsArgs {
  commonDir: string;
  headRef: string | null;
  writableRoots: string[];
}

interface AddDetachedHeadWritableRootsArgs {
  commonDir: string;
  writableRoots: string[];
}

interface AddOptionalContainedDirectoryArgs extends RealpathContainedDirectoryArgs {
  writableRoots: string[];
}

interface LinkedWorktreeGitDirBelongsToWorkspaceArgs {
  gitDir: string;
  workspaceGitFile: string;
  workspacePath: string;
}

interface RecordThreadGitWritableRootsArgs {
  threadId: string;
  writableRoots: readonly string[];
}

interface ActivateThreadGitWritableRootsArgs {
  providerThreadId: string;
  threadId: string;
}

interface ClearGitWritableRootsByBbThreadIdArgs {
  threadId: string;
}

interface ClearGitWritableRootsByProviderThreadIdArgs {
  providerThreadId: string;
}

interface PreparedWorkspaceWriteGitRoots {
  config: { [key in string]?: JsonValue } | undefined;
  permissionSettings: CodexThreadPermissionSettings;
}

interface PrepareWorkspaceWriteGitRootsArgs {
  command: CodexInstructionCommand;
}

interface ContainedDirectoryResult {
  path: string;
  status: "contained";
}

interface MissingDirectoryResult {
  status: "missing";
}

interface EscapedDirectoryResult {
  status: "escaped";
}

type RealpathContainedDirectoryResult =
  | ContainedDirectoryResult
  | MissingDirectoryResult
  | EscapedDirectoryResult;

type GitHeadState =
  | { type: "detached" }
  | { ref: string; type: "ref" }
  | { type: "unsafe" };

type CodexInstructionCommand = Extract<
  AdapterCommand,
  { type: "thread/start" | "thread/resume" }
>;

interface CodexInstructionOverrides {
  baseInstructions?: ThreadStartParams["baseInstructions"];
  developerInstructions?: ThreadStartParams["developerInstructions"];
}

function resolveCodexInstructionOverrides(
  command: CodexInstructionCommand,
): CodexInstructionOverrides {
  const instructions = command.options.instructions?.trim();
  if (!instructions) {
    return {};
  }
  if (command.instructionMode === "replace") {
    return { baseInstructions: instructions };
  }
  return { developerInstructions: instructions };
}

function toWorkspaceWriteCodexSandboxPolicy(
  writableRoots: readonly string[],
): SandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [...writableRoots],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function toReadonlyCodexSandboxPolicy(): SandboxPolicy {
  return {
    type: "readOnly",
    access: { type: "fullAccess" },
    networkAccess: false,
  };
}

function toEscalationApprovalPolicy(
  escalation: PermissionEscalation,
): AskForApproval {
  return escalation === "deny" ? "never" : "on-request";
}

function readTextFileIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function realpathDirectoryIfPresent(directoryPath: string): string | null {
  try {
    if (!fs.statSync(directoryPath).isDirectory()) {
      return null;
    }
    return fs.realpathSync.native(directoryPath);
  } catch {
    return null;
  }
}

function regularFilePathInsideDirectoryIfPresent(
  args: RegularFileInsideDirectoryArgs,
): string | null {
  try {
    const filePath = path.normalize(args.filePath);
    if (
      !fs.lstatSync(filePath).isFile() ||
      !isPathInsideOrEqual(args.trustedParentPath, filePath)
    ) {
      return null;
    }
    return filePath;
  } catch {
    return null;
  }
}

function resolveGitPath(cwd: string, rawPath: string): string {
  return path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.normalize(path.resolve(cwd, rawPath));
}

function parseGitDirPointer(content: string): string | null {
  const firstLine = content.split(/\r?\n/u)[0]?.trim();
  if (!firstLine?.startsWith("gitdir:")) {
    return null;
  }
  const rawGitDir = firstLine.slice("gitdir:".length).trim();
  return rawGitDir.length > 0 ? rawGitDir : null;
}

function parseGitHeadState(content: string | null): GitHeadState {
  const firstLine = content?.split(/\r?\n/u)[0]?.trim();
  if (!firstLine) {
    return { type: "unsafe" };
  }
  if (!firstLine.startsWith("ref:")) {
    return /^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/u.test(firstLine)
      ? { type: "detached" }
      : { type: "unsafe" };
  }
  const ref = firstLine.slice("ref:".length).trim();
  return ref.length > 0 ? { type: "ref", ref } : { type: "unsafe" };
}

function resolveCommonGitDir(gitDir: string): string | null {
  const commonDirContent = readTextFileIfPresent(
    path.join(gitDir, "commondir"),
  );
  const commonDir = commonDirContent?.split(/\r?\n/u)[0]?.trim();
  if (!commonDir) {
    return null;
  }
  return path.isAbsolute(commonDir)
    ? path.normalize(commonDir)
    : path.normalize(path.resolve(gitDir, commonDir));
}

function linkedWorktreeGitDirBelongsToWorkspace(
  args: LinkedWorktreeGitDirBelongsToWorkspaceArgs,
): boolean {
  const rawBacklink = readTextFileIfPresent(path.join(args.gitDir, "gitdir"))
    ?.split(/\r?\n/u)[0]
    ?.trim();
  if (!rawBacklink) {
    return false;
  }

  const linkedGitFile = regularFilePathInsideDirectoryIfPresent({
    filePath: resolveGitPath(args.gitDir, rawBacklink),
    trustedParentPath: args.workspacePath,
  });
  return linkedGitFile === args.workspaceGitFile;
}

function isPathInsideOrEqual(
  parentPath: string,
  candidatePath: string,
): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative.length > 0 &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative))
  );
}

/**
 * Resolves directory symlinks before containment checks so mutable Git metadata
 * cannot smuggle Codex writable roots outside the trusted common dir.
 */
function realpathContainedDirectory(
  args: RealpathContainedDirectoryArgs,
): RealpathContainedDirectoryResult {
  const realCandidatePath = realpathDirectoryIfPresent(args.candidatePath);
  if (!realCandidatePath) {
    return { status: "missing" };
  }
  if (!isPathInsideOrEqual(args.trustedParentPath, realCandidatePath)) {
    return { status: "escaped" };
  }
  return { status: "contained", path: realCandidatePath };
}

function isSafeGitHeadRef(ref: string): boolean {
  return (
    ref.startsWith("refs/") &&
    !path.isAbsolute(ref) &&
    !ref.includes("\\") &&
    !ref.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function addOptionalContainedDirectory(
  args: AddOptionalContainedDirectoryArgs,
): boolean {
  const result = realpathContainedDirectory({
    trustedParentPath: args.trustedParentPath,
    candidatePath: args.candidatePath,
  });
  switch (result.status) {
    case "contained":
      args.writableRoots.push(result.path);
      return true;
    case "missing":
      return true;
    case "escaped":
      return false;
  }
}

function addRefWritableRoots(args: AddRefWritableRootsArgs): boolean {
  if (!args.headRef || !isSafeGitHeadRef(args.headRef)) {
    return true;
  }

  // Missing ref/log dirs are valid; escaped existing dirs make the linked
  // worktree metadata untrusted, so reject all extra Git roots.
  const refsRoot = realpathContainedDirectory({
    trustedParentPath: args.commonDir,
    candidatePath: path.join(args.commonDir, "refs"),
  });
  if (refsRoot.status === "escaped") {
    return false;
  }
  if (
    refsRoot.status === "contained" &&
    !addOptionalContainedDirectory({
      trustedParentPath: refsRoot.path,
      candidatePath: path.dirname(path.join(args.commonDir, args.headRef)),
      writableRoots: args.writableRoots,
    })
  ) {
    return false;
  }

  const logsRefsRoot = realpathContainedDirectory({
    trustedParentPath: args.commonDir,
    candidatePath: path.join(args.commonDir, "logs", "refs"),
  });
  if (logsRefsRoot.status === "escaped") {
    return false;
  }
  if (
    logsRefsRoot.status === "contained" &&
    !addOptionalContainedDirectory({
      trustedParentPath: logsRefsRoot.path,
      candidatePath: path.dirname(
        path.join(args.commonDir, "logs", args.headRef),
      ),
      writableRoots: args.writableRoots,
    })
  ) {
    return false;
  }
  return true;
}

function addDetachedHeadWritableRoots(
  args: AddDetachedHeadWritableRootsArgs,
): boolean {
  return (
    addOptionalContainedDirectory({
      trustedParentPath: args.commonDir,
      candidatePath: path.join(args.commonDir, "refs", "heads"),
      writableRoots: args.writableRoots,
    }) &&
    addOptionalContainedDirectory({
      trustedParentPath: args.commonDir,
      candidatePath: path.join(args.commonDir, "logs", "refs", "heads"),
      writableRoots: args.writableRoots,
    })
  );
}

function gitWritableRootsForWorkspace(cwd: string | undefined): string[] {
  const workspacePath = cwd ? realpathDirectoryIfPresent(cwd) : null;
  if (!workspacePath) {
    return [];
  }

  const dotGitPath = path.join(workspacePath, ".git");
  const workspaceGitFile = regularFilePathInsideDirectoryIfPresent({
    filePath: dotGitPath,
    trustedParentPath: workspacePath,
  });
  if (!workspaceGitFile) {
    return [];
  }
  const dotGitContent = readTextFileIfPresent(workspaceGitFile);
  if (!dotGitContent) {
    return [];
  }
  const rawGitDir = parseGitDirPointer(dotGitContent);
  if (!rawGitDir) {
    return [];
  }
  const gitDir = realpathDirectoryIfPresent(
    resolveGitPath(workspacePath, rawGitDir),
  );
  if (!gitDir) {
    return [];
  }
  if (
    !linkedWorktreeGitDirBelongsToWorkspace({
      gitDir,
      workspaceGitFile,
      workspacePath,
    })
  ) {
    return [];
  }

  const commonDirCandidate = resolveCommonGitDir(gitDir);
  const commonDir = commonDirCandidate
    ? realpathDirectoryIfPresent(commonDirCandidate)
    : null;
  if (!commonDir) {
    return [];
  }

  const worktreesRoot = realpathContainedDirectory({
    trustedParentPath: commonDir,
    candidatePath: path.join(commonDir, "worktrees"),
  });
  if (
    worktreesRoot.status !== "contained" ||
    !isPathInsideOrEqual(worktreesRoot.path, gitDir)
  ) {
    return [];
  }

  const objectsRoot = realpathContainedDirectory({
    trustedParentPath: commonDir,
    candidatePath: path.join(commonDir, "objects"),
  });
  if (objectsRoot.status !== "contained") {
    // Missing objects or shared object stores/alternates may be legitimate Git
    // layouts, but Codex workspace-write should not follow object storage
    // outside this worktree's trusted common dir. Fall back to workspace-only
    // access.
    return [];
  }

  const writableRoots = [gitDir, objectsRoot.path];
  const headState = parseGitHeadState(
    readTextFileIfPresent(path.join(gitDir, "HEAD")),
  );
  switch (headState.type) {
    case "detached":
      if (!addDetachedHeadWritableRoots({ commonDir, writableRoots })) {
        return [];
      }
      break;
    case "ref":
      if (
        !addRefWritableRoots({
          commonDir,
          headRef: headState.ref,
          writableRoots,
        })
      ) {
        return [];
      }
      break;
    case "unsafe":
      break;
  }

  return [...new Set(writableRoots)];
}

function combineWorkspaceWriteRoots(
  roots: readonly string[],
  additionalRoots: readonly string[],
): string[] {
  return [...new Set([...additionalRoots, ...roots])];
}

function shouldCaptureWorkspaceWriteGitRoots(
  options: ProviderExecutionContext,
): boolean {
  return options.permissionMode === "workspace-write";
}

function toCodexThreadPermissionSettings(
  options: ProviderExecutionContext,
): CodexThreadPermissionSettings {
  const permissionPolicy = resolveAdapterPermissionPolicy(options);
  switch (permissionPolicy.permissionMode) {
    case "readonly":
      return {
        approvalPolicy: toEscalationApprovalPolicy(
          permissionPolicy.permissionEscalation,
        ),
        sandbox: "read-only",
      };
    case "workspace-write":
      return {
        approvalPolicy: toEscalationApprovalPolicy(
          permissionPolicy.permissionEscalation,
        ),
        sandbox: "workspace-write",
      };
    case "full":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
  }
}

function toCodexPermissionSettings(
  args: ToCodexPermissionSettingsArgs,
): CodexPermissionSettings {
  const permissionPolicy = resolveAdapterPermissionPolicy(args.options);
  switch (permissionPolicy.permissionMode) {
    case "readonly":
      return {
        approvalPolicy: toEscalationApprovalPolicy(
          permissionPolicy.permissionEscalation,
        ),
        sandbox: "read-only",
        sandboxPolicy: toReadonlyCodexSandboxPolicy(),
      };
    case "workspace-write":
      return {
        approvalPolicy: toEscalationApprovalPolicy(
          permissionPolicy.permissionEscalation,
        ),
        sandbox: "workspace-write",
        sandboxPolicy: toWorkspaceWriteCodexSandboxPolicy(
          combineWorkspaceWriteRoots(
            args.gitWritableRoots,
            args.additionalWorkspaceWriteRoots,
          ),
        ),
      };
    case "full":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

export type CodexEvent = CodexServerNotification;

export type CodexCommand = DistributiveOmit<CodexClientRequest, "id">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function toCodexServiceTier(tier: ServiceTier | undefined): "fast" | undefined {
  return tier === "fast" ? "fast" : undefined;
}

function toCodexUserInput(input: PromptInput[]): CodexUserInput[] {
  return input.map((chunk): CodexUserInput => {
    switch (chunk.type) {
      case "text":
        return { type: "text", text: chunk.text, text_elements: [] };
      case "image":
        return { type: "image", url: chunk.url };
      case "localImage":
        return { type: "localImage", path: chunk.path };
      case "localFile":
        return {
          type: "text",
          text: `[Attached file: ${chunk.path}]`,
          text_elements: [],
        };
    }
  });
}

function buildCodexConfig(
  args: BuildCodexConfigArgs,
): { [key in string]?: JsonValue } | undefined {
  const config: { [key in string]?: JsonValue } = {};
  if (args.threadId) {
    config["shell_environment_policy.set.BB_THREAD_ID"] = args.threadId;
  }
  const shellEnvironmentConfig = buildShellEnvironmentPolicyConfig(
    args.options?.envVars,
  );
  if (shellEnvironmentConfig) {
    Object.assign(config, shellEnvironmentConfig);
  }
  if (args.options?.reasoningLevel) {
    config["model_reasoning_effort"] = args.options.reasoningLevel;
  }
  config["features.default_mode_request_user_input"] = false;
  config["tools.web_search"] = {
    allowed_domains: null,
    context_size: null,
    location: null,
  };
  if (args.options?.permissionMode === "workspace-write") {
    const writableRoots = combineWorkspaceWriteRoots(
      args.gitWritableRoots,
      args.additionalWorkspaceWriteRoots,
    );
    if (writableRoots.length > 0) {
      config["sandbox_workspace_write.writable_roots"] = [...writableRoots];
    }
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

type CodexDynamicToolCommand = Extract<
  AdapterCommand,
  { type: "thread/start" | "thread/resume" }
>;

function toCodexDynamicTools(
  dynamicTools: CodexDynamicToolCommand["dynamicTools"],
): DynamicToolSpec[] | undefined {
  return dynamicTools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: jsonValueSchema.parse(tool.inputSchema),
  }));
}

// Raw shell output recovery is a two-phase flow:
// 1. `rawResponseItem/completed` for shell `function_call` and
//    `function_call_output` events is consumed into per-thread state keyed by
//    the provider's `call_id`.
// 2. The later normalized `item/completed` commandExecution consumes that
//    stored state to repair the authoritative final output.
const CODEX_SHELL_TOOL_NAMES = new Set(["exec_command", "Bash", "bash"]);
const TOOL_OUTPUT_MARKER_LINE = "Output:";
const TOOL_OUTPUT_METADATA_PREFIXES = [
  "Chunk ID:",
  "Wall time:",
  "Process exited with code ",
  "Original token count:",
];
// TODO(codex): Delete this compatibility shim once app-server exposes
// structured stdout/stderr for shell tools. rawResponseItem/completed currently
// carries UI-formatted text, so recovery must stay conservative and avoid
// persisting wrapper metadata when the framing shape is ambiguous.

interface CodexRecoveredCommandOutput {
  kind: "recovered";
  output: string;
}

interface CodexEmptyCommandOutput {
  kind: "empty";
}

interface CodexUnparseableCommandOutput {
  kind: "unparseable";
}

type CodexCapturedCommandOutput =
  | CodexRecoveredCommandOutput
  | CodexEmptyCommandOutput;
type CodexParsedCommandOutput =
  | CodexCapturedCommandOutput
  | CodexUnparseableCommandOutput;

interface CodexRawCommandOutputState {
  capturedCommandOutputByCallId: Map<string, CodexCapturedCommandOutput>;
  shellToolCallIds: Set<string>;
}

function toCodexRawNotification(
  event: ProviderRuntimeEvent,
  expectedMethod?: string,
): JsonRpcMessage | null {
  const rawMethod = typeof event.method === "string" ? event.method : undefined;
  if (expectedMethod && rawMethod !== expectedMethod) {
    return null;
  }
  const envelope = codexBridgeEnvelopeSchema.safeParse(event);
  if (!envelope.success) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    method: envelope.data.method,
    ...(envelope.data.params ? { params: envelope.data.params } : {}),
  };
}

function normalizeCommandOutputNewlines(output: string): string {
  return output.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

interface ParsedCodexOutputLine {
  line: string;
  nextIndex: number;
}

function readCodexOutputLine(
  text: string,
  startIndex: number,
): ParsedCodexOutputLine {
  const nextNewlineIndex = text.indexOf("\n", startIndex);
  if (nextNewlineIndex === -1) {
    return {
      line: text.slice(startIndex),
      nextIndex: text.length,
    };
  }
  return {
    line: text.slice(startIndex, nextNewlineIndex),
    nextIndex: nextNewlineIndex + 1,
  };
}

function isCodexToolOutputMetadataLine(line: string): boolean {
  return TOOL_OUTPUT_METADATA_PREFIXES.some((prefix) =>
    line.startsWith(prefix),
  );
}

function toCapturedCodexCommandOutput(
  output: string,
): CodexCapturedCommandOutput {
  return output.length === 0
    ? { kind: "empty" }
    : { kind: "recovered", output };
}

function findCodexOutputMarkerNextIndex(
  text: string,
  startIndex: number,
): number | null {
  let cursor = startIndex;
  while (cursor <= text.length) {
    const { line, nextIndex } = readCodexOutputLine(text, cursor);
    if (line === TOOL_OUTPUT_MARKER_LINE) {
      return nextIndex;
    }
    if (nextIndex >= text.length) {
      return null;
    }
    cursor = nextIndex;
  }
  return null;
}

function extractRecoveredCommandOutput(
  rawToolOutput: unknown,
): CodexParsedCommandOutput {
  const text = normalizeCommandOutputNewlines(extractResultText(rawToolOutput));
  if (text.length === 0) {
    return { kind: "empty" };
  }

  const firstLine = readCodexOutputLine(text, 0);
  if (firstLine.line === TOOL_OUTPUT_MARKER_LINE) {
    return toCapturedCodexCommandOutput(text.slice(firstLine.nextIndex));
  }

  if (!isCodexToolOutputMetadataLine(firstLine.line)) {
    return toCapturedCodexCommandOutput(text);
  }

  let cursor = firstLine.nextIndex;
  let metadataLineCount = 1;
  while (cursor <= text.length) {
    const { line, nextIndex } = readCodexOutputLine(text, cursor);
    if (line === TOOL_OUTPUT_MARKER_LINE) {
      return toCapturedCodexCommandOutput(text.slice(nextIndex));
    }
    if (!isCodexToolOutputMetadataLine(line)) {
      return findCodexOutputMarkerNextIndex(text, cursor) === null
        ? toCapturedCodexCommandOutput(text)
        : { kind: "unparseable" };
    }
    metadataLineCount += 1;
    if (nextIndex >= text.length) {
      return metadataLineCount === 1
        ? toCapturedCodexCommandOutput(text)
        : { kind: "unparseable" };
    }
    cursor = nextIndex;
  }

  return { kind: "unparseable" };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface CreateCodexProviderAdapterOptions extends ProviderAdapterFactoryOptions {
  processCommand?: string;
  processArgs?: string[];
}

export function createCodexProviderAdapter(
  opts?: CreateCodexProviderAdapterOptions,
): ProviderAdapter {
  const additionalWorkspaceWriteRoots =
    opts?.additionalWorkspaceWriteRoots ?? [];
  const providerInfo = getBuiltInAgentProviderInfo("codex");
  const capabilities: ProviderCapabilities = {
    supportsArchive: providerInfo.capabilities.supportsArchive,
    supportsRename: providerInfo.capabilities.supportsRename,
    supportsServiceTier: providerInfo.capabilities.supportsServiceTier,
    supportedPermissionModes:
      providerInfo.capabilities.supportedPermissionModes,
  };
  const nativeTurnStartClientRequestIdsByProviderThreadId = new Map<
    string,
    ClientTurnRequestId[]
  >();
  const pendingWorkspaceWriteGitWritableRootsByThreadId = new Map<
    string,
    string[]
  >();
  const workspaceWriteGitWritableRootsByThreadId = new Map<string, string[]>();
  const bbThreadIdByProviderThreadId = new Map<string, string>();
  const rawCommandOutputStateByProviderThreadId = new Map<
    string,
    CodexRawCommandOutputState
  >();

  function stageThreadGitWritableRoots(
    args: RecordThreadGitWritableRootsArgs,
  ): void {
    pendingWorkspaceWriteGitWritableRootsByThreadId.set(args.threadId, [
      ...args.writableRoots,
    ]);
  }

  function activateThreadGitWritableRoots(
    args: ActivateThreadGitWritableRootsArgs,
  ): void {
    const writableRoots = pendingWorkspaceWriteGitWritableRootsByThreadId.get(
      args.threadId,
    );
    if (!writableRoots) {
      return;
    }
    pendingWorkspaceWriteGitWritableRootsByThreadId.delete(args.threadId);
    workspaceWriteGitWritableRootsByThreadId.set(args.threadId, [
      ...writableRoots,
    ]);
    bbThreadIdByProviderThreadId.set(args.providerThreadId, args.threadId);
  }

  function clearGitWritableRootsByBbThreadId(
    args: ClearGitWritableRootsByBbThreadIdArgs,
  ): void {
    pendingWorkspaceWriteGitWritableRootsByThreadId.delete(args.threadId);
    workspaceWriteGitWritableRootsByThreadId.delete(args.threadId);
    for (const [providerThreadId, threadId] of bbThreadIdByProviderThreadId) {
      if (threadId === args.threadId) {
        bbThreadIdByProviderThreadId.delete(providerThreadId);
      }
    }
  }

  function clearGitWritableRootsByProviderThreadId(
    args: ClearGitWritableRootsByProviderThreadIdArgs,
  ): void {
    const threadId = bbThreadIdByProviderThreadId.get(args.providerThreadId);
    bbThreadIdByProviderThreadId.delete(args.providerThreadId);
    if (!threadId) {
      return;
    }
    clearGitWritableRootsByBbThreadId({ threadId });
  }

  function prepareWorkspaceWriteGitRoots(
    args: PrepareWorkspaceWriteGitRootsArgs,
  ): PreparedWorkspaceWriteGitRoots {
    const command = args.command;
    const captureWorkspaceWriteGitRoots = shouldCaptureWorkspaceWriteGitRoots(
      command.options,
    );
    const writableRoots = captureWorkspaceWriteGitRoots
      ? gitWritableRootsForWorkspace(command.cwd)
      : [];
    if (captureWorkspaceWriteGitRoots) {
      stageThreadGitWritableRoots({
        threadId: command.threadId,
        writableRoots,
      });
    } else {
      clearGitWritableRootsByBbThreadId({ threadId: command.threadId });
    }
    return {
      config: buildCodexConfig({
        additionalWorkspaceWriteRoots,
        gitWritableRoots: writableRoots,
        options: command.options,
        threadId: command.threadId,
      }),
      permissionSettings: toCodexThreadPermissionSettings(command.options),
    };
  }

  function getRawCommandOutputState(
    providerThreadId: string,
  ): CodexRawCommandOutputState {
    const existingState =
      rawCommandOutputStateByProviderThreadId.get(providerThreadId);
    if (existingState) {
      return existingState;
    }

    const nextState: CodexRawCommandOutputState = {
      capturedCommandOutputByCallId: new Map<
        string,
        CodexCapturedCommandOutput
      >(),
      shellToolCallIds: new Set<string>(),
    };
    rawCommandOutputStateByProviderThreadId.set(providerThreadId, nextState);
    return nextState;
  }

  function pruneRawCommandOutputState(providerThreadId: string): void {
    const state = rawCommandOutputStateByProviderThreadId.get(providerThreadId);
    if (!state) {
      return;
    }
    if (
      state.capturedCommandOutputByCallId.size === 0 &&
      state.shellToolCallIds.size === 0
    ) {
      rawCommandOutputStateByProviderThreadId.delete(providerThreadId);
    }
  }

  function clearClosedThreadState(event: ProviderRuntimeEvent): void {
    const rawEvent = toCodexRawNotification(event, "thread/closed");
    if (!rawEvent) {
      return;
    }
    const paramsResult = codexThreadClosedParamsSchema.safeParse(
      rawEvent.params,
    );
    if (!paramsResult.success) {
      return;
    }
    rawCommandOutputStateByProviderThreadId.delete(paramsResult.data.threadId);
    clearGitWritableRootsByProviderThreadId({
      providerThreadId: paramsResult.data.threadId,
    });
  }

  function queueNativeTurnStartClientRequestId(args: {
    clientRequestId: ClientTurnRequestId | undefined;
    providerThreadId: string | undefined;
  }): PreparedProviderCommandDispatch | null {
    if (
      args.clientRequestId === undefined ||
      args.providerThreadId === undefined
    ) {
      return null;
    }
    const clientRequestId = args.clientRequestId;
    const providerThreadId = args.providerThreadId;
    nativeTurnStartClientRequestIdsByProviderThreadId.set(providerThreadId, [
      ...(nativeTurnStartClientRequestIdsByProviderThreadId.get(
        providerThreadId,
      ) ?? []),
      clientRequestId,
    ]);

    return {
      rollback: () => {
        removeNativeTurnStartClientRequestId({
          clientRequestId,
          providerThreadId,
        });
      },
    };
  }

  function removeNativeTurnStartClientRequestId(args: {
    clientRequestId: ClientTurnRequestId;
    providerThreadId: string;
  }): void {
    const sequences = nativeTurnStartClientRequestIdsByProviderThreadId.get(
      args.providerThreadId,
    );
    if (!sequences || sequences.length === 0) {
      return;
    }
    const nextSequences = [...sequences];
    const sequenceIndex = nextSequences.indexOf(args.clientRequestId);
    if (sequenceIndex === -1) {
      return;
    }
    nextSequences.splice(sequenceIndex, 1);
    if (nextSequences.length === 0) {
      nativeTurnStartClientRequestIdsByProviderThreadId.delete(
        args.providerThreadId,
      );
      return;
    }
    nativeTurnStartClientRequestIdsByProviderThreadId.set(
      args.providerThreadId,
      nextSequences,
    );
  }

  function shiftNativeTurnStartClientRequestId(
    providerThreadId: string,
  ): ClientTurnRequestId | undefined {
    const sequences =
      nativeTurnStartClientRequestIdsByProviderThreadId.get(providerThreadId);
    if (!sequences || sequences.length === 0) {
      return undefined;
    }
    const [clientRequestId, ...remainingSequences] = sequences;
    if (remainingSequences.length === 0) {
      nativeTurnStartClientRequestIdsByProviderThreadId.delete(
        providerThreadId,
      );
    } else {
      nativeTurnStartClientRequestIdsByProviderThreadId.set(
        providerThreadId,
        remainingSequences,
      );
    }
    return clientRequestId;
  }

  function attachAcceptedUserMessageCorrelation(
    event: ThreadEvent,
  ): ThreadEvent[] {
    if (event.type === "turn/completed") {
      if (event.providerThreadId !== null) {
        nativeTurnStartClientRequestIdsByProviderThreadId.delete(
          event.providerThreadId,
        );
      }
      return [event];
    }

    if (event.type === "turn/started") {
      const clientRequestId = shiftNativeTurnStartClientRequestId(
        event.providerThreadId,
      );
      if (clientRequestId === undefined) {
        return [event];
      }
      const turnId = requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      });
      return [
        event,
        {
          type: "turn/input/accepted",
          threadId: event.threadId,
          providerThreadId: event.providerThreadId,
          scope: turnScope(turnId),
          clientRequestId,
        },
      ];
    }

    if (
      (event.type !== "item/started" && event.type !== "item/completed") ||
      event.item.type !== "userMessage"
    ) {
      return [event];
    }

    return [];
  }

  function consumeCodexRawResponseItem(event: ProviderRuntimeEvent): boolean {
    const rawEvent = toCodexRawNotification(event, "rawResponseItem/completed");
    if (!rawEvent) {
      return false;
    }

    const paramsResult = codexRawResponseItemCompletedParamsSchema.safeParse(
      rawEvent.params,
    );
    if (!paramsResult.success) {
      return true;
    }

    const { threadId: providerThreadId, item } = paramsResult.data;

    if (item.type === "function_call") {
      if (!CODEX_SHELL_TOOL_NAMES.has(item.name)) {
        return true;
      }
      getRawCommandOutputState(providerThreadId).shellToolCallIds.add(
        item.call_id,
      );
      return true;
    }

    if (item.type === "function_call_output") {
      const rawCommandOutputState =
        rawCommandOutputStateByProviderThreadId.get(providerThreadId);
      if (!rawCommandOutputState) {
        return true;
      }
      if (!rawCommandOutputState.shellToolCallIds.has(item.call_id)) {
        pruneRawCommandOutputState(providerThreadId);
        return true;
      }

      const recoveredOutput = extractRecoveredCommandOutput(item.output);
      if (recoveredOutput.kind !== "unparseable") {
        rawCommandOutputState.capturedCommandOutputByCallId.set(
          item.call_id,
          recoveredOutput,
        );
      }
      pruneRawCommandOutputState(providerThreadId);
      return true;
    }

    if (item.type === "local_shell_call") {
      // TODO(codex): The checked-in live raw fixture currently shows shell
      // execution as function_call(exec_command) + function_call_output. If
      // app-server starts emitting local_shell_call with recoverable output,
      // extend this repair path with a real captured fixture first.
      return true;
    }

    if (
      item.type === "custom_tool_call" ||
      item.type === "custom_tool_call_output"
    ) {
      // TODO(codex): Keep this explicit so shell recovery does not silently
      // assume custom_tool_call traffic is equivalent to exec_command.
      return true;
    }

    return true;
  }

  function reconcileRawCommandOutputLifecycle(events: ThreadEvent[]): void {
    for (const event of events) {
      if (event.type === "turn/completed") {
        if (event.providerThreadId !== null) {
          rawCommandOutputStateByProviderThreadId.delete(
            event.providerThreadId,
          );
        }
      }
    }
  }

  function consumeCapturedCommandOutput(args: {
    commandExecutionId: string;
    providerThreadId: string;
  }): CodexCapturedCommandOutput | undefined {
    const rawCommandOutputState = rawCommandOutputStateByProviderThreadId.get(
      args.providerThreadId,
    );
    if (!rawCommandOutputState) {
      return undefined;
    }

    const capturedOutput =
      rawCommandOutputState.capturedCommandOutputByCallId.get(
        args.commandExecutionId,
      );
    rawCommandOutputState.shellToolCallIds.delete(args.commandExecutionId);
    rawCommandOutputState.capturedCommandOutputByCallId.delete(
      args.commandExecutionId,
    );
    pruneRawCommandOutputState(args.providerThreadId);
    return capturedOutput;
  }

  function applyRecoveredCommandOutput(events: ThreadEvent[]): ThreadEvent[] {
    const repairedEvents: ThreadEvent[] = [];
    for (const event of events) {
      if (
        event.type !== "item/completed" ||
        event.item.type !== "commandExecution"
      ) {
        repairedEvents.push(event);
        continue;
      }

      const capturedOutput = consumeCapturedCommandOutput({
        commandExecutionId: event.item.id,
        providerThreadId: event.providerThreadId,
      });
      if (capturedOutput === undefined) {
        repairedEvents.push(event);
        continue;
      }

      if (
        capturedOutput.kind === "recovered" &&
        event.item.aggregatedOutput === capturedOutput.output
      ) {
        repairedEvents.push(event);
        continue;
      }

      if (capturedOutput.kind === "empty") {
        if (event.item.aggregatedOutput === undefined) {
          repairedEvents.push(event);
          continue;
        }
        const { aggregatedOutput: _aggregatedOutput, ...itemWithoutOutput } =
          event.item;
        repairedEvents.push({
          ...event,
          item: itemWithoutOutput,
        });
        continue;
      }

      repairedEvents.push({
        ...event,
        item: {
          ...event.item,
          aggregatedOutput: capturedOutput.output,
        },
      });
    }
    return repairedEvents;
  }

  return {
    id: providerInfo.id,
    displayName: providerInfo.displayName,
    capabilities,
    // The Codex app-server accepts new turns after turn/interrupt, but the
    // next turn can sit idle for ~30s while the interrupted session drains.
    // Restarting forces the next command through thread/resume on a fresh
    // app-server process.
    process: {
      command: opts?.processCommand ?? "codex",
      args: opts?.processArgs ?? ["app-server"],
    },

    buildCommandPlan(command: AdapterCommand): ProviderCommandPlan {
      switch (command.type) {
        case "initialize":
          return {
            kind: "request",
            method: "initialize",
            params: {
              clientInfo: { name: "bb", version: "1.0.0", title: null },
              capabilities: { experimentalApi: true },
            },
          };
        case "model/list":
          return {
            kind: "request",
            method: "model/list",
            params: {},
          };
        case "thread/start": {
          const dynamicTools = toCodexDynamicTools(command.dynamicTools);
          const preparedGitRoots = prepareWorkspaceWriteGitRoots({ command });
          const params: ThreadStartParams = {
            approvalPolicy: preparedGitRoots.permissionSettings.approvalPolicy,
            sandbox: preparedGitRoots.permissionSettings.sandbox,
            cwd: command.cwd,
            ...resolveCodexInstructionOverrides(command),
            model: command.options?.model ?? undefined,
            serviceTier: toCodexServiceTier(command.options?.serviceTier),
            config: preparedGitRoots.config ?? undefined,
            // Codex only exposes raw Responses items as a thread/start opt-in.
            experimentalRawEvents: true,
            persistExtendedHistory: false,
            ...(dynamicTools && dynamicTools.length > 0
              ? { dynamicTools }
              : {}),
          };
          return {
            kind: "request",
            method: "thread/start",
            params,
          };
        }
        case "thread/resume": {
          const dynamicTools = toCodexDynamicTools(command.dynamicTools);
          const preparedGitRoots = prepareWorkspaceWriteGitRoots({ command });
          const params: ThreadResumeParams = {
            threadId: command.providerThreadId,
            approvalPolicy: preparedGitRoots.permissionSettings.approvalPolicy,
            sandbox: preparedGitRoots.permissionSettings.sandbox,
            cwd: command.cwd,
            ...resolveCodexInstructionOverrides(command),
            model: command.options?.model ?? undefined,
            serviceTier: toCodexServiceTier(command.options?.serviceTier),
            config: preparedGitRoots.config ?? undefined,
            persistExtendedHistory: false,
            ...(dynamicTools && dynamicTools.length > 0
              ? { dynamicTools }
              : {}),
          };
          return {
            kind: "request",
            method: "thread/resume",
            params,
          };
        }
        case "turn/start": {
          const writableRoots =
            workspaceWriteGitWritableRootsByThreadId.get(command.threadId) ??
            [];
          const permissionSettings = toCodexPermissionSettings({
            additionalWorkspaceWriteRoots,
            gitWritableRoots: writableRoots,
            options: command.options,
          });
          return {
            kind: "request",
            method: "turn/start",
            params: {
              threadId: command.providerThreadId,
              input: toCodexUserInput(command.input),
              approvalPolicy: permissionSettings.approvalPolicy,
              sandboxPolicy: permissionSettings.sandboxPolicy,
              model: command.options?.model ?? undefined,
              serviceTier: toCodexServiceTier(command.options?.serviceTier),
            },
          };
        }
        case "turn/steer":
          return {
            kind: "request",
            method: "turn/steer",
            params: {
              threadId: command.providerThreadId,
              expectedTurnId: command.expectedTurnId,
              input: toCodexUserInput(command.input),
            },
          };
        case "thread/name/set":
          if (!capabilities.supportsRename) {
            return { kind: "noop", reason: "rename unsupported" };
          }
          return {
            kind: "request",
            method: "thread/name/set",
            params: {
              threadId: command.providerThreadId,
              name: command.title,
            },
          };
        case "thread/archive":
          if (!capabilities.supportsArchive) {
            return { kind: "noop", reason: "archive unsupported" };
          }
          return {
            kind: "request",
            method: "thread/archive",
            params: {
              threadId: command.providerThreadId,
            },
          };
        case "thread/unarchive":
          if (!capabilities.supportsArchive) {
            return { kind: "noop", reason: "archive unsupported" };
          }
          return {
            kind: "request",
            method: "thread/unarchive",
            params: {
              threadId: command.providerThreadId,
            },
          };
        case "thread/stop":
          if (command.activeTurnId === null) {
            return { kind: "noop", reason: "no active turn to interrupt" };
          }
          return {
            kind: "request",
            method: "turn/interrupt",
            processEffect: "restart-provider",
            params: {
              threadId: command.providerThreadId,
              turnId: command.activeTurnId,
            },
          };
      }
    },

    prepareTurnStart(command) {
      return queueNativeTurnStartClientRequestId({
        clientRequestId: command.clientRequestId,
        providerThreadId: command.providerThreadId,
      });
    },

    translateEvent(event: ProviderRuntimeEvent) {
      clearClosedThreadState(event);
      if (consumeCodexRawResponseItem(event)) {
        return [];
      }

      const translatedEvents = translateCodexEvent(event).flatMap(
        attachAcceptedUserMessageCorrelation,
      );
      reconcileRawCommandOutputLifecycle(translatedEvents);
      return applyRecoveredCommandOutput(translatedEvents);
    },

    translateAcceptedCommand({ command, providerThreadId }) {
      if (
        (command.type === "thread/start" || command.type === "thread/resume") &&
        providerThreadId
      ) {
        activateThreadGitWritableRoots({
          providerThreadId,
          threadId: command.threadId,
        });
      }
      if (command.type !== "turn/steer") {
        return [];
      }
      return buildAcceptedUserMessageEvent({
        clientRequestId: command.clientRequestId,
        providerThreadId: command.providerThreadId,
        threadId: command.threadId,
        turnId: command.expectedTurnId,
      });
    },

    decodeToolCallRequest(
      request: ProviderInboundRequest,
    ): DecodedToolCallRequest | null {
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }
      return decodeNativeProviderToolCallRequest(
        request.id,
        request.method,
        request.params,
      );
    },

    decodeInteractiveRequest(request: ProviderInboundRequest) {
      return decodeCodexInteractiveRequest(request);
    },

    buildInteractiveResponse(args) {
      return buildCodexInteractiveResponse(args);
    },

    parseModelListResult(result: unknown) {
      // Codex's upstream API only exposes an active model list; legacy/retired
      // models aren't surfaced separately, so selectedOnlyModels is always empty.
      return {
        models: parseModelsResponse(result),
        selectedOnlyModels: [],
      };
    },
  };
}
