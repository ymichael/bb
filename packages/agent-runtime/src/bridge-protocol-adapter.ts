import type {
  AvailableModel,
  ProviderCapabilities,
  ProviderFork,
  ThreadEvent,
} from "@bb/domain";
import { PROVIDER_FORK_VALUES } from "@bb/domain";
import { pendingInteractionPayloadSchema } from "@bb/domain";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  bridgeCapabilitiesSchema,
  initializeResultSchema,
  negotiateGrammarVersion,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_NOTIFICATION_METHOD,
  providerRecoveryNotificationSchema,
  threadDeltaNotificationParamsSchema,
  type BridgeCapabilities,
} from "@bb/provider-bridge-protocol";
import {
  ASSEMBLER_GRAMMAR_VERSIONS,
  createDeltaAssembler,
} from "@bb/provider-bridge-protocol/assembler";
import { z } from "zod";
import type {
  AdapterCommand,
  ProviderExecutionContext,
} from "./provider-adapter.js";
import type {
  DecodedInteractiveRequest,
  DecodedToolCallRequest,
  ProviderCommandPlan,
  ProviderInboundRequest,
  ProviderInteractiveResponse,
  ProviderPostInitializeRequest,
  ProviderRuntimeEvent,
  BuildInteractiveResponseArgs,
} from "@bb/provider-bridge-protocol/bridge-kit";
import { decodeNormalizedProviderToolCallRequest } from "@bb/provider-bridge-protocol/bridge-kit";
import { parseAvailableModelList } from "./shared/available-models.js";
import type { AgentRuntimeProviderRecoveryHint } from "./types.js";

export type ProviderRecoveryHint = Omit<
  AgentRuntimeProviderRecoveryHint,
  "providerId"
>;

export interface BridgeProtocolAdapter {
  id: string;
  capabilities: BridgeEnforcedCapabilities;
  readonly approvalEnforcedBy: "runtime" | "provider";
  process: { command: string; args: string[]; env?: Record<string, string> };
  buildCommandPlan(command: AdapterCommand): ProviderCommandPlan;
  buildPostInitializeRequests(): readonly ProviderPostInitializeRequest[];
  parseModelListResult(result: unknown): {
    models: AvailableModel[];
    selectedOnlyModels: AvailableModel[];
  };
  translateEvent(event: ProviderRuntimeEvent): ThreadEvent[];
  decodeRecoveryHint(event: ProviderRuntimeEvent): ProviderRecoveryHint | null;
  decodeToolCallRequest(
    request: ProviderInboundRequest,
  ): DecodedToolCallRequest | null;
  decodeInteractiveRequest(
    request: ProviderInboundRequest,
  ): DecodedInteractiveRequest | null;
  buildInteractiveResponse(
    args: BuildInteractiveResponseArgs,
  ): ProviderInteractiveResponse;
}

export type BridgeEnforcedCapabilities = Omit<
  ProviderCapabilities,
  "modelCatalogScope"
>;

interface BridgeAdapterCapabilities extends Omit<
  BridgeEnforcedCapabilities,
  "supportsFork" | "supportsSessionRewind"
> {
  fork: ProviderFork;
}

interface BridgeProtocolAdapterOptions {
  id: string;
  capabilities: BridgeAdapterCapabilities;
  process: { command: string; args: string[]; env?: Record<string, string> };
  staticProviderOptions?: Record<string, unknown>;
}

const threadIdentityNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    providerThreadId: z.string().min(1),
    sessionRestorable: z.boolean().optional(),
  })
  .passthrough();

const sessionReplacedNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1),
    providerThreadId: z.string().min(1).nullable(),
    reason: z.string().min(1),
    contextLost: z.boolean().default(false),
    showRuntimeNote: z.boolean().default(false),
  })
  .passthrough();

const errorNotificationParamsSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    providerThreadId: z.string().min(1).optional(),
    message: z.string().min(1),
  })
  .passthrough();

const interactionRequestParamsSchema = z.object({
  providerThreadId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  turnId: z.union([z.string().min(1), z.null()]),
  payload: pendingInteractionPayloadSchema,
  providerNativeIds: z.boolean().optional(),
});

const providerNativeIdsParamsSchema = z
  .object({ providerNativeIds: z.boolean().optional() })
  .passthrough();

