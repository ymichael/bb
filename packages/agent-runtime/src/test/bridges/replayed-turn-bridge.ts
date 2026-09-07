import {
  type ThreadDelta,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_NOTIFICATION_METHOD,
  threadStartParamsSchema,
  turnStartParamsSchema,
  experimental_defineProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

const inboundSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown(),
});

function writeMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  writeMessage({
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: { threadId, deltas },
  });
}

let providerThreadCounter = 0;
const turnCountByThreadId = new Map<string, number>();

export function handleLine(line: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  const inbound = inboundSchema.safeParse(raw);
  if (!inbound.success) {
    return;
  }
  const { id, method, params } = inbound.data;

  if (method === BRIDGE_REQUEST_METHODS.initialize) {
    writeMessage({
      id,
      result: {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: { grammarVersions: [2, 3] },
      },
    });
    return;
  }

  if (method === BRIDGE_REQUEST_METHODS.threadStart) {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      writeMessage({
        id,
        error: {
          code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
          message: "Invalid params for thread/start",
        },
      });
      return;
    }
    providerThreadCounter += 1;
    const providerThreadId = `prov-replay-${providerThreadCounter}`;
    writeMessage({
      method: BRIDGE_NOTIFICATION_METHODS.threadIdentity,
      params: { threadId: parsed.data.threadId, providerThreadId },
    });
    emitDeltas(parsed.data.threadId, [{ kind: "session.reset" }]);
    writeMessage({ id, result: { providerThreadId } });
    return;
  }

  if (method === BRIDGE_REQUEST_METHODS.turnStart) {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      writeMessage({
        id,
        error: {
          code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
          message: "Invalid params for turn/start",
        },
      });
      return;
    }
    const { threadId } = parsed.data;
    const turnCount = (turnCountByThreadId.get(threadId) ?? 0) + 1;
    turnCountByThreadId.set(threadId, turnCount);
    const providerTurnId = `turn-${turnCount}`;
    const key = { providerItemId: `msg-${turnCount}` };
    writeMessage({ id, result: {} });
    emitDeltas(threadId, [
      { kind: "turn.open", providerTurnId },
      {
        kind: "item.open",
        key,
        item: { type: "agentMessage", text: "" },
        providerTurnId,
      },
      {
        kind: "item.close",
        key,
        status: "completed",
        item: { type: "agentMessage", text: "Response complete" },
        providerTurnId,
      },
      { kind: "turn.boundary", status: "completed", providerTurnId },
      { kind: "turn.open", providerTurnId },
    ]);
    return;
  }

  writeMessage({
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      message: `Method not found: ${method}`,
    },
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
});
