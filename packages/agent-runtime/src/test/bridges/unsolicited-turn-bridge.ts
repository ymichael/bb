import {
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  type ThreadDelta,
  experimental_defineProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const UNSOLICITED_TURN_THREAD_ID_ENV = "UNSOLICITED_TURN_THREAD_ID";

const requestSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    method: z.string(),
  })
  .passthrough();

let turnTimer: NodeJS.Timeout | null = null;

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function openUnsolicitedTurn(): void {
  const threadId = process.env[UNSOLICITED_TURN_THREAD_ID_ENV];
  if (threadId === undefined || threadId.length === 0) {
    return;
  }
  const deltas: ThreadDelta[] = [
    { kind: "turn.open", providerTurnId: "turn-1" },
  ];
  write({
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: { threadId, deltas },
  });
}

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const request = requestSchema.safeParse(message);
  if (!request.success) {
    return;
  }
  if (request.data.method === BRIDGE_REQUEST_METHODS.initialize) {
    write({
      id: request.data.id,
      result: {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        },
      },
    });
    turnTimer ??= setInterval(openUnsolicitedTurn, 10);
    return;
  }
  write({ id: request.data.id, result: {} });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  onClose: () => {
    if (turnTimer !== null) {
      clearInterval(turnTimer);
      turnTimer = null;
    }
  },
});
