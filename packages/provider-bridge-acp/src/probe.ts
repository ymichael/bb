import { z } from "zod";
import { withoutBridgeRuntimeEnv } from "@bb/provider-bridge-protocol/bridge-kit";
import {
  AcpAgentExitedError,
  createAcpAgentConnection,
} from "./bridge/agent-connection.js";
import { ACP_PROTOCOL_VERSION, acpInitializeResultSchema } from "./wire.js";

const PROBE_TIMEOUT_MS = 10_000;

export interface AcpAgentProbeRequest {
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
}

export type AcpAgentProbe =
  | {
      reachable: true;
      fork: boolean;
    }
  | { reachable: false; reason: string };

function describe(error: unknown): string {
  if (error instanceof AcpAgentExitedError) {
    return `the agent exited before it answered initialize: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function probeAcpAgent(
  request: AcpAgentProbeRequest,
): Promise<AcpAgentProbe> {
  const timeoutMs = request.timeoutMs ?? PROBE_TIMEOUT_MS;
  let connection: ReturnType<typeof createAcpAgentConnection> | undefined;
  try {
    connection = createAcpAgentConnection({
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      env: withoutBridgeRuntimeEnv({ ...process.env, ...(request.env ?? {}) }),
      recordThreadId: null,
      onNotification: () => {},
      onRequest: (_method, _params, responder) => {
        responder.error(-32601, "bb is probing this agent's capabilities");
      },
      onExit: () => {},
    });
  } catch (error) {
    return { reachable: false, reason: describe(error) };
  }

  const connected = connection;
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `the agent did not answer initialize within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    ).unref?.();
  });

  try {
    const result = await Promise.race([
      connected.request({
        method: "initialize",
        params: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientInfo: { name: "bb", version: "1.0.0" },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: false,
          },
        },
        resultSchema: acpInitializeResultSchema,
      }),
      timeout,
    ]);
    return {
      reachable: true,
      fork: result.agentCapabilities?.sessionCapabilities?.fork != null,
    };
  } catch (error) {
    return { reachable: false, reason: describe(error) };
  } finally {
    connected.kill();
  }
}

export const acpAgentProbeSchema: z.ZodType<AcpAgentProbe> = z.union([
  z.object({ reachable: z.literal(true), fork: z.boolean() }),
  z.object({ reachable: z.literal(false), reason: z.string() }),
]);
