import { describe, expect, it } from "vitest";
import {
  pendingInteractionMacOsPermissionsSchema,
  pendingInteractionCreateSchema,
  pendingInteractionSchema,
} from "../src/index.js";

describe("pending interaction schemas", () => {
  it("parses semantic command approval interactions", () => {
    expect(
      pendingInteractionCreateSchema.parse({
        threadId: "thr_123",
        turnId: "turn_123",
        providerId: "codex",
        providerThreadId: "provider-thread-123",
        providerRequestId: "request-123",
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "item_123",
            command: "npm install",
            cwd: "/tmp/project",
            actions: [],
            sessionGrant: {
              network: { enabled: true },
              fileSystem: null,
            },
          },
          reason: "Needs network access",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
      }),
    ).toMatchObject({
      providerId: "codex",
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
        },
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("parses semantic file-change approvals without diff fields", () => {
    expect(
      pendingInteractionCreateSchema.parse({
        threadId: "thr_124",
        turnId: "turn_124",
        providerId: "codex",
        providerThreadId: "provider-thread-124",
        providerRequestId: "request-124",
        payload: {
          kind: "approval",
          subject: {
            kind: "file_change",
            itemId: "item_124",
            writeScope: { root: "/tmp/project" },
            sessionGrant: null,
          },
          reason: "Review file edits",
          availableDecisions: ["allow_once", "deny"],
        },
      }),
    ).toMatchObject({
      payload: {
        subject: {
          kind: "file_change",
          itemId: "item_124",
        },
      },
    });
  });

  it("parses semantic permission grant approval resolutions", () => {
    expect(
      pendingInteractionSchema.parse({
        id: "pi_125",
        threadId: "thr_125",
        turnId: "turn_125",
        providerId: "claude-code",
        providerThreadId: "provider-thread-125",
        providerRequestId: "request-125",
        status: "resolved",
        payload: {
          kind: "approval",
          subject: {
            kind: "permission_grant",
            itemId: "item_125",
            toolName: "WebFetch",
            permissions: {
              network: {
                enabled: true,
              },
              fileSystem: null,
            },
          },
          reason: null,
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          kind: "approval",
          decision: "allow_for_session",
          grantedPermissions: {
            network: {
              enabled: true,
            },
            fileSystem: null,
          },
        },
        statusReason: null,
        createdAt: 1,
        resolvedAt: 2,
      }),
    ).toMatchObject({
      resolution: {
        kind: "approval",
        decision: "allow_for_session",
      },
    });
  });

  it("rejects invalid macOS automation permission values", () => {
    expect(() =>
      pendingInteractionMacOsPermissionsSchema.parse({
        preferences: "none",
        automations: "invalid",
        launchServices: false,
        accessibility: false,
        calendar: false,
        reminders: false,
        contacts: "none",
      }),
    ).toThrow();
  });
});
