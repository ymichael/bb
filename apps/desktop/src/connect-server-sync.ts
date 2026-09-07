import { z } from "zod";
import {
  ConnectListError,
  listAccountServers,
  type ConnectCredential,
} from "@bb/connect-client";

const connectAccountServerSchema = z
  .object({
    handle: z.string().min(1),
    name: z.string().min(1),
    live: z.boolean(),
    url: z.string().min(1),
  })
  .strict();
export type ConnectAccountServer = z.infer<typeof connectAccountServerSchema>;

const connectListAccountServersResultSchema = z
  .object({
    servers: z.array(connectAccountServerSchema),
    selfHandle: z.string().min(1),
  })
  .strict();

type ConnectListAccountServersResult = z.infer<
  typeof connectListAccountServersResultSchema
>;

const rpcSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: connectListAccountServersResultSchema,
  })
  .strict();

const rpcFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z.union([
      z.string(),
      z.object({ code: z.string(), message: z.string() }).passthrough(),
    ]),
  })
  .passthrough();

export type ConnectServerSyncSkipReason =
  | "no-credential"
  | "plugin-disabled"
  | "not-paired"
  | "unauthorized"
  | "unavailable";

export type FetchConnectAccountServersResult =
  | { ok: true; result: ConnectListAccountServersResult }
  | { ok: false; reason: ConnectServerSyncSkipReason };

const CONNECT_PLUGIN_ID = "connect";
const LIST_ACCOUNT_SERVERS_RPC = "listAccountServers";
const CONNECT_SERVER_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const CONNECT_SERVER_SYNC_MIN_INTERVAL_MS = 60 * 1000;

type ConnectServerSyncFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

type ConnectServerSyncLog = (message: string) => void;

interface FetchConnectAccountServersArgs {
  serverUrl: string;
  fetchImpl?: ConnectServerSyncFetch;
}

export async function fetchConnectAccountServers(
  args: FetchConnectAccountServersArgs,
): Promise<FetchConnectAccountServersResult> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const base = args.serverUrl.replace(/\/$/u, "");
  const url = `${base}/api/v1/plugins/${encodeURIComponent(CONNECT_PLUGIN_ID)}/rpc/${encodeURIComponent(LIST_ACCOUNT_SERVERS_RPC)}`;

  let response: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  const success = rpcSuccessSchema.safeParse(body);
  if (success.success) {
    return { ok: true, result: success.data.result };
  }

  if (response.status === 503) {
    return { ok: false, reason: "plugin-disabled" };
  }
  const failure = rpcFailureSchema.safeParse(body);
  if (
    failure.success &&
    typeof failure.data.error === "object" &&
    failure.data.error.code === "handler_error" &&
    failure.data.error.message === "not_paired"
  ) {
    return { ok: false, reason: "not-paired" };
  }
  return { ok: false, reason: "unavailable" };
}

export function selectTargetableConnectServers(
  result: ConnectListAccountServersResult,
): ConnectAccountServer[] {
  return result.servers.filter((server) => server.handle !== result.selfHandle);
}

interface CreateConnectServerSyncArgs {
  getCredential: () => ConnectCredential | null;
  getLocalServerUrl: () => string | null;
  onServers: (servers: ConnectAccountServer[]) => void;
  onSkipped: (reason: ConnectServerSyncSkipReason) => void;
  onUnauthorized: () => void;
  gateFetchImpl?: typeof fetch;
  fetchImpl?: ConnectServerSyncFetch;
  log?: ConnectServerSyncLog;
  now?: () => number;
  minIntervalMs?: number;
  setIntervalFn?: (handler: () => void, timeout: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface ConnectServerSync {
  start(): void;
  stop(): void;
  onRuntimeReady(): void;
  onListRequested(): void;
  syncNow(): Promise<void>;
}

export function createConnectServerSync(
  args: CreateConnectServerSyncArgs,
): ConnectServerSync {
  const intervalMs = CONNECT_SERVER_SYNC_INTERVAL_MS;
  const minIntervalMs =
    args.minIntervalMs ?? CONNECT_SERVER_SYNC_MIN_INTERVAL_MS;
  const now = args.now ?? Date.now;
  const setIntervalFn =
    args.setIntervalFn ??
    ((handler: () => void, timeout: number) => setInterval(handler, timeout));
  const clearIntervalFn =
    args.clearIntervalFn ??
    ((handle: unknown) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });
  const log = args.log;

  let timer: unknown = null;
  let lastSyncAttemptAt = 0;
  let inFlight: Promise<void> | null = null;
  let loggedSkipReason: ConnectServerSyncSkipReason | null = null;

  async function fetchServers(): Promise<FetchConnectAccountServersResult> {
    const serverUrl = args.getLocalServerUrl();
    if (serverUrl !== null) {
      return fetchConnectAccountServers({
        serverUrl,
        fetchImpl: args.fetchImpl,
      });
    }
    const credential = args.getCredential();
    if (credential === null) {
      return { ok: false, reason: "no-credential" };
    }
    try {
      const result = await listAccountServers(credential, args.gateFetchImpl);
      return { ok: true, result };
    } catch (error) {
      if (error instanceof ConnectListError && error.code === "unauthorized") {
        args.onUnauthorized();
        return { ok: false, reason: "unauthorized" };
      }
      return { ok: false, reason: "unavailable" };
    }
  }

  async function runSync(): Promise<void> {
    lastSyncAttemptAt = now();
    const outcome = await fetchServers();
    if (!outcome.ok) {
      if (loggedSkipReason !== outcome.reason) {
        loggedSkipReason = outcome.reason;
        log?.(`connect server sync skipped (${outcome.reason})`);
      }
      args.onSkipped(outcome.reason);
      return;
    }

    loggedSkipReason = null;
    args.onServers(selectTargetableConnectServers(outcome.result));
  }

  function syncNow(): Promise<void> {
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = runSync().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function onRuntimeReady(): void {
    void syncNow();
  }

  function onListRequested(): void {
    if (now() - lastSyncAttemptAt < minIntervalMs) {
      return;
    }
    void syncNow();
  }

  function start(): void {
    if (timer !== null) {
      return;
    }
    const handle = setIntervalFn(() => {
      void syncNow();
    }, intervalMs);
    if (
      typeof handle === "object" &&
      handle !== null &&
      "unref" in handle &&
      typeof handle.unref === "function"
    ) {
      handle.unref();
    }
    timer = handle;
  }

  function stop(): void {
    if (timer === null) {
      return;
    }
    clearIntervalFn(timer);
    timer = null;
  }

  return {
    start,
    stop,
    onRuntimeReady,
    onListRequested,
    syncNow,
  };
}
