/**
 * Codex provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the OpenAI Codex app-server
 * JSON-RPC protocol. Validates the outer JSON-RPC envelope before translating
 * the provider-specific payloads.
 *
 * Reference: https://github.com/openai/codex (codex-rs/app-server-protocol/)
 */

import { getBuiltInAgentProviderInfo } from "@bb/agent-providers";
import {
  jsonValueSchema,
  requireThreadEventScopeTurnId,
  turnScope,
} from "@bb/domain";
import type {
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

function toWorkspaceWriteCodexSandboxPolicy(): SandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [],
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

function toCodexPermissionSettings(
  options: ProviderExecutionContext,
): CodexPermissionSettings {
  const permissionPolicy = resolveAdapterPermissionPolicy(options);
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
        sandboxPolicy: toWorkspaceWriteCodexSandboxPolicy(),
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
  threadId: string,
  options?: ProviderExecutionContext,
): { [key in string]?: JsonValue } | undefined {
  const config: { [key in string]?: JsonValue } = {};
  if (threadId) {
    config["shell_environment_policy.set.BB_THREAD_ID"] = threadId;
  }
  const shellEnvironmentConfig = buildShellEnvironmentPolicyConfig(
    options?.envVars,
  );
  if (shellEnvironmentConfig) {
    Object.assign(config, shellEnvironmentConfig);
  }
  if (options?.reasoningLevel) {
    config["model_reasoning_effort"] = options.reasoningLevel;
  }
  config["features.default_mode_request_user_input"] = false;
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

export interface CreateCodexProviderAdapterOptions {
  processCommand?: string;
  processArgs?: string[];
}

export function createCodexProviderAdapter(
  opts?: CreateCodexProviderAdapterOptions,
): ProviderAdapter {
  const providerInfo = getBuiltInAgentProviderInfo("codex");
  const capabilities: ProviderCapabilities = {
    supportsRename: providerInfo.capabilities.supportsRename,
    supportsServiceTier: providerInfo.capabilities.supportsServiceTier,
    supportedPermissionModes:
      providerInfo.capabilities.supportedPermissionModes,
  };
  const nativeTurnStartClientRequestSequencesByProviderThreadId = new Map<
    string,
    number[]
  >();
  const rawCommandOutputStateByProviderThreadId = new Map<
    string,
    CodexRawCommandOutputState
  >();

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

  function clearRawCommandOutputStateForClosedThread(
    event: ProviderRuntimeEvent,
  ): void {
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
  }

  function queueNativeTurnStartClientRequestSequence(args: {
    clientRequestSequence: number | undefined;
    providerThreadId: string | undefined;
  }): PreparedProviderCommandDispatch | null {
    if (
      args.clientRequestSequence === undefined ||
      args.providerThreadId === undefined
    ) {
      return null;
    }
    const clientRequestSequence = args.clientRequestSequence;
    const providerThreadId = args.providerThreadId;
    nativeTurnStartClientRequestSequencesByProviderThreadId.set(
      providerThreadId,
      [
        ...(nativeTurnStartClientRequestSequencesByProviderThreadId.get(
          providerThreadId,
        ) ?? []),
        clientRequestSequence,
      ],
    );

    return {
      rollback: () => {
        removeNativeTurnStartClientRequestSequence({
          clientRequestSequence,
          providerThreadId,
        });
      },
    };
  }

  function removeNativeTurnStartClientRequestSequence(args: {
    clientRequestSequence: number;
    providerThreadId: string;
  }): void {
    const sequences =
      nativeTurnStartClientRequestSequencesByProviderThreadId.get(
        args.providerThreadId,
      );
    if (!sequences || sequences.length === 0) {
      return;
    }
    const nextSequences = [...sequences];
    const sequenceIndex = nextSequences.indexOf(args.clientRequestSequence);
    if (sequenceIndex === -1) {
      return;
    }
    nextSequences.splice(sequenceIndex, 1);
    if (nextSequences.length === 0) {
      nativeTurnStartClientRequestSequencesByProviderThreadId.delete(
        args.providerThreadId,
      );
      return;
    }
    nativeTurnStartClientRequestSequencesByProviderThreadId.set(
      args.providerThreadId,
      nextSequences,
    );
  }

  function shiftNativeTurnStartClientRequestSequence(
    providerThreadId: string,
  ): number | undefined {
    const sequences =
      nativeTurnStartClientRequestSequencesByProviderThreadId.get(
        providerThreadId,
      );
    if (!sequences || sequences.length === 0) {
      return undefined;
    }
    const [clientRequestSequence, ...remainingSequences] = sequences;
    if (remainingSequences.length === 0) {
      nativeTurnStartClientRequestSequencesByProviderThreadId.delete(
        providerThreadId,
      );
    } else {
      nativeTurnStartClientRequestSequencesByProviderThreadId.set(
        providerThreadId,
        remainingSequences,
      );
    }
    return clientRequestSequence;
  }

  function attachAcceptedUserMessageCorrelation(
    event: ThreadEvent,
  ): ThreadEvent[] {
    if (event.type === "turn/completed") {
      nativeTurnStartClientRequestSequencesByProviderThreadId.delete(
        event.providerThreadId,
      );
      return [event];
    }

    if (event.type === "turn/started") {
      const clientRequestSequence = shiftNativeTurnStartClientRequestSequence(
        event.providerThreadId,
      );
      if (clientRequestSequence === undefined) {
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
          clientRequestSequence,
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
        rawCommandOutputStateByProviderThreadId.delete(event.providerThreadId);
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
          const permissionSettings = toCodexPermissionSettings(command.options);
          const params: ThreadStartParams = {
            approvalPolicy: permissionSettings.approvalPolicy,
            sandbox: permissionSettings.sandbox,
            cwd: command.cwd,
            ...resolveCodexInstructionOverrides(command),
            model: command.options?.model ?? undefined,
            serviceTier: toCodexServiceTier(command.options?.serviceTier),
            config:
              buildCodexConfig(command.threadId, command.options) ?? undefined,
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
          const permissionSettings = toCodexPermissionSettings(command.options);
          const params: ThreadResumeParams = {
            threadId: command.providerThreadId ?? command.threadId,
            approvalPolicy: permissionSettings.approvalPolicy,
            sandbox: permissionSettings.sandbox,
            cwd: command.cwd,
            ...resolveCodexInstructionOverrides(command),
            model: command.options?.model ?? undefined,
            serviceTier: toCodexServiceTier(command.options?.serviceTier),
            config:
              buildCodexConfig(command.threadId, command.options) ?? undefined,
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
          const permissionSettings = toCodexPermissionSettings(command.options);
          return {
            kind: "request",
            method: "turn/start",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
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
              threadId: command.providerThreadId ?? command.threadId,
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
              threadId: command.providerThreadId ?? command.threadId,
              name: command.title,
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
      return queueNativeTurnStartClientRequestSequence({
        clientRequestSequence: command.clientRequestSequence,
        providerThreadId: command.providerThreadId ?? command.threadId,
      });
    },

    translateEvent(event: ProviderRuntimeEvent) {
      clearRawCommandOutputStateForClosedThread(event);
      if (consumeCodexRawResponseItem(event)) {
        return [];
      }

      const translatedEvents = translateCodexEvent(event).flatMap(
        attachAcceptedUserMessageCorrelation,
      );
      reconcileRawCommandOutputLifecycle(translatedEvents);
      return applyRecoveredCommandOutput(translatedEvents);
    },

    translateAcceptedCommand({ command }) {
      if (command.type !== "turn/steer") {
        return [];
      }
      return buildAcceptedUserMessageEvent({
        clientRequestSequence: command.clientRequestSequence,
        providerThreadId: command.providerThreadId ?? command.threadId,
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
      return parseModelsResponse(result);
    },
  };
}
