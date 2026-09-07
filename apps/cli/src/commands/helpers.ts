import { createInterface } from "node:readline/promises";
import {
  PERSONAL_PROJECT_ID,
  reasoningLevelSchema,
  reasoningLevelValues,
  type ReasoningLevel,
} from "@bb/domain";
import type { CommitActionResponse } from "@bb/server-contract";
import type { ResolvedId } from "../context-env.js";

export {
  type ResolvedId,
  requireThreadId,
  requireThreadIdOrSelf,
} from "../context-env.js";

const REASONING_LEVELS: readonly ReasoningLevel[] = reasoningLevelValues;

export interface JsonOutputOptions {
  json?: boolean;
}

export function outputJson(opts: JsonOutputOptions, data: unknown): boolean {
  if (!opts.json) return false;
  console.log(JSON.stringify(data, null, 2));
  return true;
}

export function printContextLabel(
  resolved: ResolvedId,
  kind: "Thread" | "Project",
  envVar: string,
  opts: JsonOutputOptions,
): void {
  if (opts.json) return;
  if (resolved.source === "env") {
    const displayId =
      kind === "Project" && resolved.id === PERSONAL_PROJECT_ID
        ? "-"
        : resolved.id;
    console.error(`${kind} ${displayId} (from ${envVar})`);
  }
}

export function printEnvironmentGitOperationResult(
  result: CommitActionResponse,
): void {
  console.log(`${result.message} [committed]`);
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
  if (!(err instanceof Error)) return String(err);
  const seen = new Set<Error>();
  const messages: string[] = [];
  const pending: Error[] = [err];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    if (current.message.length > 0) {
      messages.push(current.message);
    }

    const children: Error[] = [];
    if (current.cause instanceof Error) {
      children.push(current.cause);
    }
    if (current instanceof AggregateError) {
      children.push(
        ...current.errors.filter(
          (nested): nested is Error => nested instanceof Error,
        ),
      );
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
  return messages.join(": ");
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
