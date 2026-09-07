import type { ThreadEvent } from "@bb/domain";
import {
  THREAD_DELTA_NOTIFICATION_METHOD,
  threadDeltaNotificationParamsSchema,
} from "../thread-delta.js";
import {
  createDeltaAssembler,
  type DeltaAssembler,
} from "../assembler/delta-assembler.js";

export interface CapturedBridgeNotification {
  method?: string;
  params?: unknown;
}

export interface BridgeDeltaEventCollector {
  assembler: DeltaAssembler;
  assembleMessage(message: CapturedBridgeNotification): ThreadEvent[];
}

export function createBridgeDeltaEventCollector(
  providerId = "pi",
): BridgeDeltaEventCollector {
  const assembler = createDeltaAssembler({ providerId, textDeltaFlushMs: 0 });
  return {
    assembler,
    assembleMessage(message) {
      if (message.method !== THREAD_DELTA_NOTIFICATION_METHOD) {
        return [];
      }
      const parsed = threadDeltaNotificationParamsSchema.safeParse(
        message.params,
      );
      if (!parsed.success) {
        throw new Error(
          `Invalid thread/delta notification: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join(
              "; ",
            )} (params: ${JSON.stringify(message.params)?.slice(0, 400)})`,
        );
      }
      return assembler.assemble({
        threadId: parsed.data.threadId,
        deltas: parsed.data.deltas,
      });
    },
  };
}

export function assembleCapturedThreadEvents(
  messages: readonly CapturedBridgeNotification[],
  providerId = "pi",
): ThreadEvent[] {
  const collector = createBridgeDeltaEventCollector(providerId);
  return messages.flatMap((message) => collector.assembleMessage(message));
}

export function toConformanceMessages(): never {
  throw new Error(
    "experimental_toConformanceMessages was removed: experimental_runBridgeConformance assembles thread/delta itself. Hand it a transport whose takeMessages returns the raw captured messages (CapturedBridgeJsonRpcOutput.takeMessages) and pass the bridge's providerId.",
  );
}
