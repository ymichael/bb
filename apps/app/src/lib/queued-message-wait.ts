import type { QueuedMessagePayload, QueuedMessageWaitingOn } from "@bb/domain";
import type { IconName } from "@bb/shared-ui/icon";
import { formatScheduledTime } from "@/lib/relative-time";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatQueuedMessageCountdown(
  remainingMs: number,
): string | null {
  if (remainingMs <= 0) return null;
  if (remainingMs < MINUTE_MS) {
    return `in ${Math.ceil(remainingMs / 1000)}s`;
  }
  if (remainingMs < HOUR_MS) {
    return `in ${Math.floor(remainingMs / MINUTE_MS)}m`;
  }
  if (remainingMs < DAY_MS) {
    return `in ${Math.floor(remainingMs / HOUR_MS)}h`;
  }
  return `in ${Math.floor(remainingMs / DAY_MS)}d`;
}

export function isQueuedMessageSendNowAllowed(
  waitingOn: QueuedMessageWaitingOn | null,
): boolean {
  if (waitingOn === null) return true;
  switch (waitingOn.kind) {
    case "provisioning":
    case "host-offline":
    case "interaction":
    case "turn-starting":
      return false;
    case "time":
    case "plugin":
    case "thread-busy":
      return true;
  }
}

export function queuedMessageHasWaitLine(args: {
  failureReason: string | null;
  payload: QueuedMessagePayload;
  waitingOn: QueuedMessageWaitingOn | null;
}): boolean {
  if (args.failureReason !== null) return true;
  if (args.payload.kind === "retry") return true;
  if (args.waitingOn === null) return false;
  return args.waitingOn.kind !== "thread-busy";
}

export function queuedMessageWaitIcon(args: {
  failureReason: string | null;
  payload: QueuedMessagePayload;
  waitingOn: QueuedMessageWaitingOn | null;
}): IconName | null {
  if (args.failureReason !== null) return "AlertCircle";
  if (args.payload.kind === "retry") return "RotateCcw";
  if (args.waitingOn === null) return null;
  switch (args.waitingOn.kind) {
    case "thread-busy":
      return null;
    case "turn-starting":
      return "TimeSchedule";
    case "time":
      return "TimeSchedule";
    case "provisioning":
      return "Folder";
    case "host-offline":
      return "CloudOff";
    case "interaction":
      return "CircleQuestion";
    case "plugin":
      return "Limitation";
  }
}

export interface DescribeQueuedMessageWaitArgs {
  failureReason: string | null;
  now: number;
  payload: QueuedMessagePayload;
  pluginDisplayName: string | null;
  sendAt: number | null;
  waitingOn: QueuedMessageWaitingOn | null;
}

export function queuedMessageFallbackTitle(args: {
  createdAt: number;
  now: number;
  payload: QueuedMessagePayload;
}): string {
  if (args.payload.kind !== "retry") return "Queued message";
  return `Retry failed turn from ${formatScheduledTime({
    now: args.now,
    timestamp: args.createdAt,
  })}`;
}

export function describeQueuedMessageWait(
  args: DescribeQueuedMessageWaitArgs,
): string | null {
  if (args.failureReason !== null) return args.failureReason;

  if (args.payload.kind === "retry") {
    const parts: string[] = [args.payload.reason];
    if (args.waitingOn?.kind === "plugin") {
      parts.push(
        `held by ${args.pluginDisplayName ?? args.waitingOn.pluginId} · ${args.waitingOn.reason}`,
      );
    }
    if (args.sendAt !== null) {
      parts.push(
        `retrying at ${formatScheduledTime({ now: args.now, timestamp: args.sendAt })}`,
      );
    }
    parts.push(`attempt ${args.payload.attempt}`);
    return parts.join(" · ");
  }

  if (!queuedMessageHasWaitLine(args)) return null;
  if (args.waitingOn === null) return null;
  switch (args.waitingOn.kind) {
    case "thread-busy":
      return null;
    case "turn-starting":
      return "Waiting for turn to start";
    case "time":
      return args.sendAt === null
        ? "Scheduled"
        : `Scheduled for ${formatScheduledTime({ now: args.now, timestamp: args.sendAt })}`;
    case "provisioning":
      return "Waiting for workspace";
    case "host-offline":
      return `Waiting for ${args.waitingOn.hostName} to reconnect`;
    case "interaction":
      return "Waiting for your reply";
    case "plugin":
      return `Held by ${args.pluginDisplayName ?? args.waitingOn.pluginId} · ${args.waitingOn.reason}`;
  }
}

export function queuedMessageCountdownInstant(args: {
  payload: QueuedMessagePayload;
  sendAt: number | null;
  waitingOn: QueuedMessageWaitingOn | null;
}): number | null {
  if (args.payload.kind === "retry") return null;
  if (args.waitingOn === null || args.waitingOn.kind !== "time") return null;
  return args.sendAt;
}
