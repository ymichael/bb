import { describe, expect, it } from "vitest";
import {
  getCommandExitCodeLine,
  getPermissionGrantDisplayStatus,
  getTimelineDisplayStatus,
  getTimelineDisplayStatusInfo,
  hasVisibleCommandOutput,
  timelineDisplayStatusValues,
} from "../src/timeline-display-status.js";

describe("timeline display status", () => {
  it("treats empty and whitespace-only command output as empty", () => {
    expect(hasVisibleCommandOutput("")).toBe(false);
    expect(hasVisibleCommandOutput(" \n\t ")).toBe(false);
    expect(hasVisibleCommandOutput("FIRST\n")).toBe(true);
  });

  it("derives waiting and denied before execution status", () => {
    expect(
      getTimelineDisplayStatus({
        approvalStatus: "waiting_for_approval",
        status: "pending",
      }),
    ).toBe("waiting");
    expect(
      getTimelineDisplayStatus({
        approvalStatus: "denied",
        status: "completed",
      }),
    ).toBe("denied");
    expect(
      getTimelineDisplayStatus({
        approvalStatus: "denied",
        preferRunningLabel: true,
        status: "completed",
      }),
    ).toBe("denied");
  });

  it("shares CLI and React presentation metadata for every display status", () => {
    expect(
      timelineDisplayStatusValues.map((status) => ({
        cliLabel: getTimelineDisplayStatusInfo(status).cliLabel,
        reactLabel: getTimelineDisplayStatusInfo(status).reactLabel,
        status,
        tone: getTimelineDisplayStatusInfo(status).cliTone,
      })),
    ).toEqual([
      {
        cliLabel: "[waiting]",
        reactLabel: "Waiting for approval to run",
        status: "waiting",
        tone: "warning",
      },
      {
        cliLabel: "[denied]",
        reactLabel: "Permission denied:",
        status: "denied",
        tone: "danger",
      },
      {
        cliLabel: "[running]",
        reactLabel: "Running",
        status: "running",
        tone: "warning",
      },
      {
        cliLabel: "[completed]",
        reactLabel: "Completed",
        status: "completed",
        tone: "success",
      },
      {
        cliLabel: "[failed]",
        reactLabel: "Failed",
        status: "failed",
        tone: "danger",
      },
      {
        cliLabel: "[interrupted]",
        reactLabel: "Interrupted",
        status: "interrupted",
        tone: "warning",
      },
    ]);
  });

  it("treats pending permission grants as waiting", () => {
    expect(getPermissionGrantDisplayStatus("pending")).toBe("waiting");
    expect(getPermissionGrantDisplayStatus("completed")).toBe("completed");
    expect(getPermissionGrantDisplayStatus("error")).toBe("failed");
    expect(getPermissionGrantDisplayStatus("interrupted")).toBe("interrupted");
  });

  it("shows exit code 0 only for silent successful commands", () => {
    expect(
      getCommandExitCodeLine({
        displayStatus: "completed",
        exitCode: 0,
        hasVisibleOutput: false,
      }),
    ).toBe("exit code 0");
    expect(
      getCommandExitCodeLine({
        displayStatus: "completed",
        exitCode: 0,
        hasVisibleOutput: true,
      }),
    ).toBeUndefined();
  });

  it("keeps non-zero exit codes for failed and interrupted commands", () => {
    expect(
      getCommandExitCodeLine({
        displayStatus: "failed",
        exitCode: 1,
        hasVisibleOutput: false,
      }),
    ).toBe("exit code 1");
    expect(
      getCommandExitCodeLine({
        displayStatus: "interrupted",
        exitCode: 130,
        hasVisibleOutput: false,
      }),
    ).toBe("exit code 130");
  });
});
