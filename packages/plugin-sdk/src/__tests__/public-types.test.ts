import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { BbPluginApi } from "../index.js";

type ExpectedBbPluginApiKey =
  | "agents"
  | "background"
  | "cli"
  | "events"
  | "experimental_aiServices"
  | "experimental_hooks"
  | "hosts"
  | "http"
  | "log"
  | "onDispose"
  | "pluginId"
  | "providers"
  | "realtime"
  | "rpc"
  | "sdk"
  | "server"
  | "settings"
  | "status"
  | "storage"
  | "ui";

const EXPECTED_BACKEND_ROOT_TYPE_EXPORTS = [
  "BbPluginApi",
  "MessageDispatchHookContext",
  "MessageDispatchHookDecision",
  "PluginAgents",
  "PluginAiServiceDeclaration",
  "PluginAiServiceKind",
  "PluginAiServices",
  "PluginAgentConfiguration",
  "PluginAgentConfigurationContext",
  "PluginAgentToolContentPart",
  "PluginAgentToolContext",
  "PluginAgentToolLabels",
  "PluginAgentToolPresentation",
  "PluginAgentToolRegistrationBase",
  "PluginAgentToolResult",
  "PluginAgentToolSelection",
  "PluginBackground",
  "PluginCli",
  "PluginCliCommandInfo",
  "PluginCliContext",
  "PluginCliExecutionResult",
  "PluginCliOutputLimitError",
  "PluginCliRegistration",
  "PluginCliResult",
  "PluginDispatchAttemptKind",
  "PluginDispatchExecution",
  "PluginDispatchExecutionSources",
  "PluginDispatchInput",
  "PluginEvents",
  "ExperimentalPluginWebSocket",
  "ExperimentalPluginWebSocketContext",
  "ExperimentalPluginWebSocketHandler",
  "ExperimentalPluginWebSocketHandlers",
  "PluginHookHandler",
  "PluginHookName",
  "PluginHookSignatures",
  "PluginHooks",
  "PluginHosts",
  "PluginHttp",
  "PluginHttpAuthMode",
  "PluginHttpHandler",
  "PluginInteractionCancelReason",
  "PluginInteractionRequest",
  "PluginInteractionResult",
  "PluginKvStorage",
  "PluginLogger",
  "PluginMentionItem",
  "PluginMentionProviderRegistration",
  "PluginMentionSearchContext",
  "PluginMentionTrigger",
  "PluginProviderCapabilities",
  "PluginProviderComposerAction",
  "PluginProviderDeclaration",
  "ExperimentalPluginProviderEnvContext",
  "ExperimentalPluginProviderEnvEntry",
  "ExperimentalPluginProviderEnvHealth",
  "ExperimentalPluginProviderEnvHealthContext",
  "PluginProviderExtensionKindDeclaration",
  "PluginProviderFallbackModel",
  "PluginProviderMaintenance",
  "PluginProviderModelCatalogScope",
  "PluginProviderNativeRootEntry",
  "PluginProviderNativeRoots",
  "PluginProviderOptionDescriptor",
  "PluginProviderOptionsContext",
  "PluginProviderPermissionMode",
  "PluginProviderReasoningLevel",
  "PluginProviderStrings",
  "PluginProviders",
  "PluginRealtime",
  "PluginRpc",
  "PluginServerApi",
  "PluginSettingDescriptor",
  "PluginSettingDescriptors",
  "PluginSettingValue",
  "PluginSettings",
  "PluginSettingsHandle",
  "PluginSettingsValues",
  "PluginSharedPortTunnelIdentity",
  "PluginStatusApi",
  "PluginStorage",
  "PluginThreadEventHandler",
  "PluginThreadEventName",
  "PluginThreadEventPayloads",
  "PluginTurnFailedEvent",
  "PluginUi",
] as const;

const EXPECTED_BACKEND_ROOT_VALUE_EXPORTS = [
  "PLUGIN_CLI_OUTPUT_MAX_BYTES",
] as const;

const EXPECTED_RPC_ROOT_TYPE_EXPORTS = [
  "PluginRpcCallArgs",
  "PluginRpcContract",
  "PluginRpcError",
  "PluginRpcErrorCode",
  "PluginRpcHandlers",
  "PluginRpcIssuePathSegment",
  "PluginRpcMethodContract",
  "PluginRpcResult",
  "PluginRpcValidationIssue",
  "StandardSchemaV1",
  "StandardSchemaV1InferInput",
  "StandardSchemaV1InferOutput",
  "StandardSchemaV1Issue",
  "StandardSchemaV1Result",
] as const;

const EXPECTED_RPC_ROOT_VALUE_EXPORTS = ["defineRpcContract"] as const;

const EXPECTED_HOST_ROOT_TYPE_EXPORTS = [
  "ExperimentalHostCallOptions",
  "ExperimentalHostClient",
  "ExperimentalHostEntry",
  "ExperimentalHostPaths",
  "ExperimentalHostRpcContext",
  "ExperimentalHostRpcHandlers",
  "ExperimentalHostSignalContract",
  "ExperimentalHostSignalEvent",
  "ExperimentalHostSignals",
  "ExperimentalHostWatchChange",
  "ExperimentalHostWatchChangeType",
  "ExperimentalHostWatchEvent",
  "ExperimentalHostWatchListener",
  "ExperimentalHostWatchOptions",
  "ExperimentalHostWatchSubscription",
  "ExperimentalHostWorkerLease",
] as const;

