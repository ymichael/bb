import { loadCliConfig, type CliConfig } from "@bb/config/cli";
import {
  createHostDaemonLocalClient,
  DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST,
} from "@bb/host-daemon-contract";
import { createGuideArea } from "./areas/guide.js";
import { createBbSdk, type BbSdk, type BbSdkAreas } from "./core.js";
import { createNodeWebsocketFactory } from "./node-websocket.js";
import {
  createRequestTimeoutFetch,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
  type FetchImplementation,
} from "./response.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  BbRealtimeSocketFactory,
  BbSdkContext,
  BbSdkTransport,
} from "./transport.js";

export interface CreateNodeTransportArgs {
  baseUrl?: string;
  cliConfig?: CliConfig;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  timeoutMs?: number;
  websocket?: BbRealtimeSocketFactory;
}

export interface CreateNodeBbSdkArgs extends CreateNodeTransportArgs {
  context?: BbSdkContext;
}

export interface FetchLocalHostIdArgs {
  cliConfig?: CliConfig;
  hostDaemonUrl?: string;
}

function resolveCliConfig(cliConfig?: CliConfig): CliConfig {
  return cliConfig ?? loadCliConfig();
}

function resolveHostDaemonUrl(cliConfig?: CliConfig): string {
  const config = resolveCliConfig(cliConfig);
  return `http://${DEFAULT_HOST_DAEMON_LOCAL_BIND_HOST}:${config.BB_HOST_DAEMON_PORT}`;
}

export function createNodeTransport(
  args: CreateNodeTransportArgs = {},
): BbSdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl ?? resolveCliConfig(args.cliConfig).BB_SERVER_URL,
    fetch:
      args.fetch ??
      createRequestTimeoutFetch({
        timeoutMs: args.timeoutMs ?? DEFAULT_BB_REQUEST_TIMEOUT_MS,
      }),
    realtimeUrl: args.realtimeUrl,
    runtime: "node",
    websocket: args.websocket ?? createNodeWebsocketFactory(),
  });
}

export function createNodeBbSdk(args: CreateNodeBbSdkArgs = {}): BbSdk {
  return createBbSdk({
    context: args.context,
    guide: createGuideArea(),
    transport: createNodeTransport(args),
  });
}

export async function fetchLocalHostId(
  args: FetchLocalHostIdArgs = {},
): Promise<string | null> {
  try {
    const client = createHostDaemonLocalClient(
      args.hostDaemonUrl ?? resolveHostDaemonUrl(args.cliConfig),
    );
    const response = await client.status.$get();
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return body.hostId;
  } catch {
    return null;
  }
}

export {
  createBbSdk,
  createHttpTransport,
  createRequestTimeoutFetch,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
};
export { BbHttpError, BbRequestTimeoutError } from "./response.js";
export {
  pluginMutationResponseSchema,
  type PluginMutationResponse,
} from "./areas/plugins.js";
export { createBuiltinPlanCommandTextInput } from "./core.js";
export { createGuideArea } from "./areas/guide.js";
export {
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  DEFAULT_THREAD_WAIT_TIMEOUT_MS,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
} from "./areas/threads.js";
export type {
  BbSdk,
  BbSdkAreas,
  BbSdkContext,
  BbSdkTransport,
  FetchImplementation,
};
export type * from "./areas/skills.js";
export type {
  BbRealtimeSocket,
  BbRealtimeSocketFactory,
  BbRealtimeSocketMessageEvent,
} from "./transport.js";
export type { BbHttpErrorArgs } from "./response.js";
export type * from "./public-types.js";
