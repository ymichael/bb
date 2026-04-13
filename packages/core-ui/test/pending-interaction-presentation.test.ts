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
        kind: "approval",
        surface: "app",
      }),
    ).toBe("Approval");
    expect(
      formatPendingInteractionKindLabel({
        kind: "approval",
        surface: "cli",
      }),
    ).toBe("approval");
  });

  it("formats command approval summaries differently per surface", () => {
    const interaction = createInteraction({
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item_123",
        command: "npm publish",
        cwd: "/tmp/project",
        actions: [],
        sessionGrant: null,
      },
      reason: "Needs approval to publish",
      availableDecisions: ["allow_once", "deny"],
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
    ).toBe("Needs approval to publish");
  });

  it("formats permission request summaries differently per surface", () => {
    const interaction = createInteraction({
      kind: "approval",
      subject: {
        kind: "permission_grant",
        itemId: "item_123",
        toolName: "WebFetch",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/tmp/a", "/tmp/b"],
            write: [],
          },
        },
      },
      reason: null,
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
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

});
