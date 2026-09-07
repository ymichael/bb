import { loadCliConfig, type CliConfig } from "@bb/config/cli";
import { toOptionalString } from "@bb/config/strings";

const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface CliRuntimeContext {
  cliConfig: CliConfig;
}

interface CreateCliRuntimeContextArgs {
  cliConfig?: CliConfig;
}

interface ResolveExplicitIdFlagArgs {
  flagName: string;
  value?: string;
}

export function createCliRuntimeContext(
  args: CreateCliRuntimeContextArgs = {},
): CliRuntimeContext {
  return {
    cliConfig: args.cliConfig ?? loadCliConfig(),
  };
}

function validateId(value: string, source: string): string {
  if (!VALID_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ID from ${source}: "${value}". IDs must contain only letters, digits, hyphens, and underscores.`,
    );
  }
  return value;
}

export function resolveServerUrl(context: CliRuntimeContext): string {
  return context.cliConfig.BB_SERVER_URL;
}

export function resolveContextProjectId(): string | undefined {
  const fromEnv = toOptionalString(process.env.BB_PROJECT_ID);
  if (fromEnv) return validateId(fromEnv, "BB_PROJECT_ID");
  return undefined;
}

export function resolveContextThreadId(): string | undefined {
  const fromEnv = toOptionalString(process.env.BB_THREAD_ID);
  if (fromEnv) return validateId(fromEnv, "BB_THREAD_ID");
  return undefined;
}

export function resolveExplicitIdFlag(
  args: ResolveExplicitIdFlagArgs,
): string | undefined {
  const fromFlag = toOptionalString(args.value);
  if (fromFlag) return validateId(fromFlag, args.flagName);
  return undefined;
}

export function requireThreadId(positionalId?: string): string {
  const threadId = resolveExplicitIdFlag({
    flagName: "<threadId> argument",
    value: positionalId,
  });
  if (threadId) return threadId;
  throw new Error("Missing thread ID. Pass <threadId>.");
}

export interface ResolvedId {
  id: string;
  source: "arg" | "env";
}

interface ThreadSelfTargetOptions {
  self?: boolean;
}

export function requireThreadIdOrSelf(
  positionalId: string | undefined,
  opts: ThreadSelfTargetOptions,
): string {
  if (opts.self && positionalId) {
    throw new Error("Cannot combine a thread ID argument with --self.");
  }
  if (opts.self) {
    const envThreadId = resolveContextThreadId();
    if (!envThreadId) {
      throw new Error("--self requires BB_THREAD_ID to be set.");
    }
    return envThreadId;
  }
  if (positionalId) {
    return validateId(positionalId, "<threadId> argument");
  }
  throw new Error("Missing thread ID. Pass <threadId> or use --self.");
}

export interface ContextSnapshot {
  projectId?: string;
  threadId?: string;
  serverUrl: string;
}

export function resolveContextSnapshot(
  context: CliRuntimeContext = createCliRuntimeContext(),
): ContextSnapshot {
  return {
    projectId: resolveContextProjectId(),
    threadId: resolveContextThreadId(),
    serverUrl: context.cliConfig.BB_SERVER_URL,
  };
}
