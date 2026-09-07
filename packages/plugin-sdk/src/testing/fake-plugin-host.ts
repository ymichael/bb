import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
import { Hono } from "hono";
import { PLUGIN_INTERACTION_MAX_TITLE_LENGTH } from "@bb/domain/plugin-interaction-limits";
import {
  adoptHttpRouteResponse,
  AGENT_TOOL_NAME_PATTERN,
  agentToolIconRefusalMessage,
  aiServiceAlreadyRegisteredMessage,
  pluginHookAlreadyRegisteredMessage,
  assertAiServiceRegistrable,
  assertNoRecursiveJsonSchemaReferences,
  BACKGROUND_NAME_PATTERN,
  CLI_COMMAND_NAME_PATTERN,
  enforcePluginCliOutputLimit,
  isStandardSchema,
  isZodSchemaLike,
  storePluginHook,
  KV_VALUE_MAX_BYTES,
  MENTION_PROVIDER_ID_PATTERN,
  normalizeMentionProviderTriggers,
  parsePluginAgentToolPresentation,
  pluginCliCollisionWarning,
  PLUGIN_AGENT_DYNAMIC_INSTRUCTIONS_MAX_CHARS,
  PLUGIN_AGENT_SELECTION_MAX_IDS,
  PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS,
  PLUGIN_AGENT_TOOL_PARAMETERS_MAX_BYTES,
  PLUGIN_HTTP_METHODS,
  providerAlreadyRegisteredMessage,
  providerIconRefusalMessage,
  providerWithoutBridgeMessage,
  readRpcMethodContract,
  registerSettingDescriptors,
  rejectStaleAgentToolFields,
  RESERVED_AGENT_TOOL_NAMES,
  RPC_METHOD_PATTERN,
  summarizeParseIssues,
  undeclaredIconProblem,
  validatePluginAiServiceDeclaration,
  validatePluginProviderDeclaration,
  validatePluginProviderEnvEntries,
  validateSettingsUpdate,
  zodSchemaToJsonSchema,
  type NormalizedPluginProviderDeclaration,
} from "../internal/host-policy.js";
import type {
  BbPluginApi,
  PluginAgentConfiguration,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginAgentToolPresentation,
  PluginAgentToolResult,
  PluginAgents,
  PluginBackground,
  PluginCli,
  PluginCliCommandInfo,
  PluginCliContext,
  PluginCliExecutionResult,
  PluginCliResult,
  PluginHookHandler,
  PluginHookName,
  PluginHooks,
  PluginEvents,
  PluginHttp,
  PluginHttpAuthMode,
  PluginHttpHandler,
  PluginHosts,
  PluginSharedPortTunnelIdentity,
  PluginInteractionRequest,
  PluginInteractionResult,
  PluginKvStorage,
  PluginLogger,
  PluginMentionItem,
  PluginMentionSearchContext,
  PluginMentionTrigger,
  PluginAiServiceDeclaration,
  PluginAiServices,
  PluginProviderDeclaration,
  ExperimentalPluginProviderEnvContext,
  ExperimentalPluginProviderEnvEntry,
  ExperimentalPluginProviderEnvHealth,
  ExperimentalPluginProviderEnvHealthContext,
  ExperimentalPluginWebSocket,
  ExperimentalPluginWebSocketHandler,
  ExperimentalPluginWebSocketHandlers,
  PluginProviders,
  PluginRealtime,
  PluginRpc,
  PluginServerApi,
  PluginSettingDescriptors,
  PluginSettingValue,
  PluginSettings,
  PluginSettingsValues,
  PluginStatusApi,
  PluginStorage,
  PluginThreadEventHandler,
  PluginThreadEventName,
  PluginThreadEventPayloads,
  PluginUi,
  PluginRpcError,
  PluginRpcValidationIssue,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
  JsonValue,
} from "@get-bb/plugin-sdk";
import {
  createFakeSdk,
  type FakeSdkHarness,
  type FakeSdkOverrides,
} from "./fake-sdk.js";

const LEGACY_UNKNOWN_MIGRATION_HASH = "legacy-unknown";

function migrationStatementHash(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}

/**
 * `createFakePluginHost` — an in-process stand-in for the BB server's plugin
 * runtime (apps/server/src/services/plugins/plugin-api.ts), for unit-testing
 * a plugin's `server.ts` without a server. `bb` satisfies {@link BbPluginApi};
 * `harness` drives and inspects it.
 *
 * Faithful where a plugin can observe it: registration name validation and
 * error messages, the kv 256KB cap, append-only database migrations, settings
 * read/update semantics (including onChange), schema-validated rpc/cli
 * invocation shapes (strict JSON boundaries, exit-code normalization), `threads.spawn`
 * attribution, atomic reload, and dispose order (services aborted, hooks LIFO,
 * database closed, stale handles throw). New tests can keep host inputs,
 * assertions, and shutdown explicit through `harness.behavior`,
 * `harness.inspection`, and `harness.lifecycle`; direct members remain aliases.
 *
 * Deliberately different from the real host:
 * - storage is process-local: kv in a Map, `storage.database()` one shared
 *   better-sqlite3 handle in a temp directory (same data across calls, like
 *   the host's shared file), secret settings alongside plain values (no files).
 * - `bb.sdk` is always bound (no listen gate) and every unstubbed method
 *   throws instead of hitting a server.
 * - http auth modes are recorded but not enforced — signature checks and
 *   token handling inside handlers still run.
 * - background services/schedules never run on timers; `harness.runService`
 *   and `harness.runSchedule` invoke them deterministically.
 */

/** Same shape (and name) the real host throws for stale API handles. */
export class PluginContextStaleError extends Error {
  constructor(pluginId: string) {
    super(
      `plugin "${pluginId}" used a stale API handle — it was reloaded or disabled; ` +
        `re-entry happens via a fresh factory call`,
    );
    this.name = "PluginContextStaleError";
  }
}

export type FakeLogLevel = "debug" | "info" | "warn" | "error";

export interface FakeLogEntry {
  level: FakeLogLevel;
  message: string;
}

export interface FakeHttpRouteRecord {
  method: string;
  path: string;
  auth: PluginHttpAuthMode;
  handler: PluginHttpHandler;
}

export interface ExperimentalFakeWebSocketRouteRecord {
  path: string;
  auth: PluginHttpAuthMode;
  handler: ExperimentalPluginWebSocketHandler;
}

export interface ExperimentalFakeWebSocketSession {
  readonly sent: readonly (string | Uint8Array)[];
  readonly closeCalls: readonly {
    code: number | null;
    reason: string | null;
  }[];
  readonly readyState: number;
  receive(data: string | Uint8Array): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
  error(error: Error): Promise<void>;
}

export interface FakeScheduleRecord {
  name: string;
  cron: string;
  fn: () => void | Promise<void>;
}

export interface FakeServiceRecord {
  name: string;
  start: (signal: AbortSignal) => void | Promise<void>;
}

export interface FakeCliRecord {
  name: string;
  summary: string;
  commands: PluginCliCommandInfo[];
  run: (
    argv: string[],
    ctx: PluginCliContext,
  ) => PluginCliResult | Promise<PluginCliResult>;
}

export interface FakeAgentToolRecord {
  name: string;
  description: string;
  instructions: string | null;
  /**
   * The plugin's declared row presentation, null when it declared none.
   * Parsed by the shared `parsePluginAgentToolPresentation`, so the record
   * holds exactly what the production host stores and a presentation bb
   * rejects is rejected here with the same message.
   */
  presentation: PluginAgentToolPresentation | null;
  /** JSON-schema object the host would send providers. */
  inputSchema: unknown;
  parse(
    input: unknown,
  ): { ok: true; value: unknown } | { ok: false; error: string };
  execute(
    params: unknown,
    ctx: PluginAgentToolContext,
  ): PluginAgentToolResult | Promise<PluginAgentToolResult>;
}

export interface FakeMentionProviderRecord {
  id: string;
  label: string;
  triggers: readonly PluginMentionTrigger[];
  search: (
    ctx: PluginMentionSearchContext,
  ) => PluginMentionItem[] | Promise<PluginMentionItem[]>;
  resolve: (
    itemId: string,
  ) => { context: string } | Promise<{ context: string }>;
}

export interface FakeRealtimeSignal {
  channel: string;
  /** JSON-round-tripped, like the WS broadcast; `undefined` → `null`. */
  payload: unknown;
}

export interface ExperimentalFakeHostRpcCall {
  method: string;
  input: unknown;
  hostId: string;
  signal?: AbortSignal;
}

/** Everything the plugin registered, exposed raw for assertions. */
export interface FakePluginRegistrations {
  settingsDescriptors: PluginSettingDescriptors;
  httpRoutes: FakeHttpRouteRecord[];
  websocketRoutes: ExperimentalFakeWebSocketRouteRecord[];
  rpcMethods: string[];
  services: FakeServiceRecord[];
  schedules: FakeScheduleRecord[];
  cli: FakeCliRecord | null;
  agentTools: FakeAgentToolRecord[];
  /** Provider from bb.agents.configure, or null when none registered. */
  agentConfigurationProvider:
    | ((context: PluginAgentConfigurationContext) => PluginAgentConfiguration)
    | null;
  /** Provider from contributeInstructions, or null when none registered. */
  instructionProvider:
    | ((ctx: { threadId: string; projectId: string }) => string | null)
    | null;
  threadEventHandlers: Record<PluginThreadEventName, number>;
  /** The handler registered per hook by `bb.experimental_hooks.on`. */
  hooks: {
    [K in PluginHookName]: PluginHookHandler<K> | null;
  };
  mentionProviders: FakeMentionProviderRecord[];
  /** Live provider registrations from `bb.providers.register`
   * (normalized declarations, registration order; dispose removes). */
  providerRegistrations: NormalizedPluginProviderDeclaration[];
  providerEnvResolvers: ReadonlyMap<
    string,
    (
      context: ExperimentalPluginProviderEnvContext,
    ) =>
      | Promise<readonly ExperimentalPluginProviderEnvEntry[]>
      | readonly ExperimentalPluginProviderEnvEntry[]
  >;
  providerEnvHealthResolvers: ReadonlyMap<
    string,
    (
      context: ExperimentalPluginProviderEnvHealthContext,
    ) =>
      | ExperimentalPluginProviderEnvHealth
      | null
      | Promise<ExperimentalPluginProviderEnvHealth | null>
  >;
  /** Live AI-service registrations from `experimental_aiServices.register`
   * (normalized declarations, registration order; dispose removes). */
  aiServiceRegistrations: PluginAiServiceDeclaration[];
}

