import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
import { basename } from "node:path";
import { z } from "zod";
import {
  CURSOR_ACP_MAINTENANCE,
  type AcpMaintenanceDialect,
} from "./bridge/provider-maintenance.js";
import { delegationPresentation } from "./presentation.js";
import type {
  AcpClassifiedToolCall,
  AcpCommandResult,
} from "./tool-classification.js";
import {
  acpToolKindSchema,
  type AcpToolCallUpdateEvent,
  type AcpToolKind,
} from "./wire.js";

export interface AcpToolIdentity {
  name?: string;
  kind?: AcpToolKind;
}

export interface AcpDelegationReport {
  toolCallId: string;
  childRef: string;
  label: string;
  detail?: string;
}

type AcpCompactionOutcome =
  | { status: "completed" }
  | { status: "skipped"; detail: string }
  | { status: "failed"; error: string };

export interface AcpDialect {
  readonly id: string;
  toolIdentity?(event: AcpToolCallUpdateEvent): AcpToolIdentity | undefined;
  classifyToolCall?(
    event: AcpToolCallUpdateEvent,
  ): AcpClassifiedToolCall | undefined;
  commandResult?(event: AcpToolCallUpdateEvent): AcpCommandResult | undefined;
  normalizeCommandEvent?(event: AcpToolCallUpdateEvent): AcpToolCallUpdateEvent;
  handleClientRequest?(
    method: string,
    params: unknown,
  ): AcpClientRequestOutcome | undefined;
  maintenance?: AcpMaintenanceDialect;
}

export interface AcpClientRequestOutcome {
  result: Record<string, unknown>;
  delegation?: AcpDelegationReport;
}

export const GENERIC_ACP_DIALECT: AcpDialect = { id: "acp" };

