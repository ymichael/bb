import { describe, expect, it } from "vitest";

import {
  buildCodexInteractiveResponse,
  decodeCodexInteractiveRequest,
  extractCodexMacOsPermissionRequest,
} from "./interactive-requests.js";
import { ProviderRequestDecodeError } from "@bb/provider-bridge-protocol/bridge-kit";

describe("decodeCodexInteractiveRequest", () => {
  it("maps command approval requests into pending interaction payloads", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [
            {
              type: "unknown",
              command: "git push",
            },
          ],
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: null,
            macos: null,
          },
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      }),
    ).toEqual({
      requestId: 8,
      method: "item/commandExecution/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-1",
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [
            {
              type: "unknown",
              command: "git push",
            },
          ],
          sessionGrant: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("omits command session approval without session grants", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 80,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      }),
    ).toEqual({
      requestId: 80,
      method: "item/commandExecution/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-1",
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [],
          sessionGrant: null,
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "deny"],
      },
    });
  });

  it("rejects empty command approval decisions as invalid params", () => {
    expect(() =>
      decodeCodexInteractiveRequest({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: [],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("maps cancel-only command approval decisions to deny", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: ["cancel"],
        },
      }),
    ).toMatchObject({
      payload: {
        availableDecisions: ["deny"],
      },
    });
  });

  it("keeps a command approval that asks for macOS permissions and surfaces the profile beside it", () => {
    const request = {
      id: 8,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "item-1",
        reason: "Needs approval",
        command: "osascript -e 'tell app \"Finder\" to activate'",
        cwd: "/tmp/project",
        commandActions: [],
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: null,
          macos: {
            preferences: "read_only",
            automations: {
              bundle_ids: ["com.apple.finder"],
            },
            launchServices: true,
            accessibility: true,
            calendar: false,
            reminders: false,
            contacts: "none",
          },
        },
        availableDecisions: ["accept", "acceptForSession", "decline"],
      },
    };

    const decoded = decodeCodexInteractiveRequest(request);
    expect(decoded?.payload).toMatchObject({
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-1",
        sessionGrant: { network: { enabled: true }, fileSystem: null },
      },
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    });

    expect(extractCodexMacOsPermissionRequest(request)).toEqual({
      providerThreadId: "t1",
      turnId: "turn-1",
      item: {
        approvalItemId: "item-1",
        reason: "Needs approval",
        permissions: {
          preferences: "read_only",
          automations: { kind: "bundle_ids", bundleIds: ["com.apple.finder"] },
          launchServices: true,
          accessibility: true,
          calendar: false,
          reminders: false,
          contacts: "none",
        },
      },
    });
  });

  it("extracts no macOS profile from approvals that carry none", () => {
    expect(
      extractCodexMacOsPermissionRequest({
        id: 81,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: null,
          command: "open -a Finder",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: { network: null, fileSystem: null },
          availableDecisions: ["accept", "decline"],
        },
      }),
    ).toBeNull();
    expect(
      extractCodexMacOsPermissionRequest({
        id: 82,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: null,
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      }),
    ).toBeNull();
  });

  it("ignores unsupported policy-amendment decisions when simple decisions remain", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 9,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-2",
          itemId: "item-2",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["allow", "git", "push"],
              },
            },
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
            "decline",
          ],
        },
      }),
    ).toMatchObject({
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          command: "git push",
        },
        availableDecisions: ["deny"],
      },
    });
  });

  it("rejects policy-amendment-only command approval decisions", () => {
    expect(() =>
      decodeCodexInteractiveRequest({
        id: 90,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-network-amendment",
          itemId: "item-network-amendment",
          reason: "Needs network policy approval",
          command: "curl https://api.openai.com",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["allow", "git", "push"],
              },
            },
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
          ],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("preserves deny when policy amendments are paired with cancel", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 91,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-network-amendment-deny",
          itemId: "item-network-amendment-deny",
          reason: "Needs network policy approval",
          command: "curl https://api.openai.com",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
            "cancel",
          ],
        },
      }),
    ).toMatchObject({
      payload: {
        availableDecisions: ["deny"],
      },
    });
  });

  it("maps file-change approvals into pending interactions", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 10,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-file-change",
          itemId: "item-file-change",
          reason: "Review generated file changes",
          grantRoot: "/tmp/project",
        },
      }),
    ).toEqual({
      requestId: 10,
      method: "item/fileChange/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-file-change",
      payload: {
        kind: "approval",
        subject: {
          kind: "file_change",
          itemId: "item-file-change",
          writeScope: "/tmp/project",
          sessionGrant: {
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          },
        },
        reason: "Review generated file changes",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("omits file-change session approval without grant root", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 11,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-file-change",
          itemId: "item-file-change",
          reason: "Review generated file changes",
          grantRoot: null,
        },
      }),
    ).toEqual({
      requestId: 11,
      method: "item/fileChange/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-file-change",
      payload: {
        kind: "approval",
        subject: {
          kind: "file_change",
          itemId: "item-file-change",
          writeScope: null,
          sessionGrant: null,
        },
        reason: "Review generated file changes",
        availableDecisions: ["allow_once", "deny"],
      },
    });
  });

  it("maps permission approvals into pending interactions", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 11,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-permissions",
          itemId: "item-permissions",
          reason: "Need network access",
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
      }),
    ).toEqual({
      requestId: 11,
      method: "item/permissions/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-permissions",
      payload: {
        kind: "approval",
        subject: {
          kind: "permission_grant",
          itemId: "item-permissions",
          toolName: null,
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
        reason: "Need network access",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });
});

describe("buildCodexInteractiveResponse", () => {
  it("maps bb command approvals back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "item-1",
            command: "git push",
            cwd: "/tmp/project",
            actions: [],
            sessionGrant: null,
          },
          reason: null,
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      decision: "acceptForSession",
    });
  });

  it("maps command denial back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "item-3",
            command: "git push",
            cwd: "/tmp/project",
            actions: [],
            sessionGrant: null,
          },
          reason: null,
          availableDecisions: ["allow_once", "deny"],
        },
        resolution: {
          decision: "deny",
        },
      }),
    ).toEqual({
      decision: "decline",
    });
  });

  it("maps file-change approvals back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "file_change",
            itemId: "item-file-change",
            writeScope: null,
            sessionGrant: null,
          },
          reason: "Review generated file changes",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      decision: "acceptForSession",
    });
  });

  it("maps permission grants back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "permission_grant",
            itemId: "item-permissions",
            toolName: null,
            permissions: {
              network: { enabled: true },
              fileSystem: {
                read: ["/tmp/project/README.md"],
                write: [],
              },
            },
          },
          reason: "Need network access",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
      }),
    ).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/project/README.md"],
          write: null,
        },
      },
      scope: "session",
    });
  });
});