/** Read-only state for assertions after a plugin registers or handles work. */
export interface FakePluginInspectionState {
  readonly pluginId: string;
  /** Every `bb.log` line, in order. */
  readonly logEntries: FakeLogEntry[];
  /** Every `bb.realtime.publish`, payload normalized like the wire. */
  readonly realtimeSignals: FakeRealtimeSignal[];
  /** Every `bb.status.needsConfiguration` message, in order. */
  readonly needsConfigurationMessages: string[];
  /**
   * How many times the plugin called
   * `bb.experimental_hooks.recheck()` — the wake it asks core for when a
   * condition its own waits depend on has changed.
   */
  readonly recheckCount: number;
  /** Recorded `bb.sdk` calls + stub control. */
  readonly sdk: FakeSdkHarness;
  readonly registrations: FakePluginRegistrations;
  readonly sharedPortDeclarations: Array<{
    hostId: string;
    ports: number[];
  }>;
  /** Calls made through bb.hosts.experimental_client, after input validation. */
  readonly experimental_hostRpcCalls: readonly ExperimentalFakeHostRpcCall[];
  readonly pendingInteractions: readonly (PluginInteractionRequest & {
    id: string;
  })[];
}

/** Deterministic inputs that stand in for behavior normally driven by BB. */
export interface FakePluginBehaviorDrivers {
  /** Deliver an unexpected host-worker exit to every registered client. */
  experimental_emitHostWorkerExit(hostId: string): Promise<void>;
  /** Deliver a host signal through its registered payload schema. */
  experimental_emitHostSignal(
    hostId: string,
    signal: string,
    payload: unknown,
  ): Promise<void>;
  submitInteraction(id: string, value: JsonValue): void;
  cancelInteraction(id: string): void;
  /**
   * Apply a settings update the way the host's settings save does:
   * validate against the declared descriptors (`null` unsets), store, and
   * fire `onChange` listeners when effective values changed. Throws on
   * unknown keys or wrong value types.
   */
  setSettings(values: Record<string, PluginSettingValue | null>): Promise<void>;
  /**
   * Invoke a registered rpc method with host semantics: input/output schemas,
   * strict JSON result normalization, and structured failure codes. Rejects
   * with the same message/code/issues the frontend client surfaces.
   */
  callRpc(method: string, input?: unknown): Promise<unknown>;
  /**
   * Invoke the plugin's CLI command with host semantics: the result's
   * exitCode must be a number, stdout/stderr default to "", and a throwing
   * run() becomes `{ exitCode: 1, stderr: "bb <name> failed: …" }`.
   */
  runCli(
    argv: string[],
    ctx?: PluginCliContext,
  ): Promise<PluginCliExecutionResult>;
  /**
   * Dispatch a request to a registered `bb.http` route (exact method+path
   * match, like the host's V1 router) through a real Hono context. Auth
   * modes are not enforced. A throwing handler yields the host's 500
   * `{ ok: false, error: "plugin route failed: …" }` response.
   */
  fetchHttp(
    method: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response>;
  /** Open and drive an exact-match `bb.http.experimental_websocket` route. */
  experimental_openWebSocket(
    path: string,
    init?: RequestInit,
  ): Promise<ExperimentalFakeWebSocketSession>;
  /**
   * Start a registered background service once, deterministically. `done`
   * settles when `start` returns; abort `controller` to signal shutdown.
   * A thrown NeedsConfigurationError (matched by name, like the host) is
   * recorded via needsConfiguration and resolves `done`; other errors
   * reject it.
   */
  runService(name: string): {
    controller: AbortController;
    done: Promise<void>;
  };
  /** Run a registered schedule's function once (no timers, no cron sweep). */
  runSchedule(name: string): Promise<void>;
  /**
   * Deliver a thread lifecycle event to every `bb.events.on` handler. Handlers run
   * sequentially; errors are caught and logged like the host's
   * fire-and-forget dispatch, and returned for assertions.
   */
  emitThreadEvent<E extends PluginThreadEventName>(
    event: E,
    payload: PluginThreadEventPayloads[E],
  ): Promise<{ errors: unknown[] }>;
  /**
   * Call a registered agent tool the way a provider tool-call would:
   * arguments go through the tool's parse step (zod-validated for zod
   * registrations; a parse failure throws), then execute. `ctx` fields
   * default to "thread-test"/"project-test" and a fresh signal.
   */
  callAgentTool(
    name: string,
    input: unknown,
    ctx?: Partial<PluginAgentToolContext>,
  ): Promise<PluginAgentToolResult>;
  /** Evaluate `bb.agents.configure` with production validation/fail-closed
   * semantics. With no callback, every registered tool/declared test skill is
   * selected. Callback failures are logged and return empty selections. */
  resolveAgentConfiguration(context: PluginAgentConfigurationContext): Promise<{
    tools: FakeAgentToolRecord[];
    skills: string[];
    instructions: string | null;
  }>;
  resolveProviderEnv(
    providerId: string,
    context: ExperimentalPluginProviderEnvContext,
  ): Promise<ExperimentalPluginProviderEnvEntry[]>;
  resolveProviderEnvHealth(
    providerId: string,
    context: ExperimentalPluginProviderEnvHealthContext,
  ): Promise<ExperimentalPluginProviderEnvHealth | null>;
}

/** Reload/shutdown controls, kept separate from behavior and inspection. */
export interface FakePluginLifecycleControls {
  /**
   * Load a replacement against the same persisted settings, kv, and database.
   * The current host remains live when the factory throws; on success its
   * services/hooks are disposed and the returned host becomes current.
   */
  reload(
    factory: (bb: BbPluginApi) => void | Promise<void>,
  ): Promise<FakePluginHost>;
  /**
   * Dispose like a host reload/disable: abort services started via
   * runService, run onDispose hooks LIFO (isolated), close database handles,
   * then poison the `bb` handle (further use throws
   * PluginContextStaleError). Idempotent.
   */
  dispose(): Promise<void>;
}

/**
 * Complete fake-host harness. Direct members are retained for compatibility;
 * the named views make intent explicit in new tests.
 */
export interface FakePluginHarness
  extends
    FakePluginInspectionState,
    FakePluginBehaviorDrivers,
    FakePluginLifecycleControls {
  readonly behavior: FakePluginBehaviorDrivers;
  readonly inspection: FakePluginInspectionState;
  readonly lifecycle: FakePluginLifecycleControls;
}

export interface CreateFakePluginHostOptions {
  /** Defaults to "test-plugin". */
  pluginId?: string;
  /**
   * Value served by `bb.server.experimental_appUrl`. Defaults to `null`.
   */
  appUrl?: string | null;
  /**
   * Value served by `bb.server.loopbackBaseUrl` (always bound here, like
   * `bb.sdk`). Defaults to "http://127.0.0.1:38886".
   */
  loopbackBaseUrl?: string;
  /**
   * Value served by `bb.server.experimental_dataDir`. Defaults to
   * "/tmp/bb-fake-data-dir".
   */
  dataDir?: string;
  /**
   * Pre-seeded stored settings values (as if saved before this load) —
   * including secret ones, which the fake keeps in memory instead of
   * files. Values with the wrong type for their descriptor fall back to
   * the descriptor default on read, like the host.
   */
  settings?: Record<string, PluginSettingValue>;
  /** Initial `bb.sdk` stubs; extend later via `harness.sdk.stub`. */
  sdk?: FakeSdkOverrides;
  /** Static manifest skill ids available to configure() in this fake host. */
  agentSkillIds?: readonly string[];
  /** Read-only identities returned by bb.hosts.ensureSharedPortTunnel. */
  sharedPortTunnelIdentities?: Record<string, PluginSharedPortTunnelIdentity>;
  /**
   * Whether the plugin's manifest declares a `bb.host` entry. Production
   * refuses `bb.providers.register` (the provider would have no bridge to
   * run on) and `experimental_aiServices.register` (the service would have
   * nothing to run on) without one; the fake applies the same rules.
   * Defaults to true.
   */
  experimental_hostEntry?: boolean;
  /**
   * The icon names the plugin's manifest declares under
   * `bb.branding.experimental_icons`. Production refuses a provider `icon`
   * or a tool `presentation.icon.glyph` that is a namespaced glyph
   * (`"<pluginId>/<name>"`) naming another plugin or a name not declared
   * there; the fake applies the same rule against this list. Defaults to
   * none declared, so every namespaced glyph is refused until the test
   * names the icons the manifest would.
   */
  experimental_declaredIconNames?: readonly string[];
  /** Deterministic stand-in for the targeted daemon host entry. */
  experimental_callHostRpc?: (
    call: ExperimentalFakeHostRpcCall,
  ) => unknown | Promise<unknown>;
}

export interface FakePluginHost {
  bb: BbPluginApi;
  harness: FakePluginHarness;
}

/** Effective typed values: stored value when valid, else the default, else undefined. */
function readSettingsValues(
  descriptors: PluginSettingDescriptors,
  stored: Map<string, PluginSettingValue>,
): Record<string, PluginSettingValue | undefined> {
  const values: Record<string, PluginSettingValue | undefined> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    let value = stored.get(key);
    if (descriptor.type === "number" && typeof value === "string") {
      const legacyNumber = Number(value.trim());
      value =
        value.trim().length > 0 && Number.isFinite(legacyNumber)
          ? legacyNumber
          : undefined;
    }
    if (
      descriptor.type === "number" &&
      typeof value === "number" &&
      !Number.isFinite(value)
    ) {
      value = undefined;
    }
    const expected =
      descriptor.type === "boolean"
        ? "boolean"
        : descriptor.type === "number"
          ? "number"
          : "string";
    if (typeof value !== expected) value = undefined;
    if (
      descriptor.type === "select" &&
      typeof value === "string" &&
      !descriptor.options.includes(value)
    ) {
      value = undefined;
    }
    values[key] = value ?? descriptor.default;
  }
  return values;
}

