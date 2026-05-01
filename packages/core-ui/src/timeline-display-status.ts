import type {
  ViewApprovalLifecycleStatus,
  ViewMessageStatus,
  ViewPermissionGrantLifecycleMessage,
} from "@bb/domain";

export const timelineDisplayStatusValues = [
  "waiting",
  "denied",
  "running",
  "completed",
  "failed",
  "interrupted",
] as const;

export type TimelineDisplayStatus =
  (typeof timelineDisplayStatusValues)[number];

export type TimelineDisplayStatusTone = "success" | "warning" | "danger";

type TimelineLifecycleStatus = Extract<
  ViewMessageStatus,
  "pending" | "completed" | "error" | "interrupted"
>;

type PermissionGrantLifecycleStatus =
  ViewPermissionGrantLifecycleMessage["status"];

export interface TimelineDisplayStatusArgs {
  approvalStatus?: ViewApprovalLifecycleStatus | null;
  preferRunningLabel?: boolean;
  status: TimelineLifecycleStatus;
}

export interface TimelineDisplayStatusInfo {
  cliLabel: string;
  cliTone: TimelineDisplayStatusTone;
  reactLabel: string;
}

export interface CommandExitCodeLineArgs {
  displayStatus: TimelineDisplayStatus;
  exitCode: number | null;
  hasVisibleOutput: boolean;
}

export interface CommandOutputTextArgs {
  displayStatus: TimelineDisplayStatus;
  exitCode: number | null;
  output: string;
}

const timelineDisplayStatusInfo = {
  waiting: {
    cliLabel: "[waiting]",
    cliTone: "warning",
    reactLabel: "Waiting for approval to run",
  },
  denied: {
    cliLabel: "[denied]",
    cliTone: "danger",
    reactLabel: "Permission denied:",
  },
  running: {
    cliLabel: "[running]",
    cliTone: "warning",
    reactLabel: "Running",
  },
  completed: {
    cliLabel: "[completed]",
    cliTone: "success",
    reactLabel: "Completed",
  },
  failed: {
    cliLabel: "[failed]",
    cliTone: "danger",
    reactLabel: "Failed",
  },
  interrupted: {
    cliLabel: "[interrupted]",
    cliTone: "warning",
    reactLabel: "Interrupted",
  },
} satisfies Record<TimelineDisplayStatus, TimelineDisplayStatusInfo>;

export function getTimelineDisplayStatus(
  args: TimelineDisplayStatusArgs,
): TimelineDisplayStatus {
  if (args.approvalStatus === "waiting_for_approval") {
    return "waiting";
  }
  if (args.approvalStatus === "denied") {
    return "denied";
  }
  if (args.preferRunningLabel) {
    return "running";
  }

  switch (args.status) {
    case "pending":
      return "running";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
  }
}

export function getPermissionGrantDisplayStatus(
  status: PermissionGrantLifecycleStatus,
): TimelineDisplayStatus {
  if (status === "pending") {
    return "waiting";
  }
  return getTimelineDisplayStatus({ status });
}

export function getTimelineDisplayStatusInfo(
  status: TimelineDisplayStatus,
): TimelineDisplayStatusInfo {
  return timelineDisplayStatusInfo[status];
}

export function hasVisibleCommandOutput(output: string): boolean {
  return output.trim().length !== 0;
}

export function getVisibleCommandOutput(output: string): string | undefined {
  if (!hasVisibleCommandOutput(output)) {
    return undefined;
  }
  return output;
}

export function getCommandExitCodeLine(
  args: CommandExitCodeLineArgs,
): string | undefined {
  switch (args.displayStatus) {
    case "waiting":
    case "denied":
    case "running":
      return undefined;
    case "completed":
      if (args.exitCode === null) {
        return undefined;
      }
      if (args.exitCode === 0 && args.hasVisibleOutput) {
        return undefined;
      }
      return `exit code ${args.exitCode}`;
    case "failed":
    case "interrupted":
      if (args.exitCode === null) {
        return undefined;
      }
      return `exit code ${args.exitCode}`;
  }
}

export function formatCommandOutputText(
  args: CommandOutputTextArgs,
): string | undefined {
  const output = getVisibleCommandOutput(args.output);
  const exitCodeLine = getCommandExitCodeLine({
    displayStatus: args.displayStatus,
    exitCode: args.exitCode,
    hasVisibleOutput: output !== undefined,
  });

  if (output && exitCodeLine) {
    const trimmedOutput = output.trimEnd();
    return trimmedOutput.length > 0
      ? `${trimmedOutput}\n\n${exitCodeLine}`
      : exitCodeLine;
  }

  return output ?? exitCodeLine;
}
