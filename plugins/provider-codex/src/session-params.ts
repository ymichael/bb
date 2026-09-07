import {
  jsonValueSchema,
  type PermissionEscalation,
  type PromptInput,
  type ReasoningLevel,
  type RuntimePermissionPolicy,
  type ServiceTier,
  buildShellEnvOverrides,
} from "@get-bb/plugin-sdk/provider-bridge";
import fs from "node:fs";
import path from "node:path";
import type { ReasoningEffort as CodexReasoningEffort } from "./generated/codex-app-server/schema/ReasoningEffort.js";
import type { JsonValue } from "./generated/codex-app-server/schema/serde_json/JsonValue.js";
import type { SandboxPolicy } from "./generated/codex-app-server/schema/v2/SandboxPolicy.js";
import type { DynamicToolSpec } from "./generated/codex-app-server/schema/v2/DynamicToolSpec.js";
import type { SandboxMode as CodexSandboxMode } from "./generated/codex-app-server/schema/v2/SandboxMode.js";
import type { ThreadStartParams } from "./generated/codex-app-server/schema/v2/ThreadStartParams.js";
import type { UserInput as CodexUserInput } from "./generated/codex-app-server/schema/v2/UserInput.js";
import type { AskForApproval } from "./generated/codex-app-server/schema/v2/AskForApproval.js";
import type { ApprovalsReviewer } from "./generated/codex-app-server/schema/v2/ApprovalsReviewer.js";
import { mapBbReasoningLevelToCodex } from "./models.js";

export type CodexSessionOptions = {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  memoryEnabled?: boolean;
  providerSubagentsEnabled?: boolean;
  instructions?: string;
  envVars?: Record<string, string>;
} & RuntimePermissionPolicy;

interface CodexPermissionSettings {
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: CodexSandboxMode;
  sandboxPolicy: SandboxPolicy;
}

export interface CodexThreadPermissionSettings {
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: CodexSandboxMode;
}

export type BbThreadStartParams = ThreadStartParams & {
  experimentalRawEvents?: boolean;
  dynamicTools?: DynamicToolSpec[];
};

export type BbThreadForkParams = {
  threadId: string;
  lastTurnId?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: CodexSandboxMode | null;
  config?: { [key in string]?: JsonValue } | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  dynamicTools?: DynamicToolSpec[];
};

interface ToCodexPermissionSettingsArgs {
  additionalWorkspaceWriteRoots: readonly string[];
  gitWritableRoots: readonly string[];
  options: CodexSessionOptions;
}

interface BuildCodexConfigArgs {
  additionalWorkspaceWriteRoots: readonly string[];
  gitWritableRoots: readonly string[];
  options?: CodexSessionOptions;
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

interface CodexInstructionSource {
  instructionMode: "append" | "replace";
  options: { instructions?: string };
}

interface CodexInstructionOverrides {
  baseInstructions?: ThreadStartParams["baseInstructions"];
  developerInstructions?: ThreadStartParams["developerInstructions"];
}

export function resolveCodexInstructionOverrides(
  command: CodexInstructionSource,
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
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function toEscalationApprovalPolicy(
  escalation: PermissionEscalation,
): AskForApproval {
  return escalation === "deny" ? "never" : "on-request";
}

function toWorkspaceApprovalPolicy(options: {
  approvalReviewer: "automatic" | "user";
  permissionEscalation: PermissionEscalation;
}): AskForApproval {
  if (options.approvalReviewer === "automatic") {
    return "on-request";
  }
  return toEscalationApprovalPolicy(options.permissionEscalation);
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

export function gitWritableRootsForWorkspace(
  cwd: string | undefined,
): string[] {
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

export function combineWorkspaceWriteRoots(
  roots: readonly string[],
  additionalRoots: readonly string[],
): string[] {
  return [...new Set([...additionalRoots, ...roots])];
}

export function shouldCaptureWorkspaceWriteGitRoots(
  options: CodexSessionOptions,
): boolean {
  return options.permissionScope === "workspace";
}

function toCodexApprovalsReviewer(
  options: CodexSessionOptions,
): ApprovalsReviewer {
  return options.approvalReviewer === "automatic" ? "auto_review" : "user";
}

export function toCodexThreadPermissionSettings(
  options: CodexSessionOptions,
): CodexThreadPermissionSettings {
  const permissionPolicy = options;
  switch (permissionPolicy.permissionScope) {
    case "workspace":
      return {
        approvalPolicy: toWorkspaceApprovalPolicy(permissionPolicy),
        approvalsReviewer: toCodexApprovalsReviewer(options),
        sandbox: "workspace-write",
      };
    case "full":
      return {
        approvalPolicy: "never",
        approvalsReviewer: toCodexApprovalsReviewer(options),
        sandbox: "danger-full-access",
      };
  }
}

export function toCodexPermissionSettings(
  args: ToCodexPermissionSettingsArgs,
): CodexPermissionSettings {
  const permissionPolicy = args.options;
  switch (permissionPolicy.permissionScope) {
    case "workspace":
      return {
        approvalPolicy: toWorkspaceApprovalPolicy(permissionPolicy),
        approvalsReviewer: toCodexApprovalsReviewer(args.options),
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
        approvalsReviewer: toCodexApprovalsReviewer(args.options),
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

export function toCodexServiceTier(
  tier: ServiceTier | undefined,
): "fast" | undefined {
  return tier === "fast" ? "fast" : undefined;
}

export function toCodexReasoningEffort(
  reasoningLevel: ReasoningLevel,
): CodexReasoningEffort {
  const codexEffort = mapBbReasoningLevelToCodex(reasoningLevel);
  if (codexEffort == null) {
    throw new Error(
      `Codex does not support the ${reasoningLevel} reasoning level.`,
    );
  }
  return codexEffort;
}

export function toCodexUserInput(input: PromptInput[]): CodexUserInput[] {
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

function buildShellEnvironmentPolicyConfig(
  envVars?: Record<string, string>,
): Record<string, string> | undefined {
  if (!envVars) {
    return undefined;
  }
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(buildShellEnvOverrides(envVars))) {
    config[`shell_environment_policy.set.${key}`] = value;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

export function buildCodexConfig(
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
    config["model_reasoning_effort"] = toCodexReasoningEffort(
      args.options.reasoningLevel,
    );
  }
  config["features.default_mode_request_user_input"] = false;
  if (args.options?.providerSubagentsEnabled === false) {
    config["features.multi_agent"] = false;
    config["features.multi_agent_v2.max_concurrent_threads_per_session"] = 1;
  }
  config["memories.use_memories"] = args.options?.memoryEnabled ?? true;
  config["memories.generate_memories"] = args.options?.memoryEnabled ?? true;
  if (args.options?.permissionScope === "workspace") {
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

interface CodexDynamicToolInput {
  name: string;
  description: string;
  inputSchema: unknown;
}

export function toCodexDynamicTools(
  dynamicTools: readonly CodexDynamicToolInput[] | undefined,
): DynamicToolSpec[] | undefined {
  return dynamicTools?.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: jsonValueSchema.parse(tool.inputSchema),
  }));
}