// ---------------------------------------------------------------------------

function isNeedsConfigurationError(error: unknown): error is Error {
  return error instanceof Error && error.name === "NeedsConfigurationError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonRoundTrip(value: unknown, what: string): unknown {
  if (value === undefined) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw new Error(`${what} is not JSON-serializable`);
  }
  return JSON.parse(json);
}

interface FakeRpcRecord {
  inputSchema: StandardSchemaV1;
  outputSchema: StandardSchemaV1;
  handler: (input: never) => unknown;
}

type FakeHostWorkerExitSubscription = (event: {
  readonly hostId: string;
}) => void | Promise<void>;

interface FakeHostSignalSubscription {
  signal: string;
  payloadSchema: StandardSchemaV1;
  handler: (event: {
    hostId: string;
    payload: unknown;
  }) => void | Promise<void>;
}

function normalizeRpcIssues(
  issues: readonly StandardSchemaV1Issue[],
): PluginRpcValidationIssue[] {
  return issues.map((issue) => {
    const rawPath = issue.path;
    const segments =
      rawPath === undefined ? [] : Array.isArray(rawPath) ? rawPath : [rawPath];
    const path = segments.map((segment) => {
      const key =
        typeof segment === "object" && segment !== null
          ? Reflect.get(segment, "key")
          : segment;
      return typeof key === "number" ? key : String(key);
    });
    return {
      message: issue.message,
      ...(path.length > 0 ? { path } : {}),
    };
  });
}

function throwRpcError(error: PluginRpcError): never {
  const thrown = new Error(error.message);
  Reflect.set(thrown, "code", error.code);
  if (error.issues !== undefined) Reflect.set(thrown, "issues", error.issues);
  throw thrown;
}

async function validateRpcValue(
  schema: StandardSchemaV1,
  value: unknown,
  phase: "input" | "output",
): Promise<unknown> {
  let result: StandardSchemaV1Result<unknown>;
  try {
    result = await schema["~standard"].validate(value);
  } catch (error) {
    const message = errorMessage(error);
    return throwRpcError({
      code: phase === "input" ? "invalid_input" : "invalid_output",
      message: `rpc ${phase} validator failed: ${message}`,
      issues: [{ message }],
    });
  }
  if (result.issues !== undefined) {
    return throwRpcError({
      code: phase === "input" ? "invalid_input" : "invalid_output",
      message: `rpc ${phase} validation failed`,
      issues: normalizeRpcIssues(result.issues),
    });
  }
  return result.value;
}

function normalizeRpcJsonResult(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  function visit(current: unknown, path: string): JsonValue {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return throwRpcError({
          code: "non_json_result",
          message: `rpc result at ${path} contains a non-finite number`,
        });
      }
      return current;
    }
    if (typeof current !== "object") {
      return throwRpcError({
        code: "non_json_result",
        message: `rpc result at ${path} is not a JSON value (${typeof current})`,
      });
    }
    if (ancestors.has(current)) {
      return throwRpcError({
        code: "non_json_result",
        message: `rpc result at ${path} is cyclic`,
      });
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item, index) => visit(item, `${path}[${index}]`));
      }
      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        return throwRpcError({
          code: "non_json_result",
          message: `rpc result at ${path} must be a plain JSON object`,
        });
      }
      if (Reflect.ownKeys(current).some((key) => typeof key === "symbol")) {
        return throwRpcError({
          code: "non_json_result",
          message: `rpc result at ${path} contains a symbol key`,
        });
      }
      const normalized: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(current)) {
        normalized[key] = visit(child, `${path}.${key}`);
      }
      return normalized;
    } finally {
      ancestors.delete(current);
    }
  }
  return visit(value, "$result");
}

function normalizeAgentToolSelections(args: {
  knownIds: ReadonlySet<string>;
  pluginId: string;
  value: unknown;
}): {
  toolIds: string[];
  parameterOverrides: Map<string, Record<string, unknown>>;
} {
  if (!Array.isArray(args.value)) {
    throw new Error("configure() output.tools must be an array");
  }
  if (args.value.length > PLUGIN_AGENT_SELECTION_MAX_IDS) {
    throw new Error(
      `configure() output.tools exceeds the ${PLUGIN_AGENT_SELECTION_MAX_IDS}-id limit`,
    );
  }
  const toolIds: string[] = [];
  const parameterOverrides = new Map<string, Record<string, unknown>>();
  const seen = new Set<string>();
  for (let index = 0; index < args.value.length; index += 1) {
    const entry = args.value[index];
    let name: unknown;
    let parameters: Record<string, unknown> | null = null;
    if (typeof entry === "string") {
      name = entry;
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry)
    ) {
      const typed = entry as Record<string, unknown>;
      const unknownKeys = Object.keys(typed)
        .filter((key) => !["name", "parameters"].includes(key))
        .sort();
      if (unknownKeys.length > 0) {
        throw new Error(
          `configure() output.tools[${index}] contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`,
        );
      }
      name = typed.name;
      parameters = normalizeAgentToolParameters({
        index,
        value: typed.parameters,
      });
    } else {
      throw new Error(
        `configure() output.tools[${index}] must be a tool name or { name, parameters }`,
      );
    }
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        `configure() output.tools[${index}] must ${typeof entry === "string" ? "be" : "name"} a non-empty string`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `configure() output.tools contains duplicate id ${JSON.stringify(name)}`,
      );
    }
    if (!args.knownIds.has(name)) {
      throw new Error(
        `configure() selected unknown tool id ${JSON.stringify(name)} owned by plugin ${JSON.stringify(args.pluginId)}`,
      );
    }
    seen.add(name);
    toolIds.push(name);
    if (parameters !== null) parameterOverrides.set(name, parameters);
  }
  return { toolIds, parameterOverrides };
}

function normalizeAgentToolParameters(args: {
  index: number;
  value: unknown;
}): Record<string, unknown> {
  const { index, value } = args;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `configure() output.tools[${index}].parameters must be a JSON-schema object`,
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(
      `configure() output.tools[${index}].parameters is not JSON-serializable`,
    );
  }
  if (serialized === undefined) {
    throw new Error(
      `configure() output.tools[${index}].parameters is not JSON-serializable`,
    );
  }
  if (
    Buffer.byteLength(serialized, "utf8") >
    PLUGIN_AGENT_TOOL_PARAMETERS_MAX_BYTES
  ) {
    throw new Error(
      `configure() output.tools[${index}].parameters exceeds the ${PLUGIN_AGENT_TOOL_PARAMETERS_MAX_BYTES}-byte limit`,
    );
  }
  const parameters = JSON.parse(serialized) as Record<string, unknown>;
  if (parameters.type !== "object") {
    throw new Error(
      `configure() output.tools[${index}].parameters must have root type "object"`,
    );
  }
  assertNoRecursiveJsonSchemaReferences(
    parameters,
    `configure() output.tools[${index}].parameters`,
  );
  return parameters;
}

function normalizeAgentConfigurationIds(args: {
  field: "skills";
  knownIds: ReadonlySet<string>;
  pluginId: string;
  value: unknown;
}): string[] {
  if (!Array.isArray(args.value)) {
    throw new Error(`configure() output.${args.field} must be an array`);
  }
  if (args.value.length > PLUGIN_AGENT_SELECTION_MAX_IDS) {
    throw new Error(
      `configure() output.${args.field} exceeds the ${PLUGIN_AGENT_SELECTION_MAX_IDS}-id limit`,
    );
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.value.length; index += 1) {
    const id = args.value[index];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        `configure() output.${args.field}[${index}] must be a non-empty string`,
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `configure() output.${args.field} contains duplicate id ${JSON.stringify(id)}`,
      );
    }
    if (!args.knownIds.has(id)) {
      throw new Error(
        `configure() selected unknown skill id ${JSON.stringify(id)} owned by plugin ${JSON.stringify(args.pluginId)}`,
      );
    }
    seen.add(id);
    selected.push(id);
  }
  return selected;
}

function normalizeAgentConfiguration(args: {
  knownSkillIds: ReadonlySet<string>;
  knownToolIds: ReadonlySet<string>;
  pluginId: string;
  value: unknown;
}): {
  toolIds: string[];
  toolParameterOverrides: Map<string, Record<string, unknown>>;
  skillIds: string[];
  instructions: string | null;
} {
  if (
    typeof args.value !== "object" ||
    args.value === null ||
    Array.isArray(args.value)
  ) {
    throw new Error(
      "configure() must return { tools: string[], skills: string[], instructions?: string }",
    );
  }
  const output = args.value as Record<string, unknown>;
  const unknownKeys = Object.keys(output)
    .filter((key) => !["tools", "skills", "instructions"].includes(key))
    .sort();
  if (unknownKeys.length > 0) {
    throw new Error(
      `configure() output contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`,
    );
  }
  if (
    output.instructions !== undefined &&
    typeof output.instructions !== "string"
  ) {
    throw new Error("configure() output.instructions must be a string");
  }
  const toolSelections = normalizeAgentToolSelections({
    knownIds: args.knownToolIds,
    pluginId: args.pluginId,
    value: output.tools,
  });
  return {
    toolIds: toolSelections.toolIds,
    toolParameterOverrides: toolSelections.parameterOverrides,
    skillIds: normalizeAgentConfigurationIds({
      field: "skills",
      knownIds: args.knownSkillIds,
      pluginId: args.pluginId,
      value: output.skills,
    }),
    instructions:
      typeof output.instructions === "string" &&
      output.instructions.trim().length > 0
        ? output.instructions.slice(
            0,
            PLUGIN_AGENT_DYNAMIC_INSTRUCTIONS_MAX_CHARS,
          )
        : null,
  };
}

interface FakePluginPersistentState {
  kvRows: Map<string, string>;
  storageRoot: string;
  storedSettings: Map<string, PluginSettingValue>;
}

