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
import { jsonValueSchema } from "@bb/domain";
import type {
  PermissionEscalation,
  PromptInput,
  ProviderCapabilities,
  ServiceTier,
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
} from "../shared/adapter-utils.js";
import {
  decodeNativeProviderToolCallRequest,
} from "../shared/provider-tool-call-contract.js";
import { resolveAdapterPermissionPolicy } from "../shared/permission-policy.js";
import type {
  AdapterCommand,
  AdapterOptions,
  DecodedToolCallRequest,
  JsonRpcMessage,
  ProviderAdapter,
} from "../provider-adapter.js";
import { translateCodexEvent } from "./event-translation.js";
import {
  buildCodexInteractiveResponse,
  decodeCodexInteractiveRequest,
} from "./interactive-requests.js";

interface CodexPermissionSettings {
  approvalPolicy: AskForApproval;
  sandbox: CodexSandboxMode;
  sandboxPolicy: SandboxPolicy;
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
  options: AdapterOptions,
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
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

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
        return { type: "text", text: `[Attached file: ${chunk.path}]`, text_elements: [] };
    }
  });
}

function buildCodexConfig(
  threadId: string,
  options?: AdapterOptions,
): { [key in string]?: JsonValue } | undefined {
  const config: { [key in string]?: JsonValue } = {};
  if (threadId) {
    config["shell_environment_policy.set.BB_THREAD_ID"] = threadId;
  }
  const shellEnvironmentConfig = buildShellEnvironmentPolicyConfig(options?.envVars);
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

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface CreateCodexProviderAdapterOptions {
  processCommand?: string;
  processArgs?: string[];
  launchEnv?: Record<string, string>;
}

export function createCodexProviderAdapter(
  opts?: CreateCodexProviderAdapterOptions,
): ProviderAdapter {
  const providerInfo = getBuiltInAgentProviderInfo("codex");
  const capabilities: ProviderCapabilities = {
    supportsRename: providerInfo.capabilities.supportsRename,
    supportsServiceTier: providerInfo.capabilities.supportsServiceTier,
    supportedPermissionModes: providerInfo.capabilities.supportedPermissionModes,
  };

  return {
    id: providerInfo.id,
    displayName: providerInfo.displayName,
    capabilities,
    process: {
      command: opts?.processCommand ?? "codex",
      args: opts?.processArgs ?? ["app-server"],
    },

    buildCommand(command: AdapterCommand): JsonRpcMessage | null {
      switch (command.type) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              clientInfo: { name: "bb", version: "1.0.0", title: null },
              capabilities: { experimentalApi: true },
            },
          };
        case "model/list":
          return {
            jsonrpc: "2.0",
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
            baseInstructions: command.options?.instructions ?? "",
            model: command.options?.model ?? undefined,
            serviceTier: toCodexServiceTier(command.options?.serviceTier),
            config: buildCodexConfig(command.threadId, command.options) ?? undefined,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
          };
          return {
            jsonrpc: "2.0",
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
            baseInstructions: command.options?.instructions ?? "",
            model: command.options?.model ?? undefined,
            serviceTier: toCodexServiceTier(command.options?.serviceTier),
            config: buildCodexConfig(command.threadId, command.options) ?? undefined,
            persistExtendedHistory: false,
            ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
          };
          return {
            jsonrpc: "2.0",
            method: "thread/resume",
            params,
          };
        }
        case "turn/start": {
          const permissionSettings = toCodexPermissionSettings(command.options);
          return {
            jsonrpc: "2.0",
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
            jsonrpc: "2.0",
            method: "turn/steer",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              expectedTurnId: command.expectedTurnId,
              input: toCodexUserInput(command.input),
            },
          };
        case "thread/name/set":
          if (!capabilities.supportsRename) {
            return null;
          }
          return {
            jsonrpc: "2.0",
            method: "thread/name/set",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              name: command.title,
            },
          };
        case "thread/stop":
          return null;
      }
    },

    translateEvent(event: unknown) {
      return translateCodexEvent(event);
    },

    decodeToolCallRequest(request: JsonRpcMessage): DecodedToolCallRequest | null {
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }
      return decodeNativeProviderToolCallRequest(
        request.id,
        request.method,
        request.params,
      );
    },

    decodeInteractiveRequest(request: JsonRpcMessage) {
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
