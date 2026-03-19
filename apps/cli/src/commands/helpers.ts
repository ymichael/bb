import { createInterface } from "node:readline/promises";
import type {
  CommitEnvironmentOperationResponse,
  SquashMergeEnvironmentOperationResponse,
} from "@bb/core";

/**
 * Print data as formatted JSON and return true, or return false if --json was not requested.
 * Use this as the single JSON output path for all CLI commands.
 */
export function outputJson(opts: { json?: boolean }, data: unknown): boolean {
  if (!opts.json) return false;
  console.log(JSON.stringify(data, null, 2));
  return true;
}

/**
 * Resolve a thread ID for mutating commands that support `--self`.
 *
 * - Positional `<id>` and `--self` are mutually exclusive.
 * - `--self` resolves from BB_THREAD_ID.
 * - If neither is provided, error with guidance.
 */
export function resolveThreadIdOrSelf(
  positionalId: string | undefined,
  opts: { self?: boolean },
): string {
  if (opts.self && positionalId) {
    throw new Error("Cannot combine a thread ID argument with --self.");
  }
  if (opts.self) {
    const envThreadId = process.env.BB_THREAD_ID?.trim();
    if (!envThreadId) {
      throw new Error("--self requires BB_THREAD_ID to be set.");
    }
    return envThreadId;
  }
  if (positionalId) {
    return positionalId;
  }
  throw new Error(
    "Provide a thread ID or use --self to target the current thread.",
  );
}

export interface ResolvedId {
  id: string;
  /** "arg" when provided as a positional/flag, "env" when resolved from the environment variable. */
  source: "arg" | "env";
}

/**
 * Resolve a thread ID for read-only commands.  Returns the resolved ID and its
 * source so the caller can print a context label when the value came from the
 * environment variable.
 */
export function resolveThreadIdWithLabel(
  positionalId: string | undefined,
): ResolvedId {
  if (positionalId) {
    return { id: positionalId, source: "arg" };
  }
  const envValue = process.env.BB_THREAD_ID?.trim();
  if (envValue) {
    return { id: envValue, source: "env" };
  }
  throw new Error("Missing thread context. Pass <threadId> or set BB_THREAD_ID.");
}

/**
 * Resolve a project ID for read-only commands.  Returns the resolved ID and its
 * source so the caller can print a context label when the value came from the
 * environment variable.
 */
export function resolveProjectIdWithLabel(
  flagValue: string | undefined,
): ResolvedId {
  if (flagValue) {
    return { id: flagValue, source: "arg" };
  }
  const envValue = process.env.BB_PROJECT_ID?.trim();
  if (envValue) {
    return { id: envValue, source: "env" };
  }
  throw new Error(
    "Missing project context. Pass a project ID (for example --project <id>) or set BB_PROJECT_ID.",
  );
}

/**
 * Print a context label to stderr when a fallback env ID was used (human output only).
 */
export function printContextLabel(
  resolved: ResolvedId,
  kind: "Thread" | "Project",
  envVar: string,
  opts: { json?: boolean },
): void {
  if (opts.json) return;
  if (resolved.source === "env") {
    console.error(`${kind} ${resolved.id} (from ${envVar})`);
  }
}

export function printEnvironmentGitOperationResult(
  result: CommitEnvironmentOperationResponse | SquashMergeEnvironmentOperationResponse,
): void {
  const flags = [
    ...(result.operation === "commit"
      ? [result.commitCreated ? "committed" : "noop"]
      : [result.merged ? "merged" : "noop"]),
    ...(result.autoArchived ? ["archived"] : []),
  ];
  console.log(`${result.message} [${flags.join(", ")}]`);
}

export async function confirmDestructiveAction(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Refusing destructive action without an interactive terminal. Re-run with --yes to confirm.",
    );
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await readline.question(`${message} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    readline.close();
  }
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
