import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import { CommandDispatchError, type CommandDispatchOptions, type CommandOf } from "../command-dispatch-support.js";

export async function resolveInteractiveRequest(
  command: CommandOf<"interactive.resolve">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"interactive.resolve">> {
  if (!options.resolveInteractiveRequest) {
    throw new CommandDispatchError(
      "interactive_request_resolution_unavailable",
      "Interactive request resolution is not available in this daemon",
    );
  }

  await options.resolveInteractiveRequest({
    interactionId: command.interactionId,
    providerId: command.providerId,
    providerRequestId: command.providerRequestId,
    providerThreadId: command.providerThreadId,
    resolution: command.resolution,
    threadId: command.threadId,
  });
  return {};
}
