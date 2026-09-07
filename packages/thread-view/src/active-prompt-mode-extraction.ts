import {
  promptInputHasCommandMention,
  requireThreadEventScopeTurnId,
  removeCommandMentionsFromPromptInput,
  type ProviderComposerCommand,
  type Thread,
  type ThreadTimelineActivePromptMode,
} from "@bb/domain";
import type { ThreadEventWithMeta } from "./build-event-projection.js";
import { parsePromptInput } from "./user-message-parsing.js";

export type PlanCommand = Pick<ProviderComposerCommand, "trigger" | "name">;

interface ActiveTurnInput {
  request: Extract<
    ThreadEventWithMeta["event"],
    { type: "client/turn/requested" }
  >;
  seq: number;
  turnId: string;
}

export interface ThreadTimelineActivePlanTurn {
  promptMode: ThreadTimelineActivePromptMode;
  turnId: string;
}

function promptTextWithoutPlanCommand(
  request: ActiveTurnInput["request"],
  planCommand: PlanCommand,
): string {
  const cleanedInput = removeCommandMentionsFromPromptInput(
    request.input,
    planCommand,
  );
  return parsePromptInput(cleanedInput)?.text.trim() ?? "";
}

function extractActiveTurnInputs(
  events: readonly ThreadEventWithMeta[],
): ActiveTurnInput[] {
  const requestsById = new Map<
    string,
    Extract<ThreadEventWithMeta["event"], { type: "client/turn/requested" }>
  >();
  const completedTurnIds = new Set<string>();
  let latestThreadInterruptionSeq = -1;

  for (const { event, meta } of events) {
    if (event.type === "client/turn/requested") {
      requestsById.set(event.requestId, event);
      continue;
    }
    if (event.type === "turn/completed") {
      completedTurnIds.add(
        requireThreadEventScopeTurnId({
          type: event.type,
          scope: event.scope,
        }),
      );
      continue;
    }
    if (event.type === "system/thread/interrupted") {
      latestThreadInterruptionSeq = Math.max(
        latestThreadInterruptionSeq,
        meta.seq,
      );
    }
  }

  return events.flatMap(({ event, meta }) => {
    if (event.type !== "turn/input/accepted") {
      return [];
    }
    if (meta.seq <= latestThreadInterruptionSeq) {
      return [];
    }
    const turnId = requireThreadEventScopeTurnId({
      type: event.type,
      scope: event.scope,
    });
    if (completedTurnIds.has(turnId)) {
      return [];
    }
    const request = requestsById.get(event.clientRequestId);
    return request ? [{ request, seq: meta.seq, turnId }] : [];
  });
}

export function extractThreadTimelineActivePlanTurn({
  events,
  planCommand,
  providerId,
  threadStatus,
}: {
  events: readonly ThreadEventWithMeta[];
  planCommand: PlanCommand | null | undefined;
  providerId: string | undefined;
  threadStatus: Thread["status"];
}): ThreadTimelineActivePlanTurn | null {
  if (
    threadStatus !== "active" ||
    providerId === undefined ||
    planCommand === null ||
    planCommand === undefined
  ) {
    return null;
  }

  let latestPlanTurn: ActiveTurnInput | null = null;
  for (const activeTurn of extractActiveTurnInputs(events)) {
    if (!promptInputHasCommandMention(activeTurn.request.input, planCommand)) {
      continue;
    }
    if (!latestPlanTurn || activeTurn.seq > latestPlanTurn.seq) {
      latestPlanTurn = activeTurn;
    }
  }

  return latestPlanTurn
    ? {
        promptMode: {
          mode: "plan",
          providerId,
          prompt: promptTextWithoutPlanCommand(
            latestPlanTurn.request,
            planCommand,
          ),
        },
        turnId: latestPlanTurn.turnId,
      }
    : null;
}

export function extractThreadTimelineActivePromptMode(
  args: Parameters<typeof extractThreadTimelineActivePlanTurn>[0],
): ThreadTimelineActivePromptMode | null {
  return extractThreadTimelineActivePlanTurn(args)?.promptMode ?? null;
}
