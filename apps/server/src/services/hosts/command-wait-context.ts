import { AsyncLocalStorage } from "node:async_hooks";
import type { HostDaemonCommandType } from "@bb/host-daemon-contract";
import type { ServerLogger } from "../../types.js";

export type DaemonCommandWaitOperation = "queue-and-wait" | "wait";

export interface DaemonCommandWaitForbiddenContext {
  reason: string;
}

export interface RunWithDaemonCommandWaitForbiddenArgs<TValue> {
  reason: string;
  work: () => TValue;
}

export interface RunWithDaemonCommandWaitAllowedArgs<TValue> {
  work: () => TValue;
}

export interface AssertDaemonCommandWaitAllowedArgs {
  commandId: string | null;
  commandType: HostDaemonCommandType;
  operation: DaemonCommandWaitOperation;
}

export interface ScheduleAfterDaemonIngressResponseArgs {
  context?: Record<string, boolean | number | string | null | undefined>;
  logger: Pick<ServerLogger, "warn">;
  name: string;
  work: () => Promise<void>;
}

export class DaemonCommandWaitForbiddenError extends Error {
  constructor(
    readonly context: DaemonCommandWaitForbiddenContext,
    readonly command: AssertDaemonCommandWaitAllowedArgs,
  ) {
    super(buildDaemonCommandWaitForbiddenMessage(context, command));
    this.name = "DaemonCommandWaitForbiddenError";
  }
}

const daemonCommandWaitContext =
  new AsyncLocalStorage<DaemonCommandWaitForbiddenContext>();

function buildDaemonCommandWaitForbiddenMessage(
  context: DaemonCommandWaitForbiddenContext,
  command: AssertDaemonCommandWaitAllowedArgs,
): string {
  const commandIdDetail = command.commandId
    ? ` command ${command.commandId}`
    : "";
  return `Daemon command ${command.operation}${commandIdDetail} for ${command.commandType} is forbidden in ${context.reason}`;
}

/**
 * Daemon ingress handlers must not wait for daemon commands, because the
 * command result needs a daemon ingress route to be acknowledged.
 */
export function runWithDaemonCommandWaitForbidden<TValue>(
  args: RunWithDaemonCommandWaitForbiddenArgs<TValue>,
): TValue {
  return daemonCommandWaitContext.run({ reason: args.reason }, args.work);
}

/**
 * Scheduled lifecycle work may run outside daemon-ingress handlers, even when
 * it was requested while handling a daemon POST.
 */
export function runWithDaemonCommandWaitAllowed<TValue>(
  args: RunWithDaemonCommandWaitAllowedArgs<TValue>,
): TValue {
  return daemonCommandWaitContext.exit(args.work);
}

export function scheduleAfterDaemonIngressResponse(
  args: ScheduleAfterDaemonIngressResponseArgs,
): void {
  runWithDaemonCommandWaitAllowed({
    work: () => {
      setImmediate(() => {
        void args.work().catch((error) => {
          args.logger.warn(
            {
              ...args.context,
              err: error,
            },
            `${args.name} failed`,
          );
        });
      });
    },
  });
}

export function assertDaemonCommandWaitAllowed(
  args: AssertDaemonCommandWaitAllowedArgs,
): void {
  const context = daemonCommandWaitContext.getStore();
  if (!context) {
    return;
  }
  throw new DaemonCommandWaitForbiddenError(context, args);
}
