import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
import {
  deletePluginKvValue,
  getPluginKvValue,
  listPluginKvKeys,
  setPluginKvValue,
  type DbConnection,
} from "@bb/db";
import {
  PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
  PLUGIN_INTERACTION_MAX_TITLE_LENGTH,
  type JsonValue,
} from "@bb/domain";
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
  PluginCliResult,
  PluginHooks,
  PluginHookHandler,
  PluginHookName,
  PluginEvents,
  PluginHttp,
  PluginHttpAuthMode,
  PluginHttpHandler,
  PluginHosts,
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
  PluginUi,
  StandardSchemaV1,
  PluginRpcContract,
} from "@get-bb/plugin-sdk";
import {
  AGENT_TOOL_NAME_PATTERN,
  assertNoRecursiveJsonSchemaReferences,
  BACKGROUND_NAME_PATTERN,
  CLI_COMMAND_NAME_PATTERN,
  isZodSchemaLike,
  KV_VALUE_MAX_BYTES,
  MENTION_PROVIDER_ID_PATTERN,
  normalizeMentionProviderTriggers,
  PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS,
  PLUGIN_HTTP_METHODS,
  parsePluginAgentToolPresentation,
  pluginCliCollisionWarning,
  readRpcMethodContract,
  registerSettingDescriptors,
  rejectStaleAgentToolFields,
  RESERVED_AGENT_TOOL_NAMES,
  RPC_METHOD_PATTERN,
  isStandardSchema,
  summarizeParseIssues,
  agentToolIconRefusalMessage,
  aiServiceAlreadyRegisteredMessage,
  pluginHookAlreadyRegisteredMessage,
  storePluginHook,
  providerAlreadyRegisteredMessage,
  providerIconRefusalMessage,
  undeclaredIconProblem,
  validateSettingsUpdate,
  validatePluginAiServiceDeclaration,
  validatePluginProviderDeclaration,
  zodSchemaToJsonSchema,
} from "@get-bb/plugin-sdk/internal/host-policy";
import type {
  AiServiceHostBinding,
  NormalizedPluginProviderDeclaration,
} from "@get-bb/plugin-sdk/internal/host-policy";
import type { BbSdk, ThreadForkArgs, ThreadSpawnArgs } from "@bb/sdk";
import type { ServerLogger } from "../../types.js";
import type { PluginInteractionResult } from "../interactions/pending-interactions.js";
import { appendPluginLogLine } from "./plugin-log.js";
import type { PluginHostArtifactSnapshot } from "./plugin-service-internal.js";
import {
  readPluginSettingsValues,
  writePluginSettingsUpdate,
} from "./plugin-settings.js";

const LEGACY_UNKNOWN_MIGRATION_HASH = "legacy-unknown";

function migrationStatementHash(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}

