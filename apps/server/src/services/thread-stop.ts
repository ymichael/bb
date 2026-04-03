import { markThreadStopRequested } from "@bb/db";
import type { AppDeps } from "../types.js";
import { queueThreadStopCommand } from "./thread-commands.js";

export interface RequestThreadStopArgs {
  environmentId: string;
  hostId: string;
  stopRequestedAt: number | null;
  threadId: string;
}

export function requestThreadStop(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadStopArgs,
): void {
  if (args.stopRequestedAt === null) {
    markThreadStopRequested(deps.db, deps.hub, {
      threadId: args.threadId,
    });
  }

  queueThreadStopCommand(deps, {
    environmentId: args.environmentId,
    hostId: args.hostId,
    threadId: args.threadId,
  });
}
