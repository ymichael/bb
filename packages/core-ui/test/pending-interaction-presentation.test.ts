import { describe, expect, it } from "vitest";
import type { PendingInteraction } from "@bb/domain";
import {
  formatPendingInteractionKindLabel,
  formatPendingInteractionSummary,
} from "../src/pending-interaction-presentation.js";

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
    providerRequestMethod: "interactive/request",
    status: "pending",
    payload,
    resolution: null,
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

describe("pending interaction presentation", () => {
  it("formats kind labels for app and cli surfaces", () => {
    expect(
      formatPendingInteractionKindLabel({
        kind: "command_approval",
        surface: "app",
      }),
    ).toBe("Command approval");
    expect(
      formatPendingInteractionKindLabel({
        kind: "command_approval",
        surface: "cli",
      }),
    ).toBe("command");
  });

  it("formats command approval summaries differently per surface", () => {
    const interaction = createInteraction({
      kind: "command_approval",
      itemId: "item_123",
      approvalId: null,
      reason: "Needs approval to publish",
      command: "npm publish",
      cwd: "/tmp/project",
      commandActions: [],
      requestedPermissions: null,
      availableDecisions: ["accept", "decline", "cancel"],
    });

    expect(
      formatPendingInteractionSummary({
        interaction,
        surface: "app",
      }),
    ).toBe("Needs approval to publish");
    expect(
      formatPendingInteractionSummary({
        interaction,
        surface: "cli",
      }),
    ).toBe("npm publish");
  });

  it("formats permission request summaries differently per surface", () => {
    const interaction = createInteraction({
      kind: "permission_request",
      itemId: "item_123",
      reason: null,
      toolName: "WebFetch",
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/a", "/tmp/b"],
          write: [],
        },
        macos: null,
      },
    });

    expect(
      formatPendingInteractionSummary({
        interaction,
        surface: "app",
      }),
    ).toBe("Network access . Read 2 paths");
    expect(
      formatPendingInteractionSummary({
        interaction,
        surface: "cli",
      }),
    ).toBe("WebFetch");
  });

  it("formats single-question user input summaries differently per surface", () => {
    const interaction = createInteraction({
      kind: "user_input_request",
      itemId: "item_123",
      questions: [
        {
          id: "environment",
          header: "Environment",
          question: "Which environment should I use?",
          allowsOther: true,
          isSecret: false,
          multiSelect: false,
          options: [],
        },
      ],
    });

    expect(
      formatPendingInteractionSummary({
        interaction,
        surface: "app",
      }),
    ).toBe("Which environment should I use?");
    expect(
      formatPendingInteractionSummary({
        interaction,
        surface: "cli",
      }),
    ).toBe("1 question(s)");
  });
});