function toBridgeWireOptions(
  options: ProviderExecutionContext,
  staticProviderOptions?: Record<string, unknown>,
): Record<string, unknown> {
  const {
    model,
    serviceTier,
    reasoningLevel,
    promptMode,
    instructions,
    envVars,
    permissionMode,
    permissionScope,
    approvalReviewer,
    permissionEscalation,
  } = options;
  const providerOptions = {
    ...staticProviderOptions,
    ...options.providerOptions,
  };
  return {
    ...(model !== undefined ? { model } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
    ...(promptMode !== undefined ? { promptMode } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(envVars !== undefined ? { envVars } : {}),
    permissionMode,
    permissionScope,
    approvalReviewer,
    permissionEscalation,
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  };
}

export function createBridgeProtocolAdapter(
  options: BridgeProtocolAdapterOptions,
): BridgeProtocolAdapter {
  let handshake: BridgeCapabilities = bridgeCapabilitiesSchema.parse({});
  const { fork: declaredFork, ...declaredCapabilities } = options.capabilities;
  const capabilities: BridgeEnforcedCapabilities = {
    ...declaredCapabilities,
    supportsFork: declaredFork !== "none",
    supportsSessionRewind: declaredFork === "checkpoint",
  };
  function effectiveFork(): ProviderFork {
    return PROVIDER_FORK_VALUES.indexOf(handshake.fork) <
      PROVIDER_FORK_VALUES.indexOf(declaredFork)
      ? handshake.fork
      : declaredFork;
  }
  const deltaAssembler = createDeltaAssembler({ providerId: options.id });

  function gate(
    capability: keyof BridgeCapabilities & string,
    plan: ProviderCommandPlan,
  ): ProviderCommandPlan {
    if (handshake[capability] === true) {
      return plan;
    }
    return { kind: "noop", reason: `${capability} not advertised` };
  }

  const adapter: BridgeProtocolAdapter = {
    id: options.id,
    capabilities,
    get approvalEnforcedBy() {
      return handshake.approvalEnforcedBy;
    },
    process: options.process,

    buildCommandPlan(command: AdapterCommand): ProviderCommandPlan {
      switch (command.type) {
        case "model/list":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.modelList,
            params: {
              ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
              ...(options.staticProviderOptions !== undefined
                ? { providerOptions: options.staticProviderOptions }
                : {}),
            },
          };
        case "provider/health":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.providerHealth,
            params: {
              providerId: options.id,
              ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
              ...(options.staticProviderOptions !== undefined
                ? { providerOptions: options.staticProviderOptions }
                : {}),
            },
          };
        case "provider/usage":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.providerUsage,
            params: {
              providerId: options.id,
              ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
              ...(options.staticProviderOptions !== undefined
                ? { providerOptions: options.staticProviderOptions }
                : {}),
            },
          };
        case "provider/installation/status":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.providerInstallationStatus,
            params: {
              providerId: options.id,
              ...(command.requirement !== undefined
                ? { requirement: command.requirement }
                : {}),
              ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
              ...(options.staticProviderOptions !== undefined
                ? { providerOptions: options.staticProviderOptions }
                : {}),
            },
          };
        case "provider/installation/run":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.providerInstallationRun,
            params: {
              providerId: options.id,
              action: command.action,
              ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
              ...(options.staticProviderOptions !== undefined
                ? { providerOptions: options.staticProviderOptions }
                : {}),
            },
          };
        case "skills/configure":
          if (!handshake.skills.configure) {
            return { kind: "noop", reason: "skills.configure not advertised" };
          }
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.skillsConfigure,
            params: { roots: command.skillRoots },
          };
        case "thread/start":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.threadStart,
            params: {
              threadId: command.threadId,
              cwd: command.cwd,
              options: toBridgeWireOptions(
                command.options,
                options.staticProviderOptions,
              ),
              ...(command.dynamicTools !== undefined
                ? { dynamicTools: command.dynamicTools }
                : {}),
              ...(command.disallowedTools !== undefined
                ? { disallowedTools: command.disallowedTools }
                : {}),
              instructionMode: command.instructionMode,
            },
          };
        case "thread/resume":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.threadResume,
            params: {
              threadId: command.threadId,
              cwd: command.cwd,
              providerThreadId: command.providerThreadId,
              options: toBridgeWireOptions(
                command.options,
                options.staticProviderOptions,
              ),
              ...(command.dynamicTools !== undefined
                ? { dynamicTools: command.dynamicTools }
                : {}),
              ...(command.disallowedTools !== undefined
                ? { disallowedTools: command.disallowedTools }
                : {}),
              instructionMode: command.instructionMode,
            },
          };
        case "thread/fork": {
          const fork = effectiveFork();
          if (fork === "none") {
            throw new Error(
              `Provider "${options.id}" does not support forking a thread`,
            );
          }
          if (
            fork === "tip" &&
            command.sourceProviderCheckpointId !== undefined
          ) {
            throw new Error(
              `Provider "${options.id}" can only fork at the end of a session, not from an earlier point in it`,
            );
          }
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.threadFork,
            params: {
              threadId: command.threadId,
              cwd: command.cwd,
              sourceProviderThreadId: command.sourceProviderThreadId,
              ...(command.sourceProviderCheckpointId !== undefined
                ? {
                    sourceProviderCheckpointId:
                      command.sourceProviderCheckpointId,
                  }
                : {}),
              options: toBridgeWireOptions(
                command.options,
                options.staticProviderOptions,
              ),
              ...(command.dynamicTools !== undefined
                ? { dynamicTools: command.dynamicTools }
                : {}),
              ...(command.disallowedTools !== undefined
                ? { disallowedTools: command.disallowedTools }
                : {}),
              instructionMode: command.instructionMode,
            },
          };
        }
        case "turn/start":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.turnStart,
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
              input: command.input,
              clientRequestId: command.clientRequestId,
              options: toBridgeWireOptions(
                command.options,
                options.staticProviderOptions,
              ),
            },
          };
        case "turn/steer":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.turnSteer,
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
              expectedTurnId:
                deltaAssembler.getProviderTurnId(
                  command.threadId,
                  command.expectedTurnId,
                ) ?? command.expectedTurnId,
              input: command.input,
              clientRequestId: command.clientRequestId,
              options: toBridgeWireOptions(
                command.options,
                options.staticProviderOptions,
              ),
            },
          };
        case "thread/stop":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.threadStop,
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
              intent: command.activeTurnId !== null ? "interrupt" : "release",
              activeTurnId:
                command.activeTurnId === null
                  ? null
                  : (deltaAssembler.getProviderTurnId(
                      command.threadId,
                      command.activeTurnId,
                    ) ?? command.activeTurnId),
            },
          };
        case "thread/discard":
          return {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.threadDiscard,
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
            },
          };
        case "thread/name/set":
          return gate("threadRename", {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.threadNameSet,
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
              title: command.title,
            },
          });
        case "thread/archive":
          return gate("threadArchive", {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.threadArchive,
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
            },
          });
        case "thread/unarchive":
          return gate("threadArchive", {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.threadUnarchive,
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
            },
          });
        case "thread/goal/clear":
          return gate("threadGoalClear", {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.threadGoalClear,
            params: {
              threadId: command.threadId,
              providerThreadId: command.providerThreadId,
            },
          });
      }
    },

    buildPostInitializeRequests(): readonly ProviderPostInitializeRequest[] {
      return [
        {
          required: true,
          plan: {
            kind: "request",
            method: BRIDGE_REQUEST_METHODS.initialize,
            params: {
              protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
              client: { name: "bb", version: "1.0.0" },
              grammarVersions: ASSEMBLER_GRAMMAR_VERSIONS,
            },
          },
          onResult(result) {
            const parsed = initializeResultSchema.safeParse(result);
            if (!parsed.success) {
              throw new Error(
                `Provider bridge "${options.id}" answered initialize with a malformed result (${parsed.error.issues
                  .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                  .join(
                    "; ",
                  )}). The bridge and this runtime cannot negotiate a handshake; update or fix the "${options.id}" provider plugin.`,
              );
            }
            if (
              parsed.data.protocolVersion !== PROVIDER_BRIDGE_PROTOCOL_VERSION
            ) {
              throw new Error(
                `Provider bridge "${options.id}" speaks Provider Bridge Protocol version ${parsed.data.protocolVersion}, but this runtime requires version ${PROVIDER_BRIDGE_PROTOCOL_VERSION}. Update the "${options.id}" provider plugin to a build published for protocol version ${PROVIDER_BRIDGE_PROTOCOL_VERSION}.`,
              );
            }
            const grammarVersion = negotiateGrammarVersion(
              ASSEMBLER_GRAMMAR_VERSIONS,
              parsed.data.capabilities.grammarVersions,
            );
            if (grammarVersion === null) {
              const [bridgeMin, bridgeMax] =
                parsed.data.capabilities.grammarVersions;
              const [runtimeMin, runtimeMax] = ASSEMBLER_GRAMMAR_VERSIONS;
              throw new Error(
                `Provider bridge "${options.id}" speaks thread/delta grammar versions ${bridgeMin}-${bridgeMax}, but this runtime assembles versions ${runtimeMin}-${runtimeMax}. Update the "${options.id}" provider plugin or bb so the two ranges overlap.`,
              );
            }
            handshake = parsed.data.capabilities;
          },
        },
      ];
    },

    parseModelListResult: parseAvailableModelList,

    translateEvent(event: ProviderRuntimeEvent): ThreadEvent[] {
      const method = event.method;
      if (method === THREAD_DELTA_NOTIFICATION_METHOD) {
        const parsed = threadDeltaNotificationParamsSchema.safeParse(
          event.params,
        );
        if (!parsed.success) {
          return [];
        }
        return deltaAssembler.assemble({
          threadId: parsed.data.threadId,
          deltas: parsed.data.deltas,
        });
      }
      if (method === BRIDGE_NOTIFICATION_METHODS.threadIdentity) {
        const parsed = threadIdentityNotificationParamsSchema.safeParse(
          event.params,
        );
        if (!parsed.success) {
          return [];
        }
        return [
          {
            type: "thread/identity",
            threadId: parsed.data.threadId,
            providerThreadId: parsed.data.providerThreadId,
            scope: { kind: "thread" },
          },
        ];
      }
      if (method === BRIDGE_NOTIFICATION_METHODS.sessionReplaced) {
        const parsed = sessionReplacedNotificationParamsSchema.safeParse(
          event.params,
        );
        if (
          !parsed.success ||
          parsed.data.providerThreadId === null ||
          (!parsed.data.contextLost && !parsed.data.showRuntimeNote)
        ) {
          return [];
        }
        if (!parsed.data.contextLost) {
          return [
            {
              type: "provider/warning",
              threadId: parsed.data.threadId,
              providerThreadId: parsed.data.providerThreadId,
              category: "general",
              summary: parsed.data.reason,
              scope: { kind: "thread" },
            },
          ];
        }
        return [
          {
            type: "provider/warning",
            threadId: parsed.data.threadId,
            providerThreadId: parsed.data.providerThreadId,
            category: "general",
            summary:
              "Provider session was replaced; provider-side context was lost.",
            details: parsed.data.reason,
            scope: { kind: "thread" },
          },
        ];
      }
      if (method === BRIDGE_NOTIFICATION_METHODS.error) {
        const parsed = errorNotificationParamsSchema.safeParse(event.params);
        if (
          !parsed.success ||
          parsed.data.threadId === undefined ||
          parsed.data.providerThreadId === undefined
        ) {
          return [];
        }
        return [
          {
            type: "provider/warning",
            threadId: parsed.data.threadId,
            providerThreadId: parsed.data.providerThreadId,
            category: "general",
            summary: parsed.data.message,
            scope: { kind: "thread" },
          },
        ];
      }
      return [];
    },

    decodeRecoveryHint(
      event: ProviderRuntimeEvent,
    ): ProviderRecoveryHint | null {
      if (event.method !== BRIDGE_NOTIFICATION_METHODS.providerRecovery) {
        return null;
      }
      const parsed = providerRecoveryNotificationSchema.safeParse(event.params);
      if (!parsed.success) {
        return null;
      }
      return {
        ...(parsed.data.threadId === undefined
          ? {}
          : { threadId: parsed.data.threadId }),
        kind: parsed.data.kind,
        message: parsed.data.message,
        retryable: parsed.data.retryable,
      };
    },

    decodeToolCallRequest(
      request: ProviderInboundRequest,
    ): DecodedToolCallRequest | null {
      if (typeof request.id !== "string" && typeof request.id !== "number") {
        return null;
      }
      const decoded = decodeNormalizedProviderToolCallRequest(
        request.id,
        request.method,
        request.params,
      );
      if (decoded === null) {
        return decoded;
      }
      const marker = providerNativeIdsParamsSchema.safeParse(request.params);
      if (
        marker.success !== true ||
        marker.data.providerNativeIds !== true ||
        decoded.threadId === undefined
      ) {
        return decoded;
      }
      return {
        ...decoded,
        turnId:
          decoded.turnId === null
            ? null
            : (deltaAssembler.getBbTurnId(decoded.threadId, decoded.turnId) ??
              decoded.turnId),
        callId:
          deltaAssembler.getBbItemId(decoded.threadId, decoded.callId) ??
          decoded.callId,
      };
    },

    decodeInteractiveRequest(
      request: ProviderInboundRequest,
    ): DecodedInteractiveRequest | null {
      if (
        request.method !== BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest ||
        (typeof request.id !== "string" && typeof request.id !== "number")
      ) {
        return null;
      }
      const parsed = interactionRequestParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return null;
      }
      const { providerNativeIds, threadId, ...decoded } = parsed.data;
      let turnId = decoded.turnId;
      let payload = decoded.payload;
      if (providerNativeIds === true && threadId !== undefined) {
        turnId =
          turnId === null
            ? null
            : (deltaAssembler.getBbTurnId(threadId, turnId) ?? turnId);
        if (payload.kind === "approval") {
          payload = {
            ...payload,
            subject: {
              ...payload.subject,
              itemId:
                deltaAssembler.getBbItemId(threadId, payload.subject.itemId) ??
                payload.subject.itemId,
            },
          };
        }
      }
      return {
        requestId: request.id,
        method: request.method,
        providerThreadId: decoded.providerThreadId,
        turnId,
        payload,
        ...(threadId ? { threadId } : {}),
      };
    },

    buildInteractiveResponse(
      args: BuildInteractiveResponseArgs,
    ): ProviderInteractiveResponse {
      return args.resolution as unknown as ProviderInteractiveResponse;
    },
  };

  return adapter;
}