const EXPECTED_HOST_ROOT_VALUE_EXPORTS = [
  "experimental_defineHostEntry",
] as const;

function namesFromMatches(source: string, pattern: RegExp): string[] {
  return Array.from(source.matchAll(pattern), (match) => match[1]).sort();
}

function rootExportNames(
  declarations: string,
  kind: "type" | "value",
): Set<string> {
  const prefix = kind === "type" ? "export type" : "export";
  const match = declarations.match(
    new RegExp(`^${prefix} \\{ ([^}]+) \\};$`, "mu"),
  );

  if (kind === "value" && match === null) return new Set();
  expect(match, `${prefix} declaration`).not.toBeNull();
  return new Set(match?.[1].split(", ") ?? []);
}

describe("backend plugin SDK public surface", () => {
  it("snapshots every BbPluginApi root member", () => {
    expectTypeOf<keyof BbPluginApi>().toEqualTypeOf<ExpectedBbPluginApiKey>();
  });

  it("keeps every backend contract export in the root declaration bundle", async () => {
    const [backendContract, declarations] = await Promise.all([
      readFile(new URL("../backend-contract.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../../bundled-types/bb-plugin-sdk.d.ts", import.meta.url),
        "utf8",
      ),
    ]);
    const declaredBackendTypes = namesFromMatches(
      backendContract,
      /^export (?:interface|type) ([A-Za-z0-9_]+)/gmu,
    );
    const declaredBackendValues = namesFromMatches(
      backendContract,
      /^export (?:class|const|function) ([A-Za-z0-9_]+)/gmu,
    );
    const rootTypeExports = rootExportNames(declarations, "type");
    const rootValueExports = rootExportNames(declarations, "value");

    expect(declaredBackendTypes).toEqual(
      [...EXPECTED_BACKEND_ROOT_TYPE_EXPORTS].sort(),
    );
    expect(declaredBackendValues).toEqual(EXPECTED_BACKEND_ROOT_VALUE_EXPORTS);
    for (const exportName of EXPECTED_BACKEND_ROOT_TYPE_EXPORTS) {
      expect(rootTypeExports.has(exportName), exportName).toBe(true);
    }
    for (const exportName of EXPECTED_BACKEND_ROOT_VALUE_EXPORTS) {
      expect(rootValueExports.has(exportName), exportName).toBe(true);
    }
  });

  it("keeps every rpc contract export in the root declaration bundle", async () => {
    const [rpcContract, declarations] = await Promise.all([
      readFile(new URL("../rpc-contract.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../../bundled-types/bb-plugin-sdk.d.ts", import.meta.url),
        "utf8",
      ),
    ]);
    const declaredTypes = namesFromMatches(
      rpcContract,
      /^export (?:interface|type) ([A-Za-z0-9_]+)/gmu,
    );
    const declaredValues = namesFromMatches(
      rpcContract,
      /^export (?:class|const|function) ([A-Za-z0-9_]+)/gmu,
    );
    expect(declaredTypes).toEqual([...EXPECTED_RPC_ROOT_TYPE_EXPORTS].sort());
    expect(declaredValues).toEqual([...EXPECTED_RPC_ROOT_VALUE_EXPORTS]);

    const rootTypeExports = rootExportNames(declarations, "type");
    const rootValueExports = rootExportNames(declarations, "value");
    for (const exportName of EXPECTED_RPC_ROOT_TYPE_EXPORTS) {
      expect(rootTypeExports.has(exportName), exportName).toBe(true);
    }
    for (const exportName of EXPECTED_RPC_ROOT_VALUE_EXPORTS) {
      expect(rootValueExports.has(exportName), exportName).toBe(true);
    }
  });

  it("keeps every host contract export in the root declaration bundle", async () => {
    const [hostContract, declarations] = await Promise.all([
      readFile(new URL("../host-contract.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../../bundled-types/bb-plugin-sdk.d.ts", import.meta.url),
        "utf8",
      ),
    ]);
    const declaredTypes = namesFromMatches(
      hostContract,
      /^export (?:interface|type) ([A-Za-z0-9_]+)/gmu,
    );
    const declaredValues = namesFromMatches(
      hostContract,
      /^export (?:class|const|function) ([A-Za-z0-9_]+)/gmu,
    );
    expect(declaredTypes).toEqual([...EXPECTED_HOST_ROOT_TYPE_EXPORTS].sort());
    expect(declaredValues).toEqual(
      [...EXPECTED_HOST_ROOT_VALUE_EXPORTS].sort(),
    );

    const rootTypeExports = rootExportNames(declarations, "type");
    const rootValueExports = rootExportNames(declarations, "value");
    for (const exportName of EXPECTED_HOST_ROOT_TYPE_EXPORTS) {
      expect(rootTypeExports.has(exportName), exportName).toBe(true);
    }
    for (const exportName of EXPECTED_HOST_ROOT_VALUE_EXPORTS) {
      expect(rootValueExports.has(exportName), exportName).toBe(true);
    }
  });
});
