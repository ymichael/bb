import { describe, expect, it } from "vitest";
import type { PendingInteraction } from "@bb/domain";
import {
  buildPendingInteractionApprovalResolution,
  formatPendingInteractionCommandApprovalResolutionMessage,
  formatPendingInteractionCommandApprovalResolutionOutcome,
  formatPendingInteractionFileChangeApprovalResolutionMessage,
  formatPendingInteractionFileChangeApprovalResolutionOutcome,
  formatPendingInteractionPermissionResolutionMessage,
  formatPendingInteractionPermissionResolutionOutcome,
  formatPendingInteractionSubjectDetailLines,
  summarizePendingInteractionRequestedPermissions,
} from "../src/index.js";

function createInteraction(
  payload: PendingInteraction["payload"],
): PendingInteraction {
  return {
    id: "pint_123456789a",
    threadId: "thr_123",
    turnId: "turn_123",
    providerId: "codex",
    providerThreadId: "provider-thread-123",
    providerRequestId: "request-123",
    status: "pending",
    payload,
    resolution: null,
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

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
    expect(formatPendingInteractionCommandApprovalResolutionOutcome("allow_for_session")).toBe(
      "approved for this session",
    );
    expect(formatPendingInteractionCommandApprovalResolutionMessage("deny")).toBe(
      "Command denied",
    );
    expect(formatPendingInteractionFileChangeApprovalResolutionOutcome("deny")).toBe(
      "denied",
    );
    expect(formatPendingInteractionFileChangeApprovalResolutionMessage("allow_once")).toBe(
      "File changes approved",
    );
    expect(
      formatPendingInteractionPermissionResolutionOutcome({
        kind: "approval",
        decision: "deny",
      }),
    ).toBe("denied");
    expect(
      formatPendingInteractionPermissionResolutionMessage({
        kind: "approval",
        decision: "allow_for_session",
        grantedPermissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      }),
    ).toBe("Permissions granted for this session");
  });

  it("builds session approval resolutions with explicit command session grants", () => {
    const interaction = createInteraction({
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item_123",
        command: "curl https://example.com",
        cwd: "/tmp/project",
        actions: [{ type: "unknown", command: "curl https://example.com" }],
        sessionGrant: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
      reason: "Needs network",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    });

    expect(
      buildPendingInteractionApprovalResolution(interaction, "allow_for_session"),
    ).toEqual({
      kind: "approval",
      decision: "allow_for_session",
      grantedPermissions: {
        network: { enabled: true },
        fileSystem: null,
      },
    });

    expect(
      buildPendingInteractionApprovalResolution(interaction, "allow_once"),
    ).toEqual({
      kind: "approval",
      decision: "allow_once",
      grantedPermissions: null,
    });

    expect(formatPendingInteractionSubjectDetailLines(interaction)).toEqual([
      "Command: curl https://example.com",
      "Cwd: /tmp/project",
      "Action: curl https://example.com",
      "Session grant: Network access",
    ]);
  });

  it("builds approval resolutions with explicit permission-grant permissions", () => {
    const interaction = createInteraction({
      kind: "approval",
      subject: {
        kind: "permission_grant",
        itemId: "item_123",
        toolName: "WebFetch",
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
      reason: "Needs network",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    });

    expect(
      buildPendingInteractionApprovalResolution(interaction, "allow_once"),
    ).toEqual({
      kind: "approval",
      decision: "allow_once",
      grantedPermissions: {
        network: { enabled: true },
        fileSystem: null,
      },
    });
  });
});
