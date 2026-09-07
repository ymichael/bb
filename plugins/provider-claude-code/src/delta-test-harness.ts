import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientTurnRequestId, ThreadEvent } from "@bb/domain";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  createClaudeDeltaTranslator,
  type ClaudeDeltaTranslationContext,
  type ClaudeDeltaTranslator,
} from "./delta-translation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "./__fixtures__");

function isFixtureObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadFixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(FIXTURES, name), "utf8"),
  );
  if (!isFixtureObject(parsed)) {
    throw new Error(`Fixture ${name} did not contain an object`);
  }
  return parsed;
}

export function loadSessionFixture(name: string): Record<string, unknown>[] {
  return readFileSync(resolve(FIXTURES, "sessions", name), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isFixtureObject(parsed)) {
        throw new Error(`Session fixture ${name} contained a non-object line`);
      }
      return parsed;
    });
}

export function spawningToolUseMessage(args: {
  toolUseId: string;
  toolName: string;
  input?: Record<string, unknown>;
  parentToolUseId?: string;
}): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: args.toolUseId,
          name: args.toolName,
          input: args.input ?? {},
        },
      ],
    },
    parent_tool_use_id: args.parentToolUseId ?? null,
    session_id: "sess-1",
  };
}

export function spawningToolUseFor(
  taskStarted: Record<string, unknown>,
): Record<string, unknown> {
  const toolUseId = taskStarted.tool_use_id;
  if (typeof toolUseId !== "string") {
    throw new Error("task_started fixture has no tool_use_id");
  }
  const description =
    typeof taskStarted.description === "string" ? taskStarted.description : "";
  switch (taskStarted.task_type) {
    case "local_workflow":
      return spawningToolUseMessage({
        toolUseId,
        toolName: "Workflow",
        input: { script: taskStarted.prompt ?? "" },
      });
    case "local_bash":
      return spawningToolUseMessage({
        toolUseId,
        toolName: "Bash",
        input: { command: description, run_in_background: true },
      });
    default:
      return spawningToolUseMessage({
        toolUseId,
        toolName: "Agent",
        input: {
          description,
          prompt: taskStarted.prompt ?? description,
          run_in_background: true,
          ...(typeof taskStarted.subagent_type === "string"
            ? { subagent_type: taskStarted.subagent_type }
            : {}),
        },
      });
  }
}

const CLAUDE_TEST_ENTROPY = "cl-test";
export const TURN_1 = "cl-test-t1";
export const TURN_2 = "cl-test-t2";
export const ITEM_ID_PATTERN = /^cl-test-i\d+$/;

interface ClaudeDeltaHarness {
  translator: ClaudeDeltaTranslator;
  translate(
    event: unknown,
    context?: ClaudeDeltaTranslationContext,
  ): ThreadEvent[];
  acceptInput(clientRequestId: string, threadId?: string): ThreadEvent[];
  settleSession(threadId?: string): ThreadEvent[];
  itemId(providerItemId: string, threadId?: string): string;
}

export function createClaudeDeltaHarness(
  options: { sandboxEnabled?: boolean } = {},
): ClaudeDeltaHarness {
  const translator = createClaudeDeltaTranslator({
    cwd: "/workspace",
    sandboxEnabled: options.sandboxEnabled ?? false,
  });
  const assembler = createDeltaAssembler({
    providerId: "claude-code",
    entropyPrefix: CLAUDE_TEST_ENTROPY,
    textDeltaFlushMs: 0,
  });
  return {
    translator,
    translate(event, context) {
      return assembler.assemble({
        threadId: context?.threadId ?? "",
        deltas: translator.translate(event, context),
      });
    },
    acceptInput(clientRequestId, threadId = "") {
      return assembler.assemble({
        threadId,
        deltas: translator.acceptInput(
          threadId,
          clientRequestId as ClientTurnRequestId,
        ),
      });
    },
    settleSession(threadId = "") {
      return assembler.assemble({
        threadId,
        deltas: translator.buildSessionSettlementDeltas(threadId),
      });
    },
    itemId(providerItemId, threadId = "") {
      return assembler.getBbItemId(threadId, providerItemId) ?? "";
    },
  };
}
