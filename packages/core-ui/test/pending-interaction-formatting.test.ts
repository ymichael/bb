import { describe, expect, it } from "vitest";
import {
  formatPendingInteractionCommandApprovalResolutionMessage,
  formatPendingInteractionCommandApprovalResolutionOutcome,
  formatPendingInteractionFileChangeApprovalResolutionMessage,
  formatPendingInteractionFileChangeApprovalResolutionOutcome,
  formatPendingInteractionPermissionResolutionMessage,
  formatPendingInteractionPermissionResolutionOutcome,
  summarizePendingInteractionRequestedPermissions,
} from "../src/index.js";

describe("pending interaction formatting", () => {
  it("summarizes requested permissions consistently", () => {
    expect(
      summarizePendingInteractionRequestedPermissions({
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/read-a", "/tmp/read-b"],
          write: ["/tmp/write-a"],
        },
        macos: {
          preferences: "read_only",
          automations: "all",
          launchServices: true,
          accessibility: false,
          calendar: false,
          reminders: true,
          contacts: "none",
        },
      }),
    ).toEqual([
      "Network access",
      "Read 2 paths",
      "Write 1 path",
      "macOS launch services",
      "macOS reminders",
      "macOS preferences (read only)",
      "macOS automation (all apps)",
    ]);
  });

  it("formats approval outcomes and timeline messages consistently", () => {
    expect(formatPendingInteractionCommandApprovalResolutionOutcome("accept_for_session")).toBe(
      "approved for this session",
    );
    expect(
      formatPendingInteractionCommandApprovalResolutionOutcome({
        kind: "accept_with_exec_policy_amendment",
        execPolicyAmendment: ["allow", "git", "push"],
      }),
    ).toBe("approved with exec policy amendment");
    expect(formatPendingInteractionCommandApprovalResolutionMessage("cancel")).toBe(
      "Command request cancelled",
    );
    expect(formatPendingInteractionFileChangeApprovalResolutionOutcome("decline")).toBe(
      "denied",
    );
    expect(formatPendingInteractionFileChangeApprovalResolutionMessage("accept")).toBe(
      "File changes approved",
    );
    expect(
      formatPendingInteractionPermissionResolutionOutcome({
        kind: "permission_request",
        decision: "deny",
      }),
    ).toBe("denied");
    expect(
      formatPendingInteractionPermissionResolutionMessage({
        kind: "permission_request",
        decision: "allow",
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
        scope: "session",
      }),
    ).toBe("Permissions granted for this session");
  });
});
