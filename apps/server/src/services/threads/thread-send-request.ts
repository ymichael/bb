import { isStandaloneBuiltinClearCommand, type Thread } from "@bb/domain";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { sendThreadMessage } from "./thread-send.js";

interface AcceptThreadSendRequestArgs {
  payload: SendMessageRequest;
  thread: Thread;
}

export async function acceptThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  if (isStandaloneBuiltinClearCommand(args.payload.input)) {
    const environment = await requireThreadCommandEnvironment(deps, {
      thread: args.thread,
    });
    await sendThreadMessage(deps, {
      environment,
      payload: args.payload,
      thread: args.thread,
      trigger: "user",
    });
    return { ok: true, delivery: "sent" };
  }

  const outcome = await attemptDispatch(deps, {
    thread: args.thread,
    payload: args.payload,
    source: { kind: "inline" },
    queuePayload: { kind: "inline" },
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    trigger: "user",
  });
  if (outcome.kind === "dispatched") {
    return { ok: true, delivery: "sent" };
  }
  return {
    ok: true,
    delivery: "queued",
    queuedMessage: outcome.entry,
  };
}