const fakeHostDisposers = new WeakMap<
  FakePluginHarness,
  (cleanupStorage: boolean) => Promise<void>
>();

export function createFakePluginHost(
  options: CreateFakePluginHostOptions = {},
): FakePluginHost {
  return createFakePluginHostInternal(options);
}

function createFakePluginHostInternal(
  options: CreateFakePluginHostOptions,
  sharedState?: FakePluginPersistentState,
): FakePluginHost {
  const persistentState =
    sharedState ??
    ({
      kvRows: new Map<string, string>(),
      storageRoot: mkdtempSync(join(tmpdir(), "bb-fake-plugin-host-")),
      storedSettings: new Map<string, PluginSettingValue>(
        Object.entries(options.settings ?? {}),
      ),
    } satisfies FakePluginPersistentState);
  const pluginId = options.pluginId ?? "test-plugin";
  const declaredIconNames = new Set(
    options.experimental_declaredIconNames ?? [],
  );
  const agentSkillIds = [...(options.agentSkillIds ?? [])];
  if (new Set(agentSkillIds).size !== agentSkillIds.length) {
    throw new Error("agentSkillIds must not contain duplicates");
  }
  let invalidated = false;
  let disposed = false;

  function assertLive(): void {
    if (invalidated) throw new PluginContextStaleError(pluginId);
  }

  // --- log ---
  const logEntries: FakeLogEntry[] = [];
  function emitLog(level: FakeLogLevel, message: string): void {
    logEntries.push({ level, message });
  }
  const log: PluginLogger = {
    debug: (message) => emitLog("debug", message),
    info: (message) => emitLog("info", message),
    warn: (message) => emitLog("warn", message),
    error: (message) => emitLog("error", message),
  };

  // --- storage ---
  const kvRows = persistentState.kvRows;
  const kv: PluginKvStorage = {
    async get(key) {
      assertLive();
      const raw = kvRows.get(key);
      if (raw === undefined) return undefined;
      return JSON.parse(raw);
    },
    async set(key, value) {
      assertLive();
      const json = JSON.stringify(value);
      if (json === undefined) {
        throw new Error(`kv value for "${key}" is not JSON-serializable`);
      }
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > KV_VALUE_MAX_BYTES) {
        throw new Error(
          `kv value for "${key}" is ${bytes} bytes; the limit is ${KV_VALUE_MAX_BYTES} (256KB). ` +
            `Store large data in storage.database() instead.`,
        );
      }
      kvRows.set(key, json);
    },
    async delete(key) {
      assertLive();
      kvRows.delete(key);
    },
    async list(prefix) {
      assertLive();
      return [...kvRows.keys()]
        .filter((key) => prefix === undefined || key.startsWith(prefix))
        .sort();
    },
  };

  const storageRoot = persistentState.storageRoot;

  // One shared temp-file handle: every database() call sees the same data,
  // like the host's handles over one on-disk file. Like the host, a handle
  // the plugin closed itself is replaced on the next call.
  let databaseHandle: Database.Database | undefined;
  const storage: PluginStorage = {
    kv,
    database() {
      assertLive();
      if (!databaseHandle?.open) {
        databaseHandle = new Database(join(storageRoot, "data.db"));
        databaseHandle.pragma("busy_timeout = 5000");
      }
      return databaseHandle;
    },
    migrate(database, statements) {
      assertLive();
      database.exec(
        "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
      );
      const migrationColumns = database
        .prepare<[], { name: string }>("PRAGMA table_info(_bb_migrations)")
        .all();
      if (
        !migrationColumns.some((column) => column.name === "statement_hash")
      ) {
        database.exec(
          "ALTER TABLE _bb_migrations ADD COLUMN statement_hash TEXT",
        );
      }
      const rows = database
        .prepare<[], { id: number; statement_hash: string | null }>(
          "SELECT id, statement_hash FROM _bb_migrations ORDER BY id",
        )
        .all();
      const applied = new Map<number, string | null>();
      for (const row of rows) applied.set(row.id, row.statement_hash);
      const statementHashes = statements.map(migrationStatementHash);
      statementHashes.forEach((statementHash, index) => {
        const recordedHash = applied.get(index);
        if (
          recordedHash !== undefined &&
          recordedHash !== null &&
          recordedHash !== statementHash
        ) {
          throw new Error(
            `migration ${index} does not match the recorded statement; append a new migration instead of changing or reusing an index`,
          );
        }
      });
      const adopt = database.prepare(
        "UPDATE _bb_migrations SET statement_hash = ? WHERE id = ? AND statement_hash IS NULL",
      );
      const record = database.prepare(
        "INSERT INTO _bb_migrations (id, applied_at, statement_hash) VALUES (?, ?, ?)",
      );
      database.transaction(() => {
        for (const row of rows) {
          if (row.statement_hash !== null) continue;
          adopt.run(
            statementHashes[row.id] ?? LEGACY_UNKNOWN_MIGRATION_HASH,
            row.id,
          );
        }
        statements.forEach((statement, index) => {
          if (applied.has(index)) return;
          database.exec(statement);
          record.run(index, Date.now(), statementHashes[index]);
        });
      })();
    },
  };

  // --- settings ---
  const settingsDescriptors: PluginSettingDescriptors = {};
  const settingsListeners: Array<
    (
      next: Record<string, PluginSettingValue | undefined>,
      prev: Record<string, PluginSettingValue | undefined>,
    ) => void
  > = [];
  const storedSettings = persistentState.storedSettings;

  async function setSettingsValues(
    values: Record<string, unknown>,
  ): Promise<void> {
    const errors = validateSettingsUpdate(settingsDescriptors, values);
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
    const prev = readSettingsValues(settingsDescriptors, storedSettings);
    for (const [key, value] of Object.entries(values)) {
      if (value === null) storedSettings.delete(key);
      else if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        storedSettings.set(key, value);
      } else {
        throw new Error(`setting "${key}" has an unsupported value`);
      }
    }
    const next = readSettingsValues(settingsDescriptors, storedSettings);
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    for (const listener of settingsListeners) {
      try {
        listener(next, prev);
      } catch (error) {
        emitLog(
          "warn",
          `settings onChange listener failed: ${errorMessage(error)}`,
        );
      }
    }
  }

  const settings: PluginSettings = {
    define(descriptors) {
      assertLive();
      const validated = registerSettingDescriptors(
        settingsDescriptors,
        descriptors as Record<string, unknown>,
      );
      type Values = PluginSettingsValues<typeof descriptors>;
      return {
        async get() {
          assertLive();
          return readSettingsValues(validated, storedSettings) as Values;
        },
        async experimental_set(values) {
          assertLive();
          const rawValues: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(values)) {
            rawValues[key] = value;
          }
          const errors = validateSettingsUpdate(validated, rawValues);
          if (errors.length > 0) {
            throw new Error(errors.join("; "));
          }
          await setSettingsValues(rawValues);
          return readSettingsValues(validated, storedSettings) as Values;
        },
        onChange(listener) {
          assertLive();
          settingsListeners.push(
            listener as (typeof settingsListeners)[number],
          );
        },
      };
    },
  };

  // --- http ---
  const httpRoutes: FakeHttpRouteRecord[] = [];
  const websocketRoutes: ExperimentalFakeWebSocketRouteRecord[] = [];
  const websocketSessions = new Set<{
    closeForReload(): Promise<void>;
  }>();
  const http: PluginHttp = {
    route(method, path, handler, opts) {
      assertLive();
      const normalizedMethod = String(method).toUpperCase();
      if (!PLUGIN_HTTP_METHODS.has(normalizedMethod)) {
        throw new Error(
          `invalid http method "${String(method)}" — use one of: ${[...PLUGIN_HTTP_METHODS].join(", ")}`,
        );
      }
      if (typeof path !== "string" || !path.startsWith("/")) {
        throw new Error(
          `http route path must be a string starting with "/", got ${JSON.stringify(path)}`,
        );
      }
      if (typeof handler !== "function") {
        throw new Error(
          `http route handler for ${normalizedMethod} ${path} must be a function`,
        );
      }
      const auth = opts?.auth ?? "local";
      if (auth !== "local" && auth !== "token" && auth !== "none") {
        throw new Error(
          `invalid auth mode "${String(auth)}" for ${normalizedMethod} ${path} — use "local", "token", or "none"`,
        );
      }
      if (
        httpRoutes.some(
          (route) => route.method === normalizedMethod && route.path === path,
        )
      ) {
        throw new Error(
          `http route ${normalizedMethod} ${path} is already registered`,
        );
      }
      httpRoutes.push({ method: normalizedMethod, path, auth, handler });
    },
    experimental_websocket(path, handler, opts) {
      assertLive();
      if (typeof path !== "string" || !path.startsWith("/")) {
        throw new Error(
          `websocket route path must be a string starting with "/", got ${JSON.stringify(path)}`,
        );
      }
      if (typeof handler !== "function") {
        throw new Error(
          `websocket route handler for ${path} must be a function`,
        );
      }
      const auth = opts?.auth ?? "local";
      if (auth !== "local" && auth !== "token" && auth !== "none") {
        throw new Error(
          `invalid auth mode "${String(auth)}" for websocket ${path} — use "local", "token", or "none"`,
        );
      }
      if (websocketRoutes.some((route) => route.path === path)) {
        throw new Error(`websocket route ${path} is already registered`);
      }
      websocketRoutes.push({ path, auth, handler });
    },
  };

  // --- rpc ---
  const rpcHandlers = new Map<string, FakeRpcRecord>();
  const rpc: PluginRpc = {
    register(contract, handlers) {
      assertLive();
      if (
        typeof contract !== "object" ||
        contract === null ||
        Array.isArray(contract)
      ) {
        throw new Error("rpc.register contract must be an object");
      }
      if (
        typeof handlers !== "object" ||
        handlers === null ||
        Array.isArray(handlers)
      ) {
        throw new Error("rpc.register handlers must be an object");
      }
      const pending: Array<[string, FakeRpcRecord]> = [];
      const contractEntries = Object.entries(contract);
      const contractNames = new Set(contractEntries.map(([name]) => name));
      for (const extraName of Object.keys(handlers)) {
        if (!contractNames.has(extraName)) {
          throw new Error(
            `rpc handler "${extraName}" has no matching contract method`,
          );
        }
      }
      for (const [name, contractValue] of contractEntries) {
        if (!RPC_METHOD_PATTERN.test(name)) {
          throw new Error(
            `invalid rpc method name "${name}" — use dot-separated segments with letters, digits, "-" and "_"`,
          );
        }
        const methodContract = readRpcMethodContract(name, contractValue);
        const handler = Reflect.get(handlers, name);
        if (typeof handler !== "function") {
          throw new Error(
            `rpc method "${name}" must provide a handler function`,
          );
        }
        if (rpcHandlers.has(name)) {
          throw new Error(`rpc method "${name}" is already registered`);
        }
        pending.push([
          name,
          {
            inputSchema: methodContract.input,
            outputSchema: methodContract.output,
            handler: handler as (input: never) => unknown,
          },
        ]);
      }
      for (const [name, record] of pending) {
        rpcHandlers.set(name, record);
      }
    },
  };

  // --- realtime ---
  const realtimeSignals: FakeRealtimeSignal[] = [];
  const realtime: PluginRealtime = {
    publish(channel, payload) {
      assertLive();
      if (typeof channel !== "string" || channel.length === 0) {
        throw new Error("realtime channel must be a non-empty string");
      }
      const normalized =
        payload === undefined
          ? null
          : (jsonRoundTrip(
              payload,
              `realtime payload for channel "${channel}"`,
            ) ?? null);
      realtimeSignals.push({ channel, payload: normalized });
    },
  };

  // --- background ---
  const services: FakeServiceRecord[] = [];
  const schedules: FakeScheduleRecord[] = [];
  const background: PluginBackground = {
    service(name, service) {
      assertLive();
      if (typeof name !== "string" || !BACKGROUND_NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid service name ${JSON.stringify(name)} — use letters, digits, "-" and "_"`,
        );
      }
      if (services.some((record) => record.name === name)) {
        throw new Error(`background service "${name}" is already registered`);
      }
      if (typeof service?.start !== "function") {
        throw new Error(
          `background service "${name}" must provide a start(signal) function`,
        );
      }
      services.push({ name, start: service.start.bind(service) });
    },
    schedule(name, cron, fn) {
      assertLive();
      if (typeof name !== "string" || !BACKGROUND_NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid schedule name ${JSON.stringify(name)} — use letters, digits, "-" and "_"`,
        );
      }
      if (schedules.some((record) => record.name === name)) {
        throw new Error(`schedule "${name}" is already registered`);
      }
      try {
        CronExpressionParser.parse(String(cron));
      } catch (error) {
        throw new Error(
          `invalid cron ${JSON.stringify(cron)} for schedule "${name}": ${errorMessage(error)}`,
        );
      }
      if (typeof fn !== "function") {
        throw new Error(`schedule "${name}" must provide a function`);
      }
      schedules.push({ name, cron: String(cron), fn });
    },
  };

  // --- cli ---
  const cliRecord: { registration: FakeCliRecord | null } = {
    registration: null,
  };
  const cli: PluginCli = {
    register(registration) {
      assertLive();
      if (cliRecord.registration !== null) {
        throw new Error("cli command is already registered");
      }
      const name = registration?.name;
      if (typeof name !== "string" || !CLI_COMMAND_NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid cli command name ${JSON.stringify(name)} — use lowercase letters, digits, and "-"`,
        );
      }
      if (
        typeof registration.summary !== "string" ||
        registration.summary.trim().length === 0
      ) {
        throw new Error(`cli command "${name}" must provide a summary`);
      }
      const commands = registration.commands ?? [];
      if (!Array.isArray(commands)) {
        throw new Error(`cli command "${name}" commands must be an array`);
      }
      const validatedCommands = commands.map((command, index) => {
        if (
          typeof command?.name !== "string" ||
          !CLI_COMMAND_NAME_PATTERN.test(command.name) ||
          typeof command.summary !== "string" ||
          typeof command.usage !== "string"
        ) {
          throw new Error(
            `cli command "${name}" commands[${index}] must be { name: [a-z0-9-]+, summary, usage }`,
          );
        }
        return {
          name: command.name,
          summary: command.summary,
          usage: command.usage,
        };
      });
      if (typeof registration.run !== "function") {
        throw new Error(
          `cli command "${name}" must provide a run(argv, ctx) function`,
        );
      }
      cliRecord.registration = {
        name,
        summary: registration.summary,
        commands: validatedCommands,
        run: registration.run.bind(registration),
      };
      const warning = pluginCliCollisionWarning(pluginId, name);
      if (warning) emitLog("warn", warning);
    },
  };

  // --- agents ---
  const agentTools: FakeAgentToolRecord[] = [];
  const providerRegistrations: NormalizedPluginProviderDeclaration[] = [];
  const providerEnvResolvers = new Map<
    string,
    (
      context: ExperimentalPluginProviderEnvContext,
    ) =>
      | readonly ExperimentalPluginProviderEnvEntry[]
      | Promise<readonly ExperimentalPluginProviderEnvEntry[]>
  >();
  const providerEnvHealthResolvers = new Map<
    string,
    (
      context: ExperimentalPluginProviderEnvHealthContext,
    ) =>
      | ExperimentalPluginProviderEnvHealth
      | null
      | Promise<ExperimentalPluginProviderEnvHealth | null>
  >();
  let agentConfigurationProvider:
    | ((context: PluginAgentConfigurationContext) => PluginAgentConfiguration)
    | null = null;
  let instructionProvider:
    | ((ctx: { threadId: string; projectId: string }) => string | null)
    | null = null;
  function registerProviderDeclaration(
    declaration: PluginProviderDeclaration,
  ): { dispose(): void } {
    assertLive();
    // The shared validator: the fake host must accept and reject provider
    // declarations exactly like production.
    const normalized = validatePluginProviderDeclaration(declaration);
    // The same refusals production makes at the register call, in its
    // order: the icon against the manifest's declared icons, then the
    // bridge the declaration runs on, then the id.
    const iconProblem =
      normalized.icon === undefined
        ? null
        : undeclaredIconProblem(pluginId, declaredIconNames, normalized.icon);
    if (iconProblem !== null) {
      throw new Error(providerIconRefusalMessage(normalized.id, iconProblem));
    }
    if (options.experimental_hostEntry === false) {
      throw new Error(providerWithoutBridgeMessage(normalized.id));
    }
    if (
      providerRegistrations.some((existing) => existing.id === normalized.id)
    ) {
      throw new Error(providerAlreadyRegisteredMessage(normalized.id));
    }
    providerRegistrations.push(normalized);
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      const index = providerRegistrations.indexOf(normalized);
      if (index !== -1) providerRegistrations.splice(index, 1);
    };
    disposeHooks.push(dispose);
    return { dispose };
  }

  const aiServiceRegistrations: PluginAiServiceDeclaration[] = [];
  const experimental_aiServices: PluginAiServices = {
    register(declaration) {
      assertLive();
      const normalized = validatePluginAiServiceDeclaration(declaration);
      // The same refusals production makes at the register call. The fake
      // host builds no artifact; the declared entry stands in for it.
      assertAiServiceRegistrable({
        id: normalized.id,
        hostArtifact:
          options.experimental_hostEntry === false ? null : "declared",
        hostArtifactProblem: null,
      });
      if (
        aiServiceRegistrations.some((existing) => existing.id === normalized.id)
      ) {
        throw new Error(aiServiceAlreadyRegisteredMessage(normalized.id));
      }
      aiServiceRegistrations.push(normalized);
      let disposed = false;
      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        const index = aiServiceRegistrations.indexOf(normalized);
        if (index !== -1) aiServiceRegistrations.splice(index, 1);
      };
      disposeHooks.push(dispose);
      return { dispose };
    },
  };

  const agents: PluginAgents = {
    configure(provider) {
      assertLive();
      if (agentConfigurationProvider !== null) {
        throw new Error("agent configuration is already registered");
      }
      if (typeof provider !== "function") {
        throw new Error(
          "configure requires a provider function (context) => ({ tools, skills, instructions? })",
        );
      }
      agentConfigurationProvider = provider;
    },
    contributeInstructions(provider) {
      assertLive();
      if (instructionProvider !== null) {
        throw new Error("agent instructions are already registered");
      }
      if (typeof provider !== "function") {
        throw new Error(
          "contributeInstructions requires a provider function (ctx) => string | null",
        );
      }
      instructionProvider = provider;
    },
    registerTool(tool: {
      name: string;
      description: string;
      instructions?: string;
      presentation?: PluginAgentToolPresentation;
      parameters: unknown;
      execute(
        params: never,
        ctx: PluginAgentToolContext,
      ): PluginAgentToolResult | Promise<PluginAgentToolResult>;
    }) {
      assertLive();
      const name = tool?.name;
      if (typeof name !== "string" || !AGENT_TOOL_NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid tool name ${JSON.stringify(name)} — use letters, digits, "-" and "_"`,
        );
      }
      if (RESERVED_AGENT_TOOL_NAMES.includes(name)) {
        throw new Error(
          `tool name "${name}" is a built-in bb tool — pick another name`,
        );
      }
      rejectStaleAgentToolFields(name, tool);
      if (
        typeof tool.description !== "string" ||
        tool.description.trim().length === 0
      ) {
        throw new Error(`tool "${name}" must provide a description`);
      }
      if (
        tool.instructions !== undefined &&
        typeof tool.instructions !== "string"
      ) {
        throw new Error(`tool "${name}" instructions must be a string`);
      }
      if (
        typeof tool.instructions === "string" &&
        tool.instructions.length > PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS
      ) {
        throw new Error(
          `tool "${name}" instructions exceed the ${PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS}-character limit`,
        );
      }
      const presentation = parsePluginAgentToolPresentation(
        name,
        tool.presentation,
      );
      if (presentation?.icon !== undefined) {
        // A namespaced glyph must name one of THIS plugin's declared icons,
        // checked here like production checks it at the register call.
        const problem = undeclaredIconProblem(
          pluginId,
          declaredIconNames,
          presentation.icon.glyph,
        );
        if (problem !== null) {
          throw new Error(agentToolIconRefusalMessage(name, problem));
        }
      }
      if (typeof tool.execute !== "function") {
        throw new Error(
          `tool "${name}" must provide an execute(params, ctx) function`,
        );
      }
      const parameters: unknown = tool.parameters;
      let inputSchema: unknown;
      let parse: FakeAgentToolRecord["parse"];
      if (isZodSchemaLike(parameters)) {
        try {
          inputSchema = zodSchemaToJsonSchema(parameters);
        } catch (error) {
          throw new Error(
            `tool "${name}" parameters look like a zod schema but could not be converted to JSON Schema (${errorMessage(error)}) — use zod 4, or pass a plain JSON-schema object`,
          );
        }
        parse = (input) => {
          const result = parameters.safeParse(input);
          if (result.success) return { ok: true, value: result.data };
          return { ok: false, error: summarizeParseIssues(result.error) };
        };
      } else if (
        typeof parameters === "object" &&
        parameters !== null &&
        !Array.isArray(parameters)
      ) {
        try {
          inputSchema = JSON.parse(JSON.stringify(parameters));
        } catch {
          throw new Error(
            `tool "${name}" parameters JSON schema is not JSON-serializable`,
          );
        }
        parse = (input) => ({ ok: true, value: input });
      } else {
        throw new Error(
          `tool "${name}" parameters must be a zod schema or a JSON-schema object`,
        );
      }
      assertNoRecursiveJsonSchemaReferences(
        inputSchema,
        `tool "${name}" parameters`,
      );
      const record: FakeAgentToolRecord = {
        name,
        description: tool.description,
        presentation,
        instructions:
          tool.instructions !== undefined && tool.instructions.trim().length > 0
            ? tool.instructions
            : null,
        inputSchema,
        parse,
        execute: (
          tool.execute as (
            params: unknown,
            ctx: PluginAgentToolContext,
          ) => PluginAgentToolResult | Promise<PluginAgentToolResult>
        ).bind(tool),
      };
      if (agentTools.some((existing) => existing.name === name)) {
        throw new Error(`tool "${name}" is already registered`);
      }
      agentTools.push(record);
    },
  };

  // --- ui ---
  const mentionProviders: FakeMentionProviderRecord[] = [];
  const ui: PluginUi = {
    requestInput,
    registerMentionProvider(provider) {
      assertLive();
      const id = provider?.id;
      if (typeof id !== "string" || !MENTION_PROVIDER_ID_PATTERN.test(id)) {
        throw new Error(
          `invalid mention provider id ${JSON.stringify(id)} — use letters, digits, "-" and "_"`,
        );
      }
      if (mentionProviders.some((record) => record.id === id)) {
        throw new Error(`mention provider "${id}" is already registered`);
      }
      if (
        typeof provider.label !== "string" ||
        provider.label.trim().length === 0
      ) {
        throw new Error(`mention provider "${id}" must provide a label`);
      }
      if (typeof provider.search !== "function") {
        throw new Error(
          `mention provider "${id}" must provide a search({ query, projectId, threadId }) function`,
        );
      }
      if (typeof provider.resolve !== "function") {
        throw new Error(
          `mention provider "${id}" must provide a resolve(itemId) function`,
        );
      }
      mentionProviders.push({
        id,
        label: provider.label.trim(),
        triggers: normalizeMentionProviderTriggers(id, provider.triggers),
        search: provider.search.bind(provider),
        resolve: provider.resolve.bind(provider),
      });
    },
  };

  // --- hooks ---
  /** How many times `bb.experimental_hooks.recheck()` was called. */
  let requestedDrains = 0;

  // --- status ---
  const needsConfigurationMessages: string[] = [];
  const status: PluginStatusApi = {
    needsConfiguration(message) {
      assertLive();
      needsConfigurationMessages.push(
        typeof message === "string" && message.length > 0
          ? message
          : "needs configuration",
      );
    },
  };

  // --- server ---
  const appUrl = options.appUrl ?? null;
  const loopbackBaseUrl = options.loopbackBaseUrl ?? "http://127.0.0.1:38886";
  const dataDir = options.dataDir ?? "/tmp/bb-fake-data-dir";
  const server: PluginServerApi = {
    get experimental_appUrl(): string | null {
      assertLive();
      return appUrl;
    },
    get loopbackBaseUrl(): string {
      assertLive();
      return loopbackBaseUrl;
    },
    get experimental_dataDir(): string {
      assertLive();
      return dataDir;
    },
  };

  // --- sdk ---
  const { sdk, harness: sdkHarness } = createFakeSdk({
    pluginId,
    overrides: options.sdk,
  });

  // --- thread events / dispose ---
  const threadEventHandlers: {
    [E in PluginThreadEventName]: Array<PluginThreadEventHandler<E>>;
  } = {
    "thread.created": [],
    "thread.active": [],
    "thread.idle": [],
    "thread.failed": [],
    "thread.archived": [],
    "thread.deleted": [],
    "interaction.pending": [],
    "message.queued": [],
    "message.dispatched": [],
    "turn.failed": [],
  };
  const hooks: {
    [K in PluginHookName]: PluginHookHandler<K> | null;
  } = {
    "message.dispatch": null,
  };
  const disposeHooks: Array<() => void | Promise<void>> = [];
  const serviceControllers: AbortController[] = [];
  let nextInteractionId = 1;
  const pendingInteractions = new Map<
    string,
    {
      request: PluginInteractionRequest;
      resolve: (result: PluginInteractionResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function requestInput(
    request: Parameters<PluginUi["requestInput"]>[0],
    requestOptions?: Parameters<PluginUi["requestInput"]>[1],
  ) {
    assertLive();
    if (!request || typeof request !== "object") {
      throw new Error("ui.requestInput requires an options object");
    }
    if (typeof request.threadId !== "string" || request.threadId.length === 0) {
      throw new Error("ui.requestInput threadId must be a non-empty string");
    }
    if (
      typeof request.rendererId !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(request.rendererId)
    ) {
      throw new Error(
        "ui.requestInput rendererId must use letters, digits, '-' or '_'",
      );
    }
    if (
      typeof request.title !== "string" ||
      request.title.trim().length === 0 ||
      request.title.trim().length > PLUGIN_INTERACTION_MAX_TITLE_LENGTH
    ) {
      throw new Error(
        `ui.requestInput title must be 1-${PLUGIN_INTERACTION_MAX_TITLE_LENGTH} characters`,
      );
    }
    let payload: JsonValue;
    try {
      const json = JSON.stringify(request.payload);
      if (json === undefined) throw new Error();
      if (Buffer.byteLength(json, "utf8") > 64 * 1024) {
        throw new Error("ui.requestInput payload exceeds 64 KiB");
      }
      payload = JSON.parse(json) as JsonValue;
    } catch (error) {
      if (error instanceof Error && error.message.includes("64 KiB")) {
        throw error;
      }
      throw new Error("ui.requestInput payload must be JSON-serializable");
    }
    const timeoutMs = request.timeoutMs ?? 10 * 60 * 1000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 60 * 60 * 1000
    ) {
      throw new Error(
        "ui.requestInput timeoutMs must be between 1 and 3600000",
      );
    }
    const normalizedRequest: PluginInteractionRequest = {
      ...request,
      title: request.title.trim(),
      payload,
      timeoutMs,
    };
    const id = `fake-interaction-${nextInteractionId++}`;
    return new Promise<PluginInteractionResult>((resolve) => {
      const settleAborted = () => {
        const pending = pendingInteractions.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingInteractions.delete(id);
        resolve({ outcome: "cancelled", reason: "request-aborted" });
      };
      requestOptions?.signal?.addEventListener("abort", settleAborted, {
        once: true,
      });
      const timer = setTimeout(() => {
        pendingInteractions.delete(id);
        resolve({ outcome: "cancelled", reason: "timeout" });
      }, timeoutMs);
      pendingInteractions.set(id, {
        request: normalizedRequest,
        resolve,
        timer,
      });
    });
  }

  const sharedPortDeclarations: FakePluginHarness["sharedPortDeclarations"] =
    [];
  const hostRpcCalls: ExperimentalFakeHostRpcCall[] = [];
  const hostWorkerExitSubscriptions: FakeHostWorkerExitSubscription[] = [];
  const hostSignalSubscriptions: FakeHostSignalSubscription[] = [];
  const hosts: PluginHosts = {
    experimental_client({ contract, experimental_signals }) {
      return {
        async call(method, input, callOptions) {
          assertLive();
          const methodContract = contract[method];
          if (methodContract === undefined) {
            throw new Error(`unknown host rpc method "${String(method)}"`);
          }
          if (
            typeof callOptions !== "object" ||
            callOptions === null ||
            typeof callOptions.hostId !== "string" ||
            callOptions.hostId.length === 0
          ) {
            throw new Error(
              `host rpc method "${String(method)}" requires a host id`,
            );
          }
          if (callOptions.signal?.aborted) {
            throw Object.assign(new Error("Host plugin call was cancelled"), {
              name: "AbortError",
            });
          }
          const validatedInput = normalizeRpcJsonResult(
            await validateRpcValue(methodContract.input, input, "input"),
          );
          const call: ExperimentalFakeHostRpcCall = {
            method: String(method),
            input: validatedInput,
            hostId: callOptions.hostId,
            ...(callOptions.signal === undefined
              ? {}
              : { signal: callOptions.signal }),
          };
          hostRpcCalls.push(call);
          if (options.experimental_callHostRpc === undefined) {
            throw new Error(
              `fake plugin host has no experimental_callHostRpc stub for "${String(method)}"`,
            );
          }
          const rawOutput = await options.experimental_callHostRpc(call);
          const validatedOutput = await validateRpcValue(
            methodContract.output,
            rawOutput,
            "output",
          );
          return normalizeRpcJsonResult(validatedOutput) as never;
        },
        experimental_onWorkerExit(handler) {
          assertLive();
          if (typeof handler !== "function") {
            throw new Error("host worker exit subscription requires a handler");
          }
          hostWorkerExitSubscriptions.push(handler);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostWorkerExitSubscriptions.indexOf(handler);
            if (index >= 0) hostWorkerExitSubscriptions.splice(index, 1);
          };
        },
        experimental_onSignal(signal, handler) {
          assertLive();
          const descriptor = experimental_signals?.[signal];
          if (
            typeof signal !== "string" ||
            signal.length === 0 ||
            typeof descriptor !== "object" ||
            descriptor === null ||
            !isStandardSchema(descriptor.payload)
          ) {
            throw new Error(`unknown host signal "${String(signal)}"`);
          }
          if (typeof handler !== "function") {
            throw new Error("host signal subscription requires a handler");
          }
          const record: FakeHostSignalSubscription = {
            signal,
            payloadSchema: descriptor.payload,
            handler,
          };
          hostSignalSubscriptions.push(record);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostSignalSubscriptions.indexOf(record);
            if (index >= 0) hostSignalSubscriptions.splice(index, 1);
          };
        },
      };
    },
    async ensureSharedPortTunnel(hostId) {
      assertLive();
      if (hostId.trim().length === 0) {
        throw new Error("shared-port hostId must be non-empty");
      }
      const identity = options.sharedPortTunnelIdentities?.[hostId];
      if (!identity) {
        throw new Error(`host ${hostId} has no shared-port tunnel identity`);
      }
      return { ...identity };
    },
    declareSharedPorts(hostId, ports) {
      assertLive();
      if (hostId.trim().length === 0) {
        throw new Error("shared-port hostId must be non-empty");
      }
      const normalizedPorts = [...new Set(ports)].sort((a, b) => a - b);
      for (const port of normalizedPorts) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(
            `shared port ${String(port)} must be an integer between 1 and 65535`,
          );
        }
      }
      const replacement = {
        hostId,
        ports: normalizedPorts,
      };
      const existingIndex = sharedPortDeclarations.findIndex(
        (declaration) => declaration.hostId === hostId,
      );
      if (existingIndex === -1) {
        sharedPortDeclarations.push(replacement);
      } else {
        sharedPortDeclarations[existingIndex] = replacement;
      }
    },
  };
  disposeHooks.push(() => {
    sharedPortDeclarations.length = 0;
  });

  const events: PluginEvents = {
    on(event, handler) {
      assertLive();
      const handlers = threadEventHandlers[event];
      if (handlers === undefined) {
        throw new Error(
          `unknown event "${String(event)}" — supported events: ${Object.keys(
            threadEventHandlers,
          ).join(", ")}`,
        );
      }
      handlers.push(handler);
    },
  };

  const providers: PluginProviders = {
    register(declaration) {
      return registerProviderDeclaration(declaration);
    },
    experimental_contributeEnv(providerId, resolve) {
      assertLive();
      if (typeof providerId !== "string" || providerId.trim().length === 0) {
        throw new Error(
          "provider environment contribution requires a provider id",
        );
      }
      if (providerEnvResolvers.has(providerId)) {
        throw new Error(
          `provider environment contribution for "${providerId}" is already registered`,
        );
      }
      if (typeof resolve !== "function") {
        throw new Error(
          "provider environment contribution requires a resolver function",
        );
      }
      providerEnvResolvers.set(providerId, resolve);
    },
    experimental_contributeEnvHealth(providerId, resolve) {
      assertLive();
      if (typeof providerId !== "string" || providerId.trim().length === 0) {
        throw new Error(
          "provider environment health contribution requires a provider id",
        );
      }
      if (providerEnvHealthResolvers.has(providerId)) {
        throw new Error(
          `provider environment health contribution for "${providerId}" is already registered`,
        );
      }
      if (typeof resolve !== "function") {
        throw new Error(
          "provider environment health contribution requires a resolver function",
        );
      }
      providerEnvHealthResolvers.set(providerId, resolve);
    },
  };

  const experimental_hooks: PluginHooks = {
    on(hook, handler) {
      if (hooks[hook] !== null) {
        throw new Error(pluginHookAlreadyRegisteredMessage(hook));
      }
      storePluginHook(hooks, hook, handler);
    },
    async recheck(_hook) {
      assertLive();
      // The real host schedules a background walk and resolves; there is no
      // queue here to walk, so the fake records the ask. Asserting on the
      // count is how a test pins the wake path — the condition the plugin
      // watches changed, so it told core to re-ask.
      requestedDrains += 1;
    },
  };

  const bb: BbPluginApi = {
    pluginId,
    log,
    settings,
    storage,
    http,
    rpc,
    realtime,
    background,
    cli,
    agents,
    providers,
    ui,
    events,
    experimental_hooks,
    status,
    server,
    hosts,
    experimental_aiServices,
    get sdk() {
      assertLive();
      return sdk;
    },
    onDispose(hook) {
      assertLive();
      disposeHooks.push(hook);
    },
  };

  async function disposeHost(cleanupStorage: boolean): Promise<void> {
    if (disposed) return;
    disposed = true;
    for (const [id, pending] of pendingInteractions) {
      clearTimeout(pending.timer);
      pendingInteractions.delete(id);
      pending.resolve({ outcome: "cancelled", reason: "plugin-disposed" });
    }
    for (const session of [...websocketSessions]) {
      await session.closeForReload();
    }
    // Host order (§3): services first, then hooks LIFO (isolated), then
    // vended database handles, then handle invalidation.
    for (const controller of serviceControllers) controller.abort();
    for (const hook of [...disposeHooks].reverse()) {
      try {
        await hook();
      } catch (error) {
        emitLog("warn", `dispose hook failed: ${errorMessage(error)}`);
      }
    }
    if (databaseHandle) {
      try {
        databaseHandle.close();
      } catch (error) {
        emitLog("warn", `database close failed: ${errorMessage(error)}`);
      }
    }
    if (cleanupStorage) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
    hostWorkerExitSubscriptions.splice(0);
    hostSignalSubscriptions.splice(0);
    invalidated = true;
  }

  const harness: FakePluginHarness = {
    get behavior() {
      return this;
    },
    get inspection() {
      return this;
    },
    get lifecycle() {
      return this;
    },
    pluginId,
    logEntries,
    realtimeSignals,
    needsConfigurationMessages,
    get recheckCount() {
      return requestedDrains;
    },
    sharedPortDeclarations,
    experimental_hostRpcCalls: hostRpcCalls,
    sdk: sdkHarness,
    registrations: {
      settingsDescriptors,
      httpRoutes,
      websocketRoutes,
      get rpcMethods() {
        return [...rpcHandlers.keys()];
      },
      services,
      schedules,
      get cli() {
        return cliRecord.registration;
      },
      agentTools,
      get agentConfigurationProvider() {
        return agentConfigurationProvider;
      },
      get instructionProvider() {
        return instructionProvider;
      },
      get threadEventHandlers() {
        return {
          "thread.created": threadEventHandlers["thread.created"].length,
          "thread.active": threadEventHandlers["thread.active"].length,
          "thread.idle": threadEventHandlers["thread.idle"].length,
          "thread.failed": threadEventHandlers["thread.failed"].length,
          "thread.archived": threadEventHandlers["thread.archived"].length,
          "thread.deleted": threadEventHandlers["thread.deleted"].length,
          "interaction.pending":
            threadEventHandlers["interaction.pending"].length,
          "message.queued": threadEventHandlers["message.queued"].length,
          "message.dispatched":
            threadEventHandlers["message.dispatched"].length,
          "turn.failed": threadEventHandlers["turn.failed"].length,
        };
      },
      get hooks() {
        return { ...hooks };
      },
      mentionProviders,
      providerRegistrations,
      providerEnvResolvers,
      providerEnvHealthResolvers,
      aiServiceRegistrations,
    },
    get pendingInteractions() {
      return [...pendingInteractions].map(([id, pending]) => ({
        id,
        ...pending.request,
      }));
    },
    async experimental_emitHostWorkerExit(hostId) {
      assertLive();
      if (hostId.trim().length === 0) {
        throw new Error("host worker exit hostId must be non-empty");
      }
      for (const handler of [...hostWorkerExitSubscriptions]) {
        await handler({ hostId });
      }
    },
    async resolveProviderEnv(providerId, context) {
      assertLive();
      const resolve = providerEnvResolvers.get(providerId);
      if (resolve === undefined) return [];
      try {
        return validatePluginProviderEnvEntries(await resolve(context));
      } catch (error) {
        emitLog(
          "warn",
          `provider environment contribution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    },
    async resolveProviderEnvHealth(providerId, context) {
      assertLive();
      if (!providerEnvResolvers.has(providerId)) return null;
      const resolve = providerEnvHealthResolvers.get(providerId);
      if (resolve === undefined) return null;
      try {
        const value = await resolve(context);
        if (value === null) return null;
        if (value.label.trim().length === 0) {
          throw new Error("label must not be empty");
        }
        if (value.statusMessage.trim().length === 0) {
          throw new Error("statusMessage must not be empty");
        }
        return value;
      } catch (error) {
        emitLog(
          "warn",
          `provider environment health contribution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    },
    async experimental_emitHostSignal(hostId, signal, payload) {
      assertLive();
      if (hostId.trim().length === 0) {
        throw new Error("host signal hostId must be non-empty");
      }
      const subscriptions = hostSignalSubscriptions.filter(
        (subscription) => subscription.signal === signal,
      );
      for (const subscription of subscriptions) {
        const normalized = normalizeRpcJsonResult(
          await validateRpcValue(subscription.payloadSchema, payload, "input"),
        );
        const parsed = await validateRpcValue(
          subscription.payloadSchema,
          normalized,
          "input",
        );
        await subscription.handler({ hostId, payload: parsed });
      }
    },
    submitInteraction(id, value) {
      const pending = pendingInteractions.get(id);
      if (!pending) throw new Error(`no pending interaction "${id}"`);
      clearTimeout(pending.timer);
      pendingInteractions.delete(id);
      pending.resolve({ outcome: "submitted", value });
    },
    cancelInteraction(id) {
      const pending = pendingInteractions.get(id);
      if (!pending) throw new Error(`no pending interaction "${id}"`);
      clearTimeout(pending.timer);
      pendingInteractions.delete(id);
      pending.resolve({ outcome: "cancelled", reason: "user" });
    },

    async setSettings(values) {
      await setSettingsValues(values);
    },

    async callRpc(method, input) {
      const record = rpcHandlers.get(method);
      if (!record) {
        return throwRpcError({
          code: "unknown_method",
          message: `plugin "${pluginId}" has no rpc method "${method}"`,
        });
      }
      const parsedInput =
        input === undefined
          ? null
          : jsonRoundTrip(input, `rpc "${method}" input`);
      const validatedInput = await validateRpcValue(
        record.inputSchema,
        parsedInput,
        "input",
      );
      let result: unknown;
      try {
        result = await record.handler(validatedInput as never);
      } catch (error) {
        return throwRpcError({
          code: "handler_error",
          message: errorMessage(error),
        });
      }
      const validatedOutput = await validateRpcValue(
        record.outputSchema,
        result,
        "output",
      );
      return normalizeRpcJsonResult(validatedOutput);
    },

    async runCli(argv, ctx = {}) {
      const registration = cliRecord.registration;
      if (!registration) {
        throw new Error(`plugin "${pluginId}" registers no CLI command`);
      }
      try {
        const result = await registration.run(argv, ctx);
        if (typeof result?.exitCode !== "number") {
          throw new Error(
            "cli run() must return { exitCode: number, stdout?, stderr? }",
          );
        }
        return enforcePluginCliOutputLimit(
          {
            exitCode: result.exitCode,
            stdout: typeof result.stdout === "string" ? result.stdout : "",
            stderr: typeof result.stderr === "string" ? result.stderr : "",
          },
          argv.includes("--json"),
        );
      } catch (error) {
        return enforcePluginCliOutputLimit(
          {
            exitCode: 1,
            stdout: "",
            stderr: `bb ${registration.name} failed: ${errorMessage(error)}`,
          },
          argv.includes("--json"),
        );
      }
    },

    async fetchHttp(method, path, init) {
      const normalizedMethod = String(method).toUpperCase();
      const pathname = new URL(path, "http://plugin.test").pathname;
      const route = httpRoutes.find(
        (candidate) =>
          candidate.method === normalizedMethod && candidate.path === pathname,
      );
      if (!route) {
        throw new Error(
          `no http route ${normalizedMethod} ${pathname} is registered — ` +
            `registered: ${
              httpRoutes.map((r) => `${r.method} ${r.path}`).join(", ") ||
              "(none)"
            }`,
        );
      }
      const app = new Hono();
      app.on(route.method, route.path, async (context) => {
        try {
          return adoptHttpRouteResponse(await route.handler(context));
        } catch (error) {
          const message = errorMessage(error);
          emitLog(
            "warn",
            `http ${route.method} ${route.path} failed: ${message}`,
          );
          return context.json(
            { ok: false, error: `plugin route failed: ${message}` },
            500,
          );
        }
      });
      return app.request(path, { ...init, method: normalizedMethod });
    },

    async experimental_openWebSocket(path, init) {
      assertLive();
      const url = new URL(path, "http://plugin.test");
      const route = websocketRoutes.find(
        (candidate) => candidate.path === url.pathname,
      );
      if (!route) {
        throw new Error(
          `no websocket route ${url.pathname} is registered — registered: ${
            websocketRoutes.map((candidate) => candidate.path).join(", ") ||
            "(none)"
          }`,
        );
      }
      const request = new Request(url, { ...init, method: "GET" });
      let handlers: ExperimentalPluginWebSocketHandlers;
      try {
        handlers = route.handler({
          request,
          url,
          headers: request.headers,
        });
        if (
          typeof handlers !== "object" ||
          handlers === null ||
          Array.isArray(handlers)
        ) {
          throw new Error("websocket route handler must return an object");
        }
        for (const name of [
          "onOpen",
          "onMessage",
          "onClose",
          "onError",
        ] as const) {
          const callback = handlers[name];
          if (callback !== undefined && typeof callback !== "function") {
            throw new Error(
              `websocket route handler ${name} must be a function`,
            );
          }
        }
      } catch (error) {
        emitLog(
          "warn",
          `websocket ${route.path} connect failed: ${errorMessage(error)}`,
        );
        throw error;
      }

      const sent: Array<string | Uint8Array> = [];
      const closeCalls: Array<{
        code: number | null;
        reason: string | null;
      }> = [];
      let readyState = 0;
      let closeNotified = false;
      let eventQueue = Promise.resolve();
      const invoke = async (
        event: "open" | "message" | "close" | "error",
        run: () => void | Promise<void>,
      ): Promise<void> => {
        eventQueue = eventQueue.then(async () => {
          try {
            await run();
          } catch (error) {
            emitLog(
              "warn",
              `websocket ${route.path} ${event} failed: ${errorMessage(error)}`,
            );
          }
        });
        await eventQueue;
      };
      const socket: ExperimentalPluginWebSocket = {
        send(data) {
          sent.push(typeof data === "string" ? data : new Uint8Array(data));
        },
        close(code, reason) {
          closeCalls.push({ code: code ?? null, reason: reason ?? null });
          if (readyState < 2) readyState = 2;
        },
        get readyState() {
          return readyState;
        },
      };
      const notifyClose = async (
        code: number,
        reason: string,
      ): Promise<void> => {
        if (closeNotified) return;
        closeNotified = true;
        readyState = 3;
        websocketSessions.delete(session);
        if (handlers.onClose !== undefined) {
          await invoke("close", () =>
            handlers.onClose?.(socket, { code, reason }),
          );
        }
      };
      const session: ExperimentalFakeWebSocketSession & {
        closeForReload(): Promise<void>;
      } = {
        sent,
        closeCalls,
        get readyState() {
          return readyState;
        },
        async receive(data) {
          if (readyState !== 1) {
            throw new Error(
              "cannot receive a websocket message while not open",
            );
          }
          if (handlers.onMessage !== undefined) {
            await invoke("message", () => handlers.onMessage?.(socket, data));
          }
        },
        async close(code = 1000, reason = "") {
          if (readyState < 2) socket.close(code, reason);
          await notifyClose(code, reason);
        },
        async error(error) {
          if (handlers.onError !== undefined) {
            await invoke("error", () => handlers.onError?.(socket, error));
          }
        },
        async closeForReload() {
          socket.close(1012, "Plugin reloaded or disabled");
          await notifyClose(1012, "Plugin reloaded or disabled");
        },
      };
      websocketSessions.add(session);
      readyState = 1;
      if (handlers.onOpen !== undefined) {
        await invoke("open", () => handlers.onOpen?.(socket));
      }
      return session;
    },

    runService(name) {
      const service = services.find((record) => record.name === name);
      if (!service) {
        throw new Error(`no background service "${name}" is registered`);
      }
      const controller = new AbortController();
      serviceControllers.push(controller);
      // start() runs synchronously (like the host's post-factory start), so
      // it observes an abort() issued right after runService returns.
      let started: Promise<void>;
      try {
        started = Promise.resolve(service.start(controller.signal)).then(
          () => undefined,
        );
      } catch (error) {
        started = Promise.reject(error);
      }
      const done = started.catch((error: unknown) => {
        if (isNeedsConfigurationError(error)) {
          needsConfigurationMessages.push(error.message);
          return undefined;
        }
        throw error;
      });
      return { controller, done };
    },

    async runSchedule(name) {
      const schedule = schedules.find((record) => record.name === name);
      if (!schedule) {
        throw new Error(`no schedule "${name}" is registered`);
      }
      await schedule.fn();
    },

    async emitThreadEvent(event, payload) {
      const errors: unknown[] = [];
      for (const handler of [...threadEventHandlers[event]]) {
        try {
          await handler(payload);
        } catch (error) {
          errors.push(error);
          emitLog("warn", `${event} handler failed: ${errorMessage(error)}`);
        }
      }
      return { errors };
    },

    async callAgentTool(name, input, ctx) {
      const record = agentTools.find((tool) => tool.name === name);
      if (!record) {
        throw new Error(`no agent tool "${name}" is registered`);
      }
      const parsed = record.parse(input);
      if (!parsed.ok) {
        throw new Error(
          `tool "${name}" arguments are invalid: ${parsed.error}`,
        );
      }
      return record.execute(parsed.value, {
        threadId: ctx?.threadId ?? "thread-test",
        projectId: ctx?.projectId ?? "project-test",
        signal: ctx?.signal ?? new AbortController().signal,
      });
    },

    async resolveAgentConfiguration(context) {
      if (agentConfigurationProvider === null) {
        return {
          tools: [...agentTools],
          skills: [...agentSkillIds],
          instructions: null,
        };
      }
      try {
        const normalized = normalizeAgentConfiguration({
          knownSkillIds: new Set(agentSkillIds),
          knownToolIds: new Set(agentTools.map((tool) => tool.name)),
          pluginId,
          value: agentConfigurationProvider(context),
        });
        const selectedTools = new Set(normalized.toolIds);
        return {
          tools: agentTools
            .filter((tool) => selectedTools.has(tool.name))
            .map((tool) => {
              const parameters = normalized.toolParameterOverrides.get(
                tool.name,
              );
              return parameters === undefined
                ? tool
                : { ...tool, inputSchema: parameters };
            }),
          skills: normalized.skillIds,
          instructions: normalized.instructions,
        };
      } catch (error) {
        emitLog("warn", `agent configure failed: ${errorMessage(error)}`);
        return { tools: [], skills: [], instructions: null };
      }
    },

    async reload(factory) {
      assertLive();
      const replacement = createFakePluginHostInternal(
        options,
        persistentState,
      );
      try {
        await factory(replacement.bb);
      } catch (error) {
        await fakeHostDisposers.get(replacement.harness)?.(false);
        throw error;
      }
      await disposeHost(false);
      return replacement;
    },

    async dispose() {
      await disposeHost(true);
    },
  };

  fakeHostDisposers.set(harness, disposeHost);
  return { bb, harness };
}