export type {
  BbPluginApi,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginCliCommandInfo,
  PluginCliContext,
  PluginMentionTrigger,
  PluginThreadEventName,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";

class PluginContextStaleError extends Error {
  constructor(pluginId: string) {
    super(
      `plugin "${pluginId}" used a stale API handle — it was reloaded or disabled; ` +
        `re-entry happens via a fresh factory call`,
    );
    this.name = "PluginContextStaleError";
  }
}

export function isNeedsConfigurationError(error: unknown): error is Error {
  return error instanceof Error && error.name === "NeedsConfigurationError";
}

/**
 * The handler this plugin registered per hook, or null where it registered
 * none. A mapped type over the hook-name union rather than a loose map: a hook
 * added to the contract without an entry here fails to compile, which is what
 * keeps the registry and the contract from drifting.
 */
export type PluginHookRecords = {
  [K in PluginHookName]: PluginHookHandler<K> | null;
};

/** Per-event handler lists recorded by `bb.events.on`; dropped with the handle. */
type PluginThreadEventHandlers = {
  [E in PluginThreadEventName]: Array<PluginThreadEventHandler<E>>;
};

export interface PluginHttpRouteRecord {
  method: string;
  path: string;
  auth: PluginHttpAuthMode;
  handler: PluginHttpHandler;
}

export interface PluginWebSocketRouteRecord {
  path: string;
  auth: PluginHttpAuthMode;
  handler: ExperimentalPluginWebSocketHandler;
  active: boolean;
  sockets: Set<ExperimentalPluginWebSocket>;
}

export interface PluginRpcHandler {
  inputSchema: StandardSchemaV1;
  outputSchema: StandardSchemaV1;
  handler: (input: never) => unknown;
}

export interface PluginAgentToolRecord {
  name: string;
  description: string;
  presentation: PluginAgentToolPresentation | null;
  instructions: string | null;
  inputSchema: unknown;
  parse(
    input: unknown,
  ): { ok: true; value: unknown } | { ok: false; error: string };
  execute(
    params: unknown,
    ctx: PluginAgentToolContext,
  ): PluginAgentToolResult | Promise<PluginAgentToolResult>;
}

export { RESERVED_AGENT_TOOL_NAMES };

interface PluginMentionProviderRecord {
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

export interface PluginBackgroundServiceRecord {
  name: string;
  start: (signal: AbortSignal) => void | Promise<void>;
}

interface PluginScheduleRecord {
  name: string;
  cron: string;
  fn: () => void | Promise<void>;
}

interface PluginCliRegistrationRecord {
  name: string;
  summary: string;
  commands: PluginCliCommandInfo[];
  run: (
    argv: string[],
    ctx: PluginCliContext,
  ) => PluginCliResult | Promise<PluginCliResult>;
}

type PluginSettingsListener = (
  next: Record<string, PluginSettingValue | undefined>,
  prev: Record<string, PluginSettingValue | undefined>,
) => void;

export interface PluginApiHandle {
  api: BbPluginApi;
  disposeHooks: Array<() => void | Promise<void>>;
  settings: {
    descriptors: PluginSettingDescriptors;
    listeners: PluginSettingsListener[];
  };
  databaseHandles: Database.Database[];
  threadEventHandlers: PluginThreadEventHandlers;
  /** Hook handlers recorded by `bb.experimental_hooks.on`. */
  hooks: PluginHookRecords;
  /** HTTP routes recorded by `bb.http.route`; dropped with the handle. */
  httpRoutes: PluginHttpRouteRecord[];
  websocketRoutes: PluginWebSocketRouteRecord[];
  rpcHandlers: Map<string, PluginRpcHandler>;
  hostWorkerExitHandlers: PluginHostWorkerExitHandler[];
  hostSignalHandlers: PluginHostSignalHandler[];
  backgroundServices: PluginBackgroundServiceRecord[];
  schedules: PluginScheduleRecord[];
  cli: { registration: PluginCliRegistrationRecord | null };
  agentTools: PluginAgentToolRecord[];
  listProviderDeclarations(): NormalizedPluginProviderDeclaration[];
  providerEnvResolvers: ReadonlyMap<string, PluginProviderEnvResolver>;
  providerEnvHealthResolvers: ReadonlyMap<
    string,
    PluginProviderEnvHealthResolver
  >;
  agentConfigurationProvider: PluginAgentConfigurationProvider | null;
  instructionProvider: PluginInstructionProvider | null;
  mentionProviders: PluginMentionProviderRecord[];
  activate(): void;
  closeWebSockets(): void;
  invalidate(): void;
}

type PluginHostWorkerExitHandler = (event: {
  hostId: string;
}) => void | Promise<void>;

interface PluginHostSignalHandler {
  signal: string;
  payloadSchema: StandardSchemaV1;
  handler: (event: {
    hostId: string;
    payload: unknown;
  }) => void | Promise<void>;
}

type PluginInstructionProvider = (ctx: {
  threadId: string;
  projectId: string;
}) => string | null;

type PluginAgentConfigurationProvider = (
  context: PluginAgentConfigurationContext,
) => PluginAgentConfiguration;

export type PluginProviderEnvResolver = (
  context: ExperimentalPluginProviderEnvContext,
) =>
  | readonly ExperimentalPluginProviderEnvEntry[]
  | Promise<readonly ExperimentalPluginProviderEnvEntry[]>;

export type PluginProviderEnvHealthResolver = (
  context: ExperimentalPluginProviderEnvHealthContext,
) =>
  | ExperimentalPluginProviderEnvHealth
  | null
  | Promise<ExperimentalPluginProviderEnvHealth | null>;

function wrapSdkForPlugin(sdk: BbSdk, pluginId: string): BbSdk {
  return {
    ...sdk,
    threads: {
      ...sdk.threads,
      fork(args: ThreadForkArgs) {
        const origin = args.origin ?? "plugin";
        return sdk.threads.fork({
          ...args,
          origin,
          ...(origin === "plugin"
            ? { originPluginId: args.originPluginId ?? pluginId }
            : {}),
        });
      },
      spawn(args: ThreadSpawnArgs) {
        const origin = args.origin ?? "plugin";
        return sdk.threads.spawn({
          ...args,
          origin,
          ...(origin === "plugin"
            ? { originPluginId: args.originPluginId ?? pluginId }
            : {}),
        });
      },
    },
  };
}

function createStagedRegistrations<
  TDeclaration,
  TNormalized extends { id: string },
  TBinding,
>(options: {
  validate: (declaration: TDeclaration) => TNormalized;
  bind: (id: string) => TBinding;
  isTaken: (id: string) => boolean;
  registerLive: (
    declaration: TNormalized,
    binding: TBinding,
  ) => { dispose(): void };
  alreadyRegisteredMessage: (id: string) => string;
  assertLive: () => void;
  isActivated: () => boolean;
  disposeHooks: Array<() => void | Promise<void>>;
}): {
  register(declaration: TDeclaration): { dispose(): void };
  flush(): void;
  values(): TNormalized[];
} {
  const entries = new Map<
    string,
    {
      declaration: TNormalized;
      binding: TBinding;
      disposer: { dispose(): void } | null;
      disposed: boolean;
    }
  >();
  return {
    register(declaration) {
      options.assertLive();
      const normalized = options.validate(declaration);
      const binding = options.bind(normalized.id);
      if (entries.has(normalized.id)) {
        throw new Error(options.alreadyRegisteredMessage(normalized.id));
      }
      const entry = {
        declaration: normalized,
        binding,
        disposer: null as { dispose(): void } | null,
        disposed: false,
      };
      if (options.isActivated()) {
        entry.disposer = options.registerLive(normalized, binding);
      } else if (options.isTaken(normalized.id)) {
        throw new Error(options.alreadyRegisteredMessage(normalized.id));
      }
      entries.set(normalized.id, entry);
      const dispose = (): void => {
        if (entry.disposed) return;
        entry.disposed = true;
        entry.disposer?.dispose();
        if (entries.get(normalized.id) === entry) {
          entries.delete(normalized.id);
        }
      };
      options.disposeHooks.push(dispose);
      return { dispose };
    },
    flush() {
      for (const entry of entries.values()) {
        if (!entry.disposed && entry.disposer === null) {
          entry.disposer = options.registerLive(
            entry.declaration,
            entry.binding,
          );
        }
      }
    },
    values() {
      return [...entries.values()].map((entry) => entry.declaration);
    },
  };
}

export function createPluginApi(options: {
  pluginId: string;
  logger: ServerLogger;
  db: DbConnection;
  dataDir: string;
  getSdk: () => BbSdk | undefined;
  getAppUrl: () => string | null;
  getLoopbackBaseUrl: () => string | undefined;
  publishSignal: (channel: string, payload: unknown) => void;
  settingsChanged: () => void;
  reportNeedsConfiguration: (message: string) => void;
  isAgentToolNameTaken: (name: string) => string | undefined;
  reportAgentToolProblem: (message: string) => void;
  /**
   * Schedules a re-attempt of every plugin-queued row
   * (`bb.experimental_hooks.recheck`). Coalescing, pacing and the walk
   * itself belong to the queue; this only asks for it.
   */
  requestQueueDrain: () => void;
  /**
   * The names this plugin's manifest declares under
   * `bb.branding.experimental_icons`: what a namespaced glyph
   * (`"<pluginId>/<name>"`) in a tool presentation or a provider icon must
   * name. Empty when the manifest declares none.
   */
  declaredIconNames: ReadonlySet<string>;
  requestInteraction: (args: {
    threadId: string;
    rendererId: string;
    title: string;
    payload: JsonValue;
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<PluginInteractionResult>;
  ensureSharedPortTunnel: PluginHosts["ensureSharedPortTunnel"];
  validateSharedPortDeclaration: (
    hostId: string,
    ports: readonly number[],
  ) => readonly number[];
  declareSharedPorts: PluginHosts["declareSharedPorts"];
  replaceDeclaredSharedPorts: (
    declarations: readonly {
      hostId: string;
      ports: readonly number[];
    }[],
  ) => void;
  callPluginHost: (args: {
    contract: PluginRpcContract;
    method: string;
    input: unknown;
    hostId: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  registerProvider: (declaration: NormalizedPluginProviderDeclaration) => {
    dispose(): void;
  };
  registerAiService: (
    declaration: PluginAiServiceDeclaration,
    binding: AiServiceHostBinding<PluginHostArtifactSnapshot>,
  ) => {
    dispose(): void;
  };
  isProviderIdTaken: (providerId: string) => boolean;
  isAiServiceIdTaken: (serviceId: string) => boolean;
  assertAiServiceRegistrable: (
    serviceId: string,
  ) => AiServiceHostBinding<PluginHostArtifactSnapshot>;
  assertProviderRegistrable: (providerId: string) => void;
}): PluginApiHandle {
  const {
    pluginId,
    logger,
    db,
    dataDir,
    getSdk,
    getAppUrl,
    getLoopbackBaseUrl,
    publishSignal,
    settingsChanged,
    reportNeedsConfiguration,
    isAgentToolNameTaken,
    reportAgentToolProblem,
    requestQueueDrain,
    declaredIconNames,
    requestInteraction,
    ensureSharedPortTunnel,
    validateSharedPortDeclaration,
    declareSharedPorts,
    replaceDeclaredSharedPorts,
    callPluginHost,
    registerProvider,
    registerAiService,
    isProviderIdTaken,
    assertProviderRegistrable,
    isAiServiceIdTaken,
    assertAiServiceRegistrable,
  } = options;
  let invalidated = false;
  let activated = false;
  let wrappedSdk: BbSdk | undefined;
  let pendingNeedsConfiguration: string | null = null;
  const pendingAgentToolProblems: string[] = [];
  const pendingSharedPorts = new Map<string, readonly number[]>();
  const disposeHooks: Array<() => void | Promise<void>> = [];
  const settingsRecord: PluginApiHandle["settings"] = {
    descriptors: {},
    listeners: [],
  };
  const databaseHandles: Database.Database[] = [];
  const threadEventHandlers: PluginThreadEventHandlers = {
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
  const hooks: PluginHookRecords = {
    "message.dispatch": null,
  };
  const httpRoutes: PluginHttpRouteRecord[] = [];
  const websocketRoutes: PluginWebSocketRouteRecord[] = [];
  const rpcHandlers = new Map<string, PluginRpcHandler>();
  const hostWorkerExitHandlers: PluginHostWorkerExitHandler[] = [];
  const hostSignalHandlers: PluginHostSignalHandler[] = [];
  const backgroundServices: PluginBackgroundServiceRecord[] = [];
  const schedules: PluginScheduleRecord[] = [];

  function assertLive(): void {
    if (invalidated) throw new PluginContextStaleError(pluginId);
  }

  const prefix = `[plugin:${pluginId}]`;
  function emitLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): void {
    logger[level](`${prefix} ${message}`);
    appendPluginLogLine(dataDir, pluginId, level, message);
  }
  const log: PluginLogger = {
    debug: (message) => emitLog("debug", message),
    info: (message) => emitLog("info", message),
    warn: (message) => emitLog("warn", message),
    error: (message) => emitLog("error", message),
  };

  async function requestInput(
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
      if (
        Buffer.byteLength(json, "utf8") > PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES
      ) {
        throw new Error("ui.requestInput payload exceeds 64 KiB");
      }
      payload = JSON.parse(json) as JsonValue;
    } catch (error) {
      if (error instanceof Error && error.message.includes("64 KiB"))
        throw error;
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
    return requestInteraction({
      threadId: request.threadId,
      rendererId: request.rendererId,
      title: request.title.trim(),
      payload,
      timeoutMs,
      signal: requestOptions?.signal,
    });
  }

  const kv: PluginKvStorage = {
    async get(key) {
      assertLive();
      const raw = getPluginKvValue(db, pluginId, key);
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
      setPluginKvValue(db, pluginId, key, json);
    },
    async delete(key) {
      assertLive();
      deletePluginKvValue(db, pluginId, key);
    },
    async list(kvPrefix) {
      assertLive();
      return listPluginKvKeys(db, pluginId, kvPrefix);
    },
  };

  let databaseHandle: Database.Database | undefined;
  const storage: PluginStorage = {
    kv,
    database() {
      assertLive();
      if (databaseHandle?.open) return databaseHandle;
      if (databaseHandle) {
        const index = databaseHandles.indexOf(databaseHandle);
        if (index !== -1) databaseHandles.splice(index, 1);
      }
      const dir = join(dataDir, "plugins", pluginId);
      mkdirSync(dir, { recursive: true });
      const database = new Database(join(dir, "data.db"));
      database.pragma("journal_mode = WAL");
      database.pragma("busy_timeout = 5000");
      databaseHandle = database;
      databaseHandles.push(database);
      return database;
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

  const settings: PluginSettings = {
    define(descriptors) {
      assertLive();
      const validated = registerSettingDescriptors(
        settingsRecord.descriptors,
        descriptors as Record<string, unknown>,
      );
      type Values = PluginSettingsValues<typeof descriptors>;
      return {
        async get() {
          assertLive();
          return (await readPluginSettingsValues({
            db,
            dataDir,
            pluginId,
            descriptors: validated,
          })) as Values;
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
          const storeArgs = {
            db,
            dataDir,
            pluginId,
            descriptors: settingsRecord.descriptors,
          };
          const prev = await readPluginSettingsValues(storeArgs);
          await writePluginSettingsUpdate({ ...storeArgs, values: rawValues });
          const next = await readPluginSettingsValues(storeArgs);
          if (JSON.stringify(next) !== JSON.stringify(prev)) {
            for (const listener of settingsRecord.listeners) {
              try {
                listener(next, prev);
              } catch (error) {
                emitLog(
                  "warn",
                  `settings onChange listener failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            if (activated) settingsChanged();
          }
          return (await readPluginSettingsValues({
            db,
            dataDir,
            pluginId,
            descriptors: validated,
          })) as Values;
        },
        onChange(listener) {
          assertLive();
          settingsRecord.listeners.push(listener as PluginSettingsListener);
        },
      };
    },
  };

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
      websocketRoutes.push({
        path,
        auth,
        handler,
        active: true,
        sockets: new Set(),
      });
    },
  };

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

      const pending: Array<[string, PluginRpcHandler]> = [];
      const contractEntries = Object.entries(contract);
      const contractNames = new Set(contractEntries.map(([name]) => name));
      for (const extraName of Object.keys(handlers)) {
        if (!contractNames.has(extraName)) {
          throw new Error(
            `rpc handler "${extraName}" has no matching contract method`,
          );
        }
      }
      for (const [name, methodContractValue] of contractEntries) {
        if (!RPC_METHOD_PATTERN.test(name)) {
          throw new Error(
            `invalid rpc method name "${name}" — use dot-separated segments with letters, digits, "-" and "_"`,
          );
        }
        const methodContract = readRpcMethodContract(name, methodContractValue);
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

  const realtime: PluginRealtime = {
    publish(channel, payload) {
      assertLive();
      if (typeof channel !== "string" || channel.length === 0) {
        throw new Error("realtime channel must be a non-empty string");
      }
      let normalized: unknown = null;
      if (payload !== undefined) {
        let json: string | undefined;
        try {
          json = JSON.stringify(payload);
        } catch {
          json = undefined;
        }
        if (json === undefined) {
          throw new Error(
            `realtime payload for channel "${channel}" is not JSON-serializable`,
          );
        }
        normalized = JSON.parse(json);
      }
      publishSignal(channel, normalized);
    },
  };

  const background: PluginBackground = {
    service(name, service) {
      assertLive();
      if (typeof name !== "string" || !BACKGROUND_NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid service name ${JSON.stringify(name)} — use letters, digits, "-" and "_"`,
        );
      }
      if (backgroundServices.some((record) => record.name === name)) {
        throw new Error(`background service "${name}" is already registered`);
      }
      if (typeof service?.start !== "function") {
        throw new Error(
          `background service "${name}" must provide a start(signal) function`,
        );
      }
      backgroundServices.push({ name, start: service.start.bind(service) });
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
          `invalid cron ${JSON.stringify(cron)} for schedule "${name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (typeof fn !== "function") {
        throw new Error(`schedule "${name}" must provide a function`);
      }
      schedules.push({ name, cron: String(cron), fn });
    },
  };

  const agentTools: PluginAgentToolRecord[] = [];
  const providerRegistrations = createStagedRegistrations({
    validate: (declaration: PluginProviderDeclaration) => {
      const normalized = validatePluginProviderDeclaration(declaration);
      const problem =
        normalized.icon === undefined
          ? null
          : undeclaredIconProblem(pluginId, declaredIconNames, normalized.icon);
      if (problem !== null) {
        throw new Error(providerIconRefusalMessage(normalized.id, problem));
      }
      return normalized;
    },
    bind: assertProviderRegistrable,
    isTaken: isProviderIdTaken,
    registerLive: registerProvider,
    alreadyRegisteredMessage: providerAlreadyRegisteredMessage,
    assertLive,
    isActivated: () => activated,
    disposeHooks,
  });
  const providerEnvResolvers = new Map<string, PluginProviderEnvResolver>();
  const providerEnvHealthResolvers = new Map<
    string,
    PluginProviderEnvHealthResolver
  >();
  let agentConfigurationProvider: PluginAgentConfigurationProvider | null =
    null;
  let instructionProvider: PluginInstructionProvider | null = null;

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
      let parse: PluginAgentToolRecord["parse"];
      if (isZodSchemaLike(parameters)) {
        try {
          inputSchema = zodSchemaToJsonSchema(parameters);
        } catch (error) {
          throw new Error(
            `tool "${name}" parameters look like a zod schema but could not be converted to JSON Schema (${
              error instanceof Error ? error.message : String(error)
            }) — use zod 4, or pass a plain JSON-schema object`,
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
      const owner = isAgentToolNameTaken(name);
      if (owner !== undefined) {
        const problem = `tool "${name}" is already registered by plugin "${owner}" — not registered`;
        if (activated) reportAgentToolProblem(problem);
        else pendingAgentToolProblems.push(problem);
        return;
      }
      if (agentTools.some((existing) => existing.name === name)) {
        throw new Error(`tool "${name}" is already registered`);
      }
      const record: PluginAgentToolRecord = {
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
      agentTools.push(record);
    },
  };
  Object.defineProperty(agents, "experimental_registerProvider", {
    enumerable: false,
    configurable: false,
    get(): never {
      throw new Error(
        "bb.agents.experimental_registerProvider was removed in SDK 0.4.16; use bb.providers.register",
      );
    },
  });

  const mentionProviders: PluginMentionProviderRecord[] = [];
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

  const cliRecord: PluginApiHandle["cli"] = { registration: null };
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
    },
  };

  const status: PluginStatusApi = {
    needsConfiguration(message) {
      assertLive();
      const normalized =
        typeof message === "string" && message.length > 0
          ? message
          : "needs configuration";
      if (activated) reportNeedsConfiguration(normalized);
      else pendingNeedsConfiguration = normalized;
    },
  };

  const server: PluginServerApi = {
    get experimental_appUrl(): string | null {
      assertLive();
      return getAppUrl();
    },
    get loopbackBaseUrl(): string {
      assertLive();
      const baseUrl = getLoopbackBaseUrl();
      if (baseUrl === undefined) {
        throw new Error(
          "bb.server.loopbackBaseUrl is not available until the server is listening — " +
            "use it inside handlers, services, or timers, not at factory load time",
        );
      }
      return baseUrl;
    },
    get experimental_dataDir(): string {
      assertLive();
      return dataDir;
    },
  };

  const hosts: PluginHosts = {
    experimental_client({ contract, experimental_signals }) {
      assertLive();
      return {
        async call(method, input, callOptions) {
          assertLive();
          if (!activated) {
            throw new Error(
              "host plugin calls are unavailable during factory registration; call from a handler, service, or timer",
            );
          }
          if (typeof method !== "string" || contract[method] === undefined) {
            throw new Error(`unknown host rpc method "${String(method)}"`);
          }
          if (
            typeof callOptions !== "object" ||
            callOptions === null ||
            typeof callOptions.hostId !== "string" ||
            callOptions.hostId.length === 0
          ) {
            throw new Error(`host rpc method "${method}" requires a host id`);
          }
          return callPluginHost({
            contract,
            method,
            input,
            hostId: callOptions.hostId,
            ...(callOptions.signal === undefined
              ? {}
              : { signal: callOptions.signal }),
          });
        },
        experimental_onWorkerExit(handler) {
          assertLive();
          if (typeof handler !== "function") {
            throw new Error("host worker exit subscription requires a handler");
          }
          hostWorkerExitHandlers.push(handler);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostWorkerExitHandlers.indexOf(handler);
            if (index >= 0) hostWorkerExitHandlers.splice(index, 1);
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
          const record: PluginHostSignalHandler = {
            signal,
            payloadSchema: descriptor.payload,
            handler,
          };
          hostSignalHandlers.push(record);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostSignalHandlers.indexOf(record);
            if (index >= 0) hostSignalHandlers.splice(index, 1);
          };
        },
      };
    },
    ensureSharedPortTunnel(hostId) {
      assertLive();
      return ensureSharedPortTunnel(hostId);
    },
    declareSharedPorts(hostId, ports) {
      assertLive();
      if (activated) declareSharedPorts(hostId, ports);
      else {
        pendingSharedPorts.set(
          hostId,
          validateSharedPortDeclaration(hostId, ports),
        );
      }
    },
  };
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

  const experimental_hooks: PluginHooks = {
    on(hook, handler) {
      assertLive();
      if (hooks[hook] !== null) {
        // Two handlers from one plugin for one hook would make the order
        // within the plugin invisible. Say so at registration rather than
        // silently keeping one.
        throw new Error(pluginHookAlreadyRegisteredMessage(hook));
      }
      storePluginHook(hooks, hook, handler);
    },
    async recheck(hook) {
      assertLive();
      // One hook key exists; the parameter selects which question to re-pose
      // and widens additively when a second key ever ships.
      void hook;
      // Resolves on SCHEDULING. The walk runs on a later macrotask, and the
      // caller is not the one it reports to — a failed re-attempt lands on the
      // row it failed, like every other background drain.
      requestQueueDrain();
    },
  };

  const providers: PluginProviders = {
    register: providerRegistrations.register,
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

  const aiServiceRegistrations = createStagedRegistrations({
    validate: validatePluginAiServiceDeclaration,
    bind: assertAiServiceRegistrable,
    isTaken: isAiServiceIdTaken,
    registerLive: registerAiService,
    alreadyRegisteredMessage: aiServiceAlreadyRegisteredMessage,
    assertLive,
    isActivated: () => activated,
    disposeHooks,
  });
  const experimental_aiServices: PluginAiServices = {
    register: aiServiceRegistrations.register,
  };

  const api: BbPluginApi = {
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
    get sdk(): BbSdk {
      assertLive();
      const sdk = getSdk();
      if (!sdk) {
        throw new Error(
          "bb.sdk is not available until the server is listening — " +
            "use it inside handlers, services, or timers, not at factory load time",
        );
      }
      wrappedSdk ??= wrapSdkForPlugin(sdk, pluginId);
      return wrappedSdk;
    },
    onDispose(hook) {
      assertLive();
      disposeHooks.push(hook);
    },
  };

  return {
    api,
    disposeHooks,
    settings: settingsRecord,
    databaseHandles,
    threadEventHandlers,
    hooks,
    httpRoutes,
    websocketRoutes,
    rpcHandlers,
    hostWorkerExitHandlers,
    hostSignalHandlers,
    backgroundServices,
    schedules,
    cli: cliRecord,
    agentTools,
    listProviderDeclarations: providerRegistrations.values,
    providerEnvResolvers,
    providerEnvHealthResolvers,
    get agentConfigurationProvider() {
      return agentConfigurationProvider;
    },
    get instructionProvider() {
      return instructionProvider;
    },
    mentionProviders,
    activate() {
      if (activated) return;
      assertLive();
      replaceDeclaredSharedPorts(
        [...pendingSharedPorts].map(([hostId, ports]) => ({ hostId, ports })),
      );
      providerRegistrations.flush();
      aiServiceRegistrations.flush();
      activated = true;
      const cliWarning = cliRecord.registration
        ? pluginCliCollisionWarning(pluginId, cliRecord.registration.name)
        : null;
      if (cliWarning) emitLog("warn", cliWarning);
      pendingSharedPorts.clear();
      for (const problem of pendingAgentToolProblems) {
        reportAgentToolProblem(problem);
      }
      pendingAgentToolProblems.length = 0;
      if (pendingNeedsConfiguration !== null) {
        reportNeedsConfiguration(pendingNeedsConfiguration);
        pendingNeedsConfiguration = null;
      }
    },
    closeWebSockets() {
      for (const route of websocketRoutes) {
        route.active = false;
        for (const socket of route.sockets) {
          try {
            socket.close(1012, "Plugin reloaded or disabled");
          } catch (error) {
            emitLog(
              "warn",
              `websocket ${route.path} close failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    },
    invalidate() {
      invalidated = true;
    },
  };
}
