import { WorkspaceError, type GitCommandResult } from "./git.js";
import { readTerminalOutputLines } from "./terminal-output.js";

export interface ProvisioningTranscriptEntry {
  type: "step" | "output";
  key: string;
  text: string;
  startedAt?: number;
  status?: "started" | "completed" | "failed";
  metadata?: Record<string, unknown>;
}

export type ProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

export interface EmitStepArgs {
  onProgress: ProgressCallback | undefined;
  key: string;
  text: string;
  status: "started" | "completed" | "failed";
  startedAt?: number;
  metadata?: ProvisioningTranscriptEntry["metadata"];
}

export function emitStep(args: EmitStepArgs): void {
  args.onProgress?.({
    type: "step",
    key: args.key,
    text: args.text,
    status: args.status,
    startedAt: args.startedAt ?? Date.now(),
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
  });
}

export function emitOutput(
  onProgress: ProgressCallback | undefined,
  key: string,
  text: string,
): void {
  onProgress?.({ type: "output", key, text, startedAt: Date.now() });
}

export function emitCwd(args: {
  onProgress: ProgressCallback | undefined;
  keySuffix: string;
  cwd: string;
}): void {
  emitStep({
    onProgress: args.onProgress,
    key: `workspace-${args.keySuffix}`,
    text: `Using workspace: ${args.cwd}`,
    status: "completed",
  });
}

export function emitGitOutput(
  onProgress: ProgressCallback | undefined,
  key: string,
  result: GitCommandResult,
): void {
  const lines = readTerminalOutputLines(result.stdout + result.stderr);
  if (lines.length === 0) {
    return;
  }
  let index = 0;
  for (const line of lines) {
    index += 1;
    emitOutput(onProgress, `${key}-output-${index}`, line);
  }
}

export function createProvisionCancelledError(cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    "Workspace provisioning was cancelled",
    { cause },
  );
}

export function throwIfProvisionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createProvisionCancelledError(signal.reason);
  }
}

export function isProvisionAbortError(error: unknown): boolean {
  return (
    error instanceof WorkspaceError && error.code === "provision_cancelled"
  );
}
