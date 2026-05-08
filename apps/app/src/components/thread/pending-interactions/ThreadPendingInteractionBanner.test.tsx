// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
      subject: {
        kind: "command",
        itemId: "item_1",
        command: "git push origin feature",
        cwd: "/tmp/project",
        actions: [],
        sessionGrant: null,
      },
      reason: "Run a command that modifies the repo",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    },
  };
}

function createResolvingCommandApprovalInteraction(): PendingInteraction {
  return {
    ...createCommandApprovalInteraction(),
    status: "resolving",
    resolution: {
      decision: "allow_for_session",
      grantedPermissions: null,
    },
  };
}

function createFileChangeInteraction(): PendingInteraction {
  return {
    ...createPendingInteractionBase(),
    payload: {
      subject: {
        kind: "file_change",
        itemId: "item_2",
        writeScope: null,
        sessionGrant: null,
      },
      reason: "Write generated files",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    },
  };
}

function createPermissionRequestInteraction(): PendingInteraction {
  return {
    ...createPendingInteractionBase(),
    payload: {
      subject: {
        kind: "permission_grant",
        itemId: "item_3",
        toolName: "Edit",
        permissions: {
          network: null,
          fileSystem: {
            read: ["/tmp/project/package.json"],
            write: ["/tmp/project/package.json"],
          },
        },
      },
      reason: "Need repo write access",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
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
        decision: "allow_once",
        grantedPermissions: null,
      },
    });

    renderBanner({
      interaction: createCommandApprovalInteraction(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(api.resolveThreadPendingInteraction).toHaveBeenCalledWith(
        "thr_1",
        "pi_1",
        {
          decision: "allow_once",
          grantedPermissions: null,
        },
      );
    });
  });

  it("resolves file-change approvals from the banner actions", async () => {
    vi.mocked(api.resolveThreadPendingInteraction).mockResolvedValue({
      ...createFileChangeInteraction(),
      status: "resolving",
      resolution: {
        decision: "deny",
      },
    });

    renderBanner({
      interaction: createFileChangeInteraction(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(api.resolveThreadPendingInteraction).toHaveBeenCalledWith(
        "thr_1",
        "pi_1",
        {
          decision: "deny",
        },
      );
    });
  });

  it("does not grant extra permissions when approving file-change interactions", async () => {
    vi.mocked(api.resolveThreadPendingInteraction).mockResolvedValue({
      ...createFileChangeInteraction(),
      status: "resolving",
      resolution: {
        decision: "allow_once",
        grantedPermissions: null,
      },
    });

    renderBanner({
      interaction: createFileChangeInteraction(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(api.resolveThreadPendingInteraction).toHaveBeenCalledWith(
        "thr_1",
        "pi_1",
        {
          decision: "allow_once",
          grantedPermissions: null,
        },
      );
    });
  });

  it("resolves permission requests with the selected grant scope", async () => {
    vi.mocked(api.resolveThreadPendingInteraction).mockResolvedValue({
      ...createPermissionRequestInteraction(),
      status: "resolving",
      resolution: {
        decision: "allow_for_session",
        grantedPermissions: {
          network: null,
          fileSystem: {
            read: ["/tmp/project/package.json"],
            write: ["/tmp/project/package.json"],
          },
        },
      },
    });

    renderBanner({
      interaction: createPermissionRequestInteraction(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Allow for session/ }));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(api.resolveThreadPendingInteraction).toHaveBeenCalledWith(
        "thr_1",
        "pi_1",
        {
          decision: "allow_for_session",
          grantedPermissions: {
            network: null,
            fileSystem: {
              read: ["/tmp/project/package.json"],
              write: ["/tmp/project/package.json"],
            },
          },
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

    const submitButton = screen.getByRole("button", { name: /Submit/ });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(submitButton.hasAttribute("disabled")).toBe(true);
    });

    rejectResolution(new Error("Resolution rejected"));

    await waitFor(() => {
      expect(screen.getByText("Resolution rejected")).not.toBeNull();
    });
    expect(submitButton.hasAttribute("disabled")).toBe(false);
  });

  it("shows resolving interactions as submitted instead of actionable", () => {
    renderBanner({
      interaction: createResolvingCommandApprovalInteraction(),
    });

    expect(screen.getByText("Delivering")).not.toBeNull();
    expect(
      screen.getByText("Answer submitted. Delivering it to the provider."),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Submit/ })).toBeNull();
  });
});