const grokToolMetaSchema = z
  .object({
    "x.ai/tool": z
      .object({
        name: z.string().optional(),
        kind: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

function grokToolIdentity(
  event: AcpToolCallUpdateEvent,
): AcpToolIdentity | undefined {
  const meta = grokToolMetaSchema.safeParse(event["_meta"]);
  if (!meta.success) {
    return undefined;
  }
  const tool = meta.data["x.ai/tool"];
  const kind = acpToolKindSchema.safeParse(tool.kind);
  return {
    ...(tool.name !== undefined && tool.name.length > 0
      ? { name: tool.name }
      : {}),
    ...(kind.success ? { kind: kind.data } : {}),
  };
}

const GROK_SPAWN_SUBAGENT_TOOL = "spawn_subagent";
const grokSpawnSubagentInputSchema = z
  .object({
    description: z.string().optional(),
    prompt: z.string().optional(),
    subagent_type: z.string().optional(),
  })
  .passthrough();

function grokClassifyToolCall(
  event: AcpToolCallUpdateEvent,
): AcpClassifiedToolCall | undefined {
  if (grokToolIdentity(event)?.name !== GROK_SPAWN_SUBAGENT_TOOL) {
    return undefined;
  }
  const parsed = grokSpawnSubagentInputSchema.safeParse(event.rawInput);
  const input = parsed.success ? parsed.data : undefined;
  const label =
    input?.description ?? input?.prompt ?? event.title ?? "Subagent";
  const shape: DeltaItemShape = {
    type: "delegation",
    childRef: event.toolCallId,
    label,
    background: false,
  };
  return {
    item: shape,
    presentation: delegationPresentation({
      label,
      ...(input?.subagent_type === undefined
        ? {}
        : { detail: input.subagent_type }),
    }),
  };
}

export const GROK_ACP_DIALECT: AcpDialect = {
  id: "grok",
  toolIdentity: grokToolIdentity,
  classifyToolCall: grokClassifyToolCall,
};

const CURSOR_TASK_TOOL = "task";
const cursorTaskRawInputSchema = z
  .object({ _toolName: z.string().optional() })
  .passthrough();

const CURSOR_TASK_METHOD = "cursor/task";
const cursorTaskParamsSchema = z
  .object({
    toolCallId: z.string(),
    description: z.string().optional(),
    prompt: z.string().optional(),
    agentId: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough();

function cursorClassifyToolCall(
  event: AcpToolCallUpdateEvent,
): AcpClassifiedToolCall | undefined {
  const parsed = cursorTaskRawInputSchema.safeParse(event.rawInput);
  if (!parsed.success || parsed.data._toolName !== CURSOR_TASK_TOOL) {
    return undefined;
  }
  const label = event.title ?? "Subagent task";
  const shape: DeltaItemShape = {
    type: "delegation",
    childRef: event.toolCallId,
    label,
    background: false,
  };
  return {
    item: shape,
    presentation: delegationPresentation({ label }),
  };
}

function cursorHandleClientRequest(
  method: string,
  params: unknown,
): AcpClientRequestOutcome | undefined {
  if (method !== CURSOR_TASK_METHOD) {
    return undefined;
  }
  const parsed = cursorTaskParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { result: {} };
  }
  const task = parsed.data;
  const label = task.description ?? task.prompt;
  if (label === undefined) {
    return { result: {} };
  }
  return {
    result: {},
    delegation: {
      toolCallId: task.toolCallId,
      childRef: task.agentId ?? task.toolCallId,
      label,
      ...(task.model === undefined ? {} : { detail: `model ${task.model}` }),
    },
  };
}

export const CURSOR_ACP_DIALECT: AcpDialect = {
  id: "cursor",
  classifyToolCall: cursorClassifyToolCall,
  handleClientRequest: cursorHandleClientRequest,
  maintenance: CURSOR_ACP_MAINTENANCE,
};

const ompBashRawInputSchema = z
  .object({
    command: z.string(),
    async: z.boolean().optional(),
  })
  .passthrough();

const ompBashRawOutputSchema = z
  .object({
    content: z.array(
      z
        .object({
          type: z.literal("text"),
          text: z.string(),
        })
        .passthrough(),
    ),
    details: z
      .object({
        exitCode: z.number().int().optional(),
        wallTimeMs: z.number().nonnegative().optional(),
        timedOut: z.boolean().optional(),
        signal: z.unknown().optional(),
        async: z.unknown().optional(),
      })
      .passthrough(),
    exitCode: z.number().int().nullable().optional(),
    exit_code: z.number().int().nullable().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    output_for_prompt: z.string().optional(),
    signal: z.string().nullable().optional(),
    timed_out: z.boolean().optional(),
  })
  .passthrough();

function stripOmpTrailingNotice(text: string, notice: string): string {
  const suffix = `\n\n${notice}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function ompCommandResult(
  event: AcpToolCallUpdateEvent,
): AcpCommandResult | undefined {
  if (event.kind !== "execute") {
    return undefined;
  }
  const parsedInput = ompBashRawInputSchema.safeParse(event.rawInput);
  const parsedOutput = ompBashRawOutputSchema.safeParse(event.rawOutput);
  if (
    !parsedInput.success ||
    parsedInput.data.command.trim().length === 0 ||
    !parsedOutput.success
  ) {
    return undefined;
  }
  const rawOutput = parsedOutput.data;
  const details = rawOutput.details;
  const hasGenericCommandResult =
    rawOutput.exitCode !== undefined ||
    rawOutput.exit_code !== undefined ||
    rawOutput.stdout !== undefined ||
    rawOutput.stderr !== undefined ||
    rawOutput.output_for_prompt !== undefined ||
    (rawOutput.signal !== undefined && rawOutput.signal !== null) ||
    rawOutput.timed_out === true;
  if (
    parsedInput.data.async === true ||
    details.async !== undefined ||
    hasGenericCommandResult
  ) {
    return undefined;
  }
  if (details.exitCode === undefined && details.wallTimeMs === undefined) {
    return undefined;
  }

  let output = rawOutput.content.map((block) => block.text).join("\n");
  if (details.exitCode !== undefined) {
    output = stripOmpTrailingNotice(
      output,
      `Command exited with code ${String(details.exitCode)}`,
    );
  }
  if (details.wallTimeMs !== undefined) {
    output = stripOmpTrailingNotice(
      output,
      `Wall time: ${(details.wallTimeMs / 1_000).toFixed(2)} seconds`,
    );
  }

  const isCompletedForegroundBash =
    event.status === "completed" &&
    details.timedOut !== true &&
    (details.signal === undefined || details.signal === null);
  const exitCode =
    details.exitCode ?? (isCompletedForegroundBash ? 0 : undefined);
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(output.length === 0 ? {} : { output }),
  };
}

const OMP_COMPACTION_FAILURE_PATTERN = /\bcompaction failed\b/i;
const OMP_COMPACTION_NOOP_PATTERN =
  /\b(?:nothing to compact|already compacted)\b/i;

export function compactionOutcomeForEndTurn(
  dialect: AcpDialect,
  agentMessage: string,
): AcpCompactionOutcome {
  if (dialect.id !== "omp") {
    return { status: "completed" };
  }
  const text = agentMessage.trim();
  if (!OMP_COMPACTION_FAILURE_PATTERN.test(text)) {
    return { status: "completed" };
  }
  return OMP_COMPACTION_NOOP_PATTERN.test(text)
    ? { status: "skipped", detail: text }
    : { status: "failed", error: text };
}

export const OMP_ACP_DIALECT: AcpDialect = {
  id: "omp",
  commandResult: ompCommandResult,
};

const openCodeCommandRawOutputSchema = z
  .object({
    output: z.unknown().optional(),
    metadata: z
      .object({
        exit: z.number().int().nullable().optional(),
        output: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function normalizeOpenCodeCommandEvent(
  event: AcpToolCallUpdateEvent,
): AcpToolCallUpdateEvent {
  const parsed = openCodeCommandRawOutputSchema.safeParse(event.rawOutput);
  if (!parsed.success) {
    return event;
  }
  const rawOutput = parsed.data;
  const output =
    typeof rawOutput.output === "string"
      ? rawOutput.output
      : rawOutput.metadata?.output;
  const hasSharedOutput =
    rawOutput["stdout"] !== undefined ||
    rawOutput["stderr"] !== undefined ||
    rawOutput["output_for_prompt"] !== undefined;
  const hasSharedExitCode =
    rawOutput["exitCode"] !== undefined || rawOutput["exit_code"] !== undefined;
  const exitCode = rawOutput.metadata?.exit ?? undefined;
  if (
    (output === undefined || hasSharedOutput) &&
    (exitCode === undefined || hasSharedExitCode)
  ) {
    return event;
  }
  return {
    ...event,
    rawOutput: {
      ...rawOutput,
      ...(output === undefined || hasSharedOutput ? {} : { stdout: output }),
      ...(exitCode === undefined || hasSharedExitCode ? {} : { exitCode }),
    },
  };
}

export const OPENCODE_ACP_DIALECT: AcpDialect = {
  id: "opencode",
  normalizeCommandEvent: normalizeOpenCodeCommandEvent,
};

const DIALECTS_BY_ID: ReadonlyMap<string, AcpDialect> = new Map([
  [CURSOR_ACP_DIALECT.id, CURSOR_ACP_DIALECT],
  [GROK_ACP_DIALECT.id, GROK_ACP_DIALECT],
  [OMP_ACP_DIALECT.id, OMP_ACP_DIALECT],
  [OPENCODE_ACP_DIALECT.id, OPENCODE_ACP_DIALECT],
]);

const DIALECT_IDS_BY_COMMAND: Readonly<Record<string, string>> = {
  "cursor-agent": CURSOR_ACP_DIALECT.id,
  grok: GROK_ACP_DIALECT.id,
  omp: OMP_ACP_DIALECT.id,
  opencode: OPENCODE_ACP_DIALECT.id,
};

export function resolveAcpDialect(launch: {
  dialectId?: string | undefined;
  command: string;
}): AcpDialect {
  if (launch.dialectId !== undefined) {
    return DIALECTS_BY_ID.get(launch.dialectId) ?? GENERIC_ACP_DIALECT;
  }
  const byCommand = DIALECT_IDS_BY_COMMAND[basename(launch.command)];
  return byCommand === undefined
    ? GENERIC_ACP_DIALECT
    : (DIALECTS_BY_ID.get(byCommand) ?? GENERIC_ACP_DIALECT);
}
