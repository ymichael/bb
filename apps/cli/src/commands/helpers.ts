import { createInterface } from "node:readline/promises";
import { reasoningLevelSchema, type ReasoningLevel } from "@bb/domain";
import type {
  CommitActionResponse,
  SquashMergeActionResponse,
} from "@bb/server-contract";
import type { ResolvedId } from "../context-env.js";

export {
  type ResolvedId,
  type ThreadSelfTargetOptions,
  requireProjectIdWithLabel,
  requireThreadIdWithLabel,
  requireThreadIdWithLabelOrSelf,
  requireThreadIdOrSelf,
} from "../context-env.js";

const REASONING_LEVELS: ReasoningLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface JsonOutputOptions {
  json?: boolean;
}

/**
 * Print data as formatted JSON and return true, or return false if --json was not requested.
 * Use this as the single JSON output path for all CLI commands.
 */
export function outputJson(opts: JsonOutputOptions, data: unknown): boolean {
  if (!opts.json) return false;
  console.log(JSON.stringify(data, null, 2));
  return true;
}

/**
 * Print a context label to stderr when a fallback env ID was used (human output only).
 */
export function printContextLabel(
  resolved: ResolvedId,
  kind: "Thread" | "Project",
  envVar: string,
  opts: JsonOutputOptions,
): void {
  if (opts.json) return;
  if (resolved.source === "env") {
    console.error(`${kind} ${resolved.id} (from ${envVar})`);
  }
}

export function printEnvironmentGitOperationResult(
  result: CommitActionResponse | SquashMergeActionResponse,
): void {
  const flags = [
    ...(result.action === "commit"
      ? ["committed"]
      : [result.merged ? "merged" : "noop"]),
  ];
  console.log(`${result.message} [${flags.join(", ")}]`);
}

export async function confirmDestructiveAction(
  message: string,
): Promise<boolean> {
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

export function parseReasoningLevel(
  value: string | undefined,
): ReasoningLevel | undefined {
  if (value === undefined) return undefined;
  const parsed = reasoningLevelSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(
    `Invalid reasoning level '${value}'. Expected ${joinValues(REASONING_LEVELS)}.`,
  );
}

export function prependErrorContext(context: string, err: unknown): Error {
  return new Error(`${context}: ${getErrorMessage(err)}`);
}

export function joinValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(" or ");
}
