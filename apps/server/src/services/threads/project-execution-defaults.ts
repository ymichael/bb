import { upsertProjectExecutionDefaults } from "@bb/db";
import type { ResolvedThreadExecutionOptions, Thread } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import type { ThreadCreateServiceRequest } from "./thread-create-request.js";

export interface RememberProjectExecutionDefaultsForThreadArgs {
  execution: ResolvedThreadExecutionOptions;
  thread: Pick<Thread, "automationId" | "projectId" | "providerId" | "type">;
}

export interface RememberProjectExecutionDefaultsForCreateArgs {
  execution: ResolvedThreadExecutionOptions;
  request: ThreadCreateServiceRequest;
}

function shouldRememberProjectExecutionDefaults(args: {
  automationId: string | null;
  type: "manager" | "standard";
}): boolean {
  return args.type === "standard" && args.automationId === null;
}

export function rememberProjectExecutionDefaultsForThread(
  deps: Pick<AppDeps, "db">,
  args: RememberProjectExecutionDefaultsForThreadArgs,
): void {
  if (!shouldRememberProjectExecutionDefaults(args.thread)) {
    return;
  }

  upsertProjectExecutionDefaults(deps.db, {
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    ...args.execution,
  });
}

export function rememberProjectExecutionDefaultsForCreate(
  deps: Pick<AppDeps, "db">,
  args: RememberProjectExecutionDefaultsForCreateArgs,
): void {
  if (!shouldRememberProjectExecutionDefaults(args.request)) {
    return;
  }

  upsertProjectExecutionDefaults(deps.db, {
    projectId: args.request.projectId,
    providerId: args.request.providerId,
    ...args.execution,
  });
}
