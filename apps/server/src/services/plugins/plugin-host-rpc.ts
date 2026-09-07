import { randomUUID } from "node:crypto";
import { listPublicHosts } from "@bb/db";
import type {
  PluginRpcContract,
  StandardSchemaV1,
  StandardSchemaV1Result,
} from "@get-bb/plugin-sdk";
import type { JsonValue } from "@bb/domain";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { WorkSessionDeps } from "../../types.js";
import { callHostOnlineRpc } from "../hosts/online-rpc.js";
import type { PluginHostArtifactSnapshot } from "./plugin-service-internal.js";

const HOST_RPC_TRANSPORT_GRACE_MS = 6_000;
const HOST_RPC_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;

async function validateValue(
  schema: StandardSchemaV1,
  value: unknown,
  phase: "input" | "output",
): Promise<unknown> {
  let result: StandardSchemaV1Result<unknown>;
  try {
    result = await schema["~standard"].validate(value);
  } catch (error) {
    throw new Error(
      `host rpc ${phase} validator failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.issues !== undefined) {
    throw new Error(
      `host rpc ${phase} validation failed: ${result.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return result.value;
}

function normalizeJson(value: unknown, label: string): JsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    throw new Error(`${label} is not JSON-serializable`);
  }
  if (Buffer.byteLength(serialized) > HOST_RPC_PAYLOAD_MAX_BYTES) {
    throw new Error(`${label} exceeds ${HOST_RPC_PAYLOAD_MAX_BYTES} bytes`);
  }
  return JSON.parse(serialized) as JsonValue;
}

function abortError(): Error {
  return Object.assign(new Error("Host plugin call was cancelled"), {
    name: "AbortError",
  });
}

export async function callPluginHostRpc(
  deps: WorkSessionDeps,
  args: {
    pluginId: string;
    contract: PluginRpcContract;
    method: string;
    input: unknown;
    hostId: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    artifact: PluginHostArtifactSnapshot;
  },
): Promise<unknown> {
  const method = args.contract[args.method];
  if (method === undefined) {
    throw new Error(`unknown host rpc method "${args.method}"`);
  }
  if (args.signal?.aborted) throw abortError();
  const input = normalizeJson(
    await validateValue(method.input, args.input, "input"),
    `host rpc input for ${args.method}`,
  );
  const callId = randomUUID();
  const timeoutMs = args.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const rpc = callHostOnlineRpc(deps, {
    hostId: args.hostId,
    timeoutMs: timeoutMs + HOST_RPC_TRANSPORT_GRACE_MS,
    command: {
      type: "plugin.host.call",
      pluginId: args.pluginId,
      generation: args.artifact.generation,
      artifact: {
        digest: args.artifact.digest,
        byteLength: args.artifact.byteLength,
      },
      callId,
      method: args.method,
      input,
      timeoutMs,
    },
  });
  const signal = args.signal;
  const result =
    signal === undefined
      ? await rpc
      : await new Promise<Awaited<typeof rpc>>((resolve, reject) => {
          let settled = false;
          const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            fn();
          };
          const onAbort = (): void => {
            void callHostOnlineRpc(deps, {
              hostId: args.hostId,
              timeoutMs: HOST_RPC_TRANSPORT_GRACE_MS,
              command: {
                type: "plugin.host.cancel",
                pluginId: args.pluginId,
                generation: args.artifact.generation,
                callId,
              },
            }).catch(() => undefined);
            finish(() => reject(abortError()));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          rpc.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error)),
          );
        });
  const output = await validateValue(method.output, result.output, "output");
  return output;
}

export async function disposePluginHostWorkers(
  deps: WorkSessionDeps,
  args: { pluginId: string; generation: string },
): Promise<void> {
  const calls = listPublicHosts(deps.db)
    .filter((host) => deps.hub.hasDaemonForHost(host.id))
    .map((host) =>
      callHostOnlineRpc(deps, {
        hostId: host.id,
        timeoutMs: HOST_RPC_TRANSPORT_GRACE_MS,
        command: {
          type: "plugin.host.dispose",
          pluginId: args.pluginId,
          generation: args.generation,
        },
      }),
    );
  await Promise.allSettled(calls);
}
