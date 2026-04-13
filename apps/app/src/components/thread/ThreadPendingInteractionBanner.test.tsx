// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PendingInteraction } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ThreadPendingInteractionBanner } from "./ThreadPendingInteractionBanner";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    resolveThreadPendingInteraction: vi.fn(),
  };
});

interface RenderBannerArgs {
  interaction: PendingInteraction;
}

function renderBanner(args: RenderBannerArgs) {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <ThreadPendingInteractionBanner
      interaction={args.interaction}
      threadId={args.interaction.threadId}
    />,
    { wrapper },
  );
}

function createPendingInteractionBase(): Omit<PendingInteraction, "payload"> {
  return {
    id: "pi_1",
    threadId: "thr_1",
    turnId: "turn_1",
    providerId: "codex",
    providerThreadId: "provider-thread-1",
    providerRequestId: "request-1",
    status: "pending",
    resolution: null,
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

function createCommandApprovalInteraction(): PendingInteraction {
  return {
    ...createPendingInteractionBase(),
    payload: {
      kind: "command_approval",
      itemId: "item_1",
      reason: "Run a command that modifies the repo",
      command: "git push origin feature",
      cwd: "/tmp/project",
      commandActions: [],
      requestedPermissions: null,
      availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
    },
  };
}

function createResolvingCommandApprovalInteraction(): PendingInteraction {
  return {
    ...createCommandApprovalInteraction(),
    status: "resolving",
    resolution: {
      kind: "command_approval",
      decision: "accept_for_session",
    },
  };
}

function createAmendmentCommandApprovalInteraction(): PendingInteraction {
  return {
    ...createPendingInteractionBase(),
    payload: {
      kind: "command_approval",
      itemId: "item_5",
      reason: null,
      command: null,
      cwd: null,
      commandActions: [],
      requestedPermissions: null,
      availableDecisions: [
        {
          kind: "accept_with_exec_policy_amendment",
          execPolicyAmendment: ["allow workspace-write"],
        },
      ],
    },
  };
}

function createFileChangeInteraction(): PendingInteraction {
  return {
    ...createPendingInteractionBase(),
    payload: {
      kind: "file_change_approval",
      itemId: "item_2",
      reason: "Write generated files",
      grantRoot: "/tmp/project",
    },
  };
}

function createPermissionRequestInteraction(): PendingInteraction {
  return {
    ...createPendingInteractionBase(),
    payload: {
      kind: "permission_request",
      itemId: "item_3",
      reason: "Need repo write access",
      toolName: "Edit",
      permissions: {
        network: null,
        fileSystem: {
          read: ["/tmp/project/package.json"],
          write: ["/tmp/project/package.json"],
        },
      },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadPendingInteractionBanner", () => {
  it("resolves command approvals with the selected decision", async () => {
    vi.mocked(api.resolveThreadPendingInteraction).mockResolvedValue({
      ...createCommandApprovalInteraction(),
      status: "resolving",
      resolution: {
        kind: "command_approval",
        decision: "accept",
      },
    });

    renderBanner({
      interaction: createCommandApprovalInteraction(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(api.resolveThreadPendingInteraction).toHaveBeenCalledWith(
        "thr_1",
        "pi_1",
        {
          kind: "command_approval",
          decision: "accept",
        },
      );
    });
  });

  it("resolves file-change approvals from the banner actions", async () => {
    vi.mocked(api.resolveThreadPendingInteraction).mockResolvedValue({
      ...createFileChangeInteraction(),
      status: "resolving",
      resolution: {
        kind: "file_change_approval",
        decision: "decline",
      },
    });

    renderBanner({
      interaction: createFileChangeInteraction(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => {
      expect(api.resolveThreadPendingInteraction).toHaveBeenCalledWith(
        "thr_1",
        "pi_1",
        {
          kind: "file_change_approval",
          decision: "decline",
        },
      );
    });
  });

  it("resolves permission requests with the selected grant scope", async () => {
    vi.mocked(api.resolveThreadPendingInteraction).mockResolvedValue({
      ...createPermissionRequestInteraction(),
      status: "resolving",
      resolution: {
        kind: "permission_request",
        decision: "allow",
        permissions: {
          network: null,
          fileSystem: {
            read: ["/tmp/project/package.json"],
            write: ["/tmp/project/package.json"],
          },
        },
        scope: "session",
      },
    });

    renderBanner({
      interaction: createPermissionRequestInteraction(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Allow for session" }));

    await waitFor(() => {
      expect(api.resolveThreadPendingInteraction).toHaveBeenCalledWith(
        "thr_1",
        "pi_1",
        {
          kind: "permission_request",
          decision: "allow",
          permissions: {
            network: null,
            fileSystem: {
              read: ["/tmp/project/package.json"],
              write: ["/tmp/project/package.json"],
            },
          },
          scope: "session",
        },
      );
    });
  });

  it("disables actions while resolving and surfaces resolution failures", async () => {
    let rejectResolution: (error: Error) => void = () => {};
    vi.mocked(api.resolveThreadPendingInteraction).mockReturnValue(
      new Promise((_, reject) => {
        rejectResolution = reject;
      }),
    );

    renderBanner({
      interaction: createCommandApprovalInteraction(),
    });

    const approveButton = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approveButton);

    await waitFor(() => {
      expect(approveButton.hasAttribute("disabled")).toBe(true);
    });

    rejectResolution(new Error("Resolution rejected"));

    await waitFor(() => {
      expect(screen.getByText("Resolution rejected")).not.toBeNull();
    });
    expect(approveButton.hasAttribute("disabled")).toBe(false);
  });

  it("shows amendment details for command approvals with amended decisions", () => {
    renderBanner({
      interaction: createAmendmentCommandApprovalInteraction(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Show interaction details" }));

    expect(screen.getByText("allow workspace-write")).not.toBeNull();
  });

  it("shows resolving interactions as submitted instead of actionable", () => {
    renderBanner({
      interaction: createResolvingCommandApprovalInteraction(),
    });

    expect(screen.getByText("Delivering")).not.toBeNull();
    expect(
      screen.getByText("Answer submitted. Delivering it to the provider."),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
