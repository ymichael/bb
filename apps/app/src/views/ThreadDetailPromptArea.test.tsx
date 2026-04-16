// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  AvailableModel,
  PendingInteraction,
  Thread,
} from "@bb/domain";
import type { SystemProviderInfo } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    getAvailableModels: vi.fn(),
    getThreadDefaultExecutionOptions: vi.fn(),
    listSystemProviders: vi.fn(),
    listThreadDrafts: vi.fn(),
    listThreadPendingInteractions: vi.fn(),
    listThreads: vi.fn(),
  };
});

interface ProviderOverrides extends Partial<SystemProviderInfo> {}

interface ModelOverrides extends Partial<AvailableModel> {}

function createThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    environmentId: null,
    automationId: null,
    providerId: "codex",
    type: "standard",
    title: "Pending interaction thread",
    titleFallback: "Pending interaction thread",
    status: "idle",
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function createPendingInteraction(): PendingInteraction {
  return {
    id: "pi_1",
    threadId: "thr_1",
    turnId: "turn_1",
    providerId: "codex",
    providerThreadId: "provider-thread-1",
    providerRequestId: "request-1",
    status: "pending",
    payload: {
      subject: {
        kind: "permission_grant",
        itemId: "item_1",
        toolName: "WebFetch",
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
      reason: "Need network access",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    },
    resolution: null,
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

function makeProvider(overrides: ProviderOverrides = {}): SystemProviderInfo {
  return {
    available: true,
    capabilities: {
      supportsRename: true,
      supportsServiceTier: false,
      supportedPermissionModes: ["full", "workspace-write", "readonly"],
    },
    displayName: "Codex",
    id: "codex",
    ...overrides,
  };
}

function makeModel(overrides: ModelOverrides = {}): AvailableModel {
  return {
    defaultReasoningEffort: "medium",
    description: "Model description",
    displayName: "gpt-5.4",
    id: "gpt-5.4",
    isDefault: true,
    model: "gpt-5.4",
    supportedReasoningEfforts: [
      {
        description: "Low effort",
        reasoningEffort: "low",
      },
      {
        description: "Medium effort",
        reasoningEffort: "medium",
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

function mockMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("ThreadDetailPromptArea", () => {
  it("renders only the pending interaction banner when an interaction is awaiting", async () => {
    mockMatchMedia();
    vi.mocked(api.getThreadDefaultExecutionOptions).mockResolvedValue(null);
    vi.mocked(api.listThreadDrafts).mockResolvedValue([]);
    vi.mocked(api.listSystemProviders).mockResolvedValue([makeProvider()]);
    vi.mocked(api.getAvailableModels).mockResolvedValue([makeModel()]);
    vi.mocked(api.listThreads).mockResolvedValue([]);

    const { wrapper } = createQueryClientTestHarness();

    render(
      <ThreadDetailPromptArea
        canExpandPromptChangeList={false}
        canUseGitUi={false}
        isEnvironmentActionPending={false}
        isLoadingMergeBaseBranchOptions={false}
        pendingInteractions={[createPendingInteraction()]}
        openDiffFile={() => {}}
        openThreadDiffPanel={() => {}}
        projectId="proj_1"
        promptBannerSummary="No changes"
        promptComposerRef={{ current: null }}
        scrollToBottom={() => {}}
        sendMessage={{
          isPending: false,
          mutateAsync: vi.fn(async () => {}),
        }}
        showBranchComparisonUi={false}
        showPromptGitStatsBanner={false}
        thread={createThread()}
        threadDetailRows={[]}
      />,
      { wrapper },
    );

    await waitFor(() => {
      expect(screen.getAllByText("Need network access").length).toBeGreaterThan(0);
    });
    expect(screen.queryByTitle("Submit (Enter)")).toBeNull();
  });
});
