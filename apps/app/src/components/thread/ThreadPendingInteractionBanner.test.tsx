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
    providerRequestMethod: "item/tool/requestUserInput",
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
    providerRequestMethod: "item/commandExecution/requestApproval",
    payload: {
      kind: "command_approval",
      itemId: "item_1",
      approvalId: null,
      reason: "Run a command that modifies the repo",
      command: "git push origin feature",
      cwd: "/tmp/project",
      commandActions: [],
      requestedPermissions: null,
      availableDecisions: ["accept", "accept_for_session", "decline", "cancel"],
    },
  };
}

function createFileChangeInteraction(): PendingInteraction {
  return {
    ...createPendingInteractionBase(),
    providerRequestMethod: "item/fileChange/requestApproval",
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
    providerRequestMethod: "item/permissions/requestApproval",
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

function createUserInputInteraction(): PendingInteraction {
  return {
    ...createPendingInteractionBase(),
    payload: {
      kind: "user_input_request",
      itemId: "item_4",
      questions: [
        {
          id: "environment",
          header: "Environment",
          question: "Which environment should I use?",
          allowsOther: true,
          isSecret: false,
          multiSelect: false,
          options: [
            {
              label: "prod",
              description: "Use production",
              preview: null,
            },
            {
              label: "staging",
              description: "Use staging",
              preview: null,
            },
          ],
        },
      ],
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
      status: "resolved",
      resolution: {
        kind: "command_approval",
        decision: "accept",
      },
      resolvedAt: 2,
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
      status: "resolved",
      resolution: {
        kind: "file_change_approval",
        decision: "decline",
      },
      resolvedAt: 2,
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
      status: "resolved",
      resolution: {
        kind: "permission_request",
        permissions: {
          network: null,
          fileSystem: {
            read: ["/tmp/project/package.json"],
            write: ["/tmp/project/package.json"],
          },
        },
        scope: "session",
      },
      resolvedAt: 2,
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

  it("submits user-input answers from the in-banner form", async () => {
    vi.mocked(api.resolveThreadPendingInteraction).mockResolvedValue({
      ...createUserInputInteraction(),
      status: "resolved",
      resolution: {
        kind: "user_input_request",
        answers: {
          environment: ["prod"],
        },
      },
      resolvedAt: 2,
    });

    renderBanner({
      interaction: createUserInputInteraction(),
    });

    fireEvent.click(screen.getByRole("radio", { name: /prod/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));

    await waitFor(() => {
      expect(api.resolveThreadPendingInteraction).toHaveBeenCalledWith(
        "thr_1",
        "pi_1",
        {
          kind: "user_input_request",
          answers: {
            environment: ["prod"],
          },
        },
      );
    });
  });
});
