import { randomUUID } from "node:crypto";
import {
  type HostDaemonOnlineRpcResponseMessage,
  type HostDaemonOnlineRpcResultForCommand,
  type HostDaemonRetryableOnlineRpcCommand,
  parseHostDaemonRpcResultForCommand,
  type HostDaemonRpcCommand,
  type HostDaemonRpcResultForCommand,
} from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { WorkSessionDeps } from "../../types.js";
import {
  HostOnlineRpcTimeoutError,
  HostOnlineRpcUnavailableError,
} from "../../ws/hub.js";
import { ensureHostSessionReadyForWork } from "./host-lifecycle.js";

const HOST_DAEMON_REGISTRATION_WAIT_MS = 1_000;

interface CallHostOnlineRpcArgs<TCommand extends HostDaemonRpcCommand> {
  command: TCommand;
  hostId: string;
  timeoutMs: number;
}

interface CallHostRetryableOnlineRpcArgs<
  TCommand extends HostDaemonRetryableOnlineRpcCommand,
> {
  command: TCommand;
  hostId: string;
  timeoutMs: number;
}

export function callHostOnlineRpc<TCommand extends HostDaemonRpcCommand>(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<TCommand>,
): Promise<HostDaemonRpcResultForCommand<TCommand>>;
export async function callHostOnlineRpc(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
): Promise<HostDaemonRpcResultForCommand> {
  return callHostOnlineRpcWithRetry(deps, args, {
    retryOnTransportFailure: false,
  });
}

export function callHostRetryableOnlineRpc<
  TCommand extends HostDaemonRetryableOnlineRpcCommand,
>(
  deps: WorkSessionDeps,
  args: CallHostRetryableOnlineRpcArgs<TCommand>,
): Promise<HostDaemonOnlineRpcResultForCommand<TCommand>>;
export async function callHostRetryableOnlineRpc(
  deps: WorkSessionDeps,
  args: CallHostRetryableOnlineRpcArgs<HostDaemonRetryableOnlineRpcCommand>,
): Promise<HostDaemonOnlineRpcResultForCommand> {
  return callHostOnlineRpcWithRetry(deps, args, {
    retryOnTransportFailure: true,
  });
}

async function callHostOnlineRpcWithRetry(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
  options: { retryOnTransportFailure: false },
): Promise<HostDaemonRpcResultForCommand>;
async function callHostOnlineRpcWithRetry(
  deps: WorkSessionDeps,
  args: CallHostRetryableOnlineRpcArgs<HostDaemonRetryableOnlineRpcCommand>,
  options: { retryOnTransportFailure: true },
): Promise<HostDaemonOnlineRpcResultForCommand>;
async function callHostOnlineRpcWithRetry(
  deps: WorkSessionDeps,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
  options: { retryOnTransportFailure: boolean },
): Promise<HostDaemonRpcResultForCommand> {
  await ensureHostSessionReadyForWork(deps, { hostId: args.hostId }).catch(
    async (error) => {
      if (
        !options.retryOnTransportFailure ||
        !isHostUnavailableApiError(error)
      ) {
        throw error;
      }
      await waitForRetryableHostRpcTransport(deps, args.hostId);
    },
  );
  const timeoutRetryDeadline =
    options.retryOnTransportFailure && args.timeoutMs > 1
      ? Date.now() + args.timeoutMs
      : null;
  const firstAttemptArgs =
    timeoutRetryDeadline === null
      ? args
      : {
          ...args,
          timeoutMs: Math.max(1, Math.floor(args.timeoutMs / 2)),
        };
  const response = await requestHostOnlineRpcResponse(
    deps,
    firstAttemptArgs,
  ).catch(async (error) => {
    if (!options.retryOnTransportFailure) {
      throwOnlineRpcError(error);
    }
    if (error instanceof HostOnlineRpcUnavailableError) {
      await waitForRetryableHostRpcTransport(deps, args.hostId);
      return requestHostOnlineRpcResponse(deps, args).catch((retryError) => {
        throwOnlineRpcError(retryError);
      });
    }
    if (!(error instanceof HostOnlineRpcTimeoutError)) {
      throwOnlineRpcError(error);
    }
    const retryTimeoutMs =
      timeoutRetryDeadline === null ? 0 : timeoutRetryDeadline - Date.now();
    if (retryTimeoutMs <= 0) {
      throwOnlineRpcError(error);
    }
    return requestHostOnlineRpcResponse(deps, {
      ...args,
      timeoutMs: retryTimeoutMs,
    }).catch((retryError) => {
      throwOnlineRpcError(retryError);
    });
  });

  if (!response.ok) {
    throw new ApiError(502, response.errorCode, response.errorMessage, false);
  }

  if (response.commandType !== args.command.type) {
    throw new ApiError(
      500,
      "command_result_type_mismatch",
      `Host RPC ${response.requestId} completed with unexpected type ${response.commandType}`,
    );
  }

  return parseHostDaemonRpcResultForCommand(args.command, response.result);
}

async function waitForRetryableHostRpcTransport(
  deps: WorkSessionDeps,
  hostId: string,
): Promise<void> {
  if (deps.hub.hasDaemonForHost(hostId)) {
    await ensureHostSessionReadyForWork(deps, { hostId });
    return;
  }
  await deps.hub.waitForDaemonForHost(hostId, HOST_DAEMON_REGISTRATION_WAIT_MS);
  await ensureHostSessionReadyForWork(deps, { hostId });
}

export function isHostUnavailableApiError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 502 &&
    error.body.code === "host_unavailable"
  );
}

function requestHostOnlineRpcResponse(
  deps: Pick<WorkSessionDeps, "hub">,
  args: CallHostOnlineRpcArgs<HostDaemonRpcCommand>,
): Promise<HostDaemonOnlineRpcResponseMessage> {
  return deps.hub.requestHostOnlineRpc({
    hostId: args.hostId,
    message: {
      type: "host-rpc.request",
      requestId: randomUUID(),
      command: args.command,
    },
    timeoutMs: args.timeoutMs,
  });
}

export function hostCommandTimeoutError(): ApiError {
  return new ApiError(
    504,
    "command_timeout",
    "Timed out waiting for command result",
  );
}

function throwOnlineRpcError(error: unknown): never {
  if (error instanceof HostOnlineRpcTimeoutError) {
    throw hostCommandTimeoutError();
  }

  if (error instanceof HostOnlineRpcUnavailableError) {
    throw new ApiError(502, "host_unavailable", "Host is not connected", false);
  }

  throw error;
}
