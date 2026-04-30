import { z } from "zod";
import type { ThreadEvent } from "@bb/domain";
import type {
  AgentRuntimeRawProviderEventCaptureEntry,
  AgentRuntimeTranslatedThreadEventCaptureEntry,
} from "./capture-types.js";
import { createProviderForId } from "./provider-registry.js";

const rawProviderThreadIdParamsSchema = z
  .object({
    threadId: z.string().optional(),
  })
  .passthrough();

export interface ReplayRawProviderEventsArgs {
  bbThreadId: string;
  providerId: string;
  rawProviderEvents: AgentRuntimeRawProviderEventCaptureEntry[];
}

export interface ReplayRawProviderEventTranslatorArgs {
  bbThreadId: string;
  providerId: string;
}

export interface ReplayRawProviderEventTranslator {
  translate(
    rawProviderEvent: AgentRuntimeRawProviderEventCaptureEntry,
  ): AgentRuntimeTranslatedThreadEventCaptureEntry[];
}

interface StampTranslatedEventArgs {
  event: ThreadEvent;
  bbThreadId: string;
  providerThreadId: string | undefined;
  sourceThreadId: string | undefined;
}

function getThreadIdFromParams(
  rawEvent: AgentRuntimeRawProviderEventCaptureEntry["rawEvent"],
): string | undefined {
  const parsedParams = rawProviderThreadIdParamsSchema.safeParse(
    rawEvent.params,
  );
  return parsedParams.success ? parsedParams.data.threadId : undefined;
}

function resolveStampedProviderThreadId(
  args: StampTranslatedEventArgs,
): string | undefined {
  if (args.providerThreadId) {
    return args.providerThreadId;
  }

  if (
    args.sourceThreadId &&
    args.sourceThreadId !== args.bbThreadId &&
    args.event.type !== "thread/identity"
  ) {
    return args.sourceThreadId;
  }

  return "providerThreadId" in args.event
    ? (args.event.providerThreadId ?? undefined)
    : undefined;
}

function stampTranslatedEvent(args: StampTranslatedEventArgs): ThreadEvent {
  const providerThreadId = resolveStampedProviderThreadId(args);
  if ("providerThreadId" in args.event && providerThreadId !== undefined) {
    return {
      ...args.event,
      providerThreadId,
      threadId: args.bbThreadId,
    };
  }

  return {
    ...args.event,
    threadId: args.bbThreadId,
  };
}

export function createReplayRawProviderEventTranslator(
  args: ReplayRawProviderEventTranslatorArgs,
): ReplayRawProviderEventTranslator {
  const adapter = createProviderForId(args.providerId);
  let providerThreadId: string | undefined;

  return {
    translate(rawProviderEvent) {
      const translated: AgentRuntimeTranslatedThreadEventCaptureEntry[] = [];
      const sourceThreadId =
        rawProviderEvent.sourceThreadId ??
        getThreadIdFromParams(rawProviderEvent.rawEvent);
      const events = adapter.translateEvent(rawProviderEvent.rawEvent, {
        threadId: sourceThreadId,
      });

      for (const event of events) {
        const candidateProviderThreadId =
          event.type === "thread/identity"
            ? event.providerThreadId
            : providerThreadId;
        const stampedEvent = stampTranslatedEvent({
          event,
          bbThreadId: args.bbThreadId,
          providerThreadId: candidateProviderThreadId,
          sourceThreadId,
        });

        if (
          stampedEvent.type === "thread/identity" &&
          stampedEvent.providerThreadId.length > 0
        ) {
          providerThreadId = stampedEvent.providerThreadId;
        }

        translated.push({
          kind: "translated-thread-event",
          capturedAt: rawProviderEvent.capturedAt,
          providerId: rawProviderEvent.providerId,
          rawCaptureId: rawProviderEvent.captureId,
          rawMethod: rawProviderEvent.rawEvent.method,
          event: stampedEvent,
        });
      }

      return translated;
    },
  };
}

export function replayRawProviderEvents(
  args: ReplayRawProviderEventsArgs,
): AgentRuntimeTranslatedThreadEventCaptureEntry[] {
  const translator = createReplayRawProviderEventTranslator(args);
  return args.rawProviderEvents.flatMap((rawProviderEvent) =>
    translator.translate(rawProviderEvent),
  );
}
