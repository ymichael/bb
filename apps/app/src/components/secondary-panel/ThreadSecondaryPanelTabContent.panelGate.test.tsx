// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { WorkspaceDiffTarget } from "@bb/domain";
import type {
  EnvironmentDiffFileResponse,
  EnvironmentDiffFilesResponse,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  environmentDiffFilesQueryKeyPrefix,
  environmentFilePreviewQueryKeyPrefix,
  hostFilePreviewQueryKey,
} from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  GitDiffTabContent,
  HostScopedFilePreviewTabContent,
  WorkspaceFilePreviewTabContent,
} from "./ThreadSecondaryPanelTabContent";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    environments: { diffFiles: vi.fn(), diffFile: vi.fn() },
    files: { createPreview: vi.fn(), read: vi.fn() },
  },
}));

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");
  return {
    File: () => null,
    VirtualizerContext: React.createContext(undefined),
    useWorkerPool: () => null,
  };
});

const ENVIRONMENT_ID = "env-1";
const TARGET: WorkspaceDiffTarget = { type: "all", mergeBaseBranch: "main" };

const emptyDiff: EnvironmentDiffFilesResponse = {
  outcome: "available",
  files: [],
  truncated: false,
  shortstat: "",
  mergeBaseRef: null,
  initialPatches: [],
};

const previewFile: EnvironmentDiffFileResponse = {
  path: "src/index.ts",
  content: "export const answer = 42;\n",
  contentEncoding: "utf8",
  mimeType: "text/plain",
  sizeBytes: 26,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GitDiffTabContent panel gating", () => {
  it("fetches the diff TOC only while the panel is open, and refetches once on reopen", async () => {
    vi.mocked(sdk.environments.diffFiles).mockResolvedValue(emptyDiff);
    const { queryClient, wrapper: Wrapper } = createQueryClientTestHarness();
    const renderTab = (isPanelOpen: boolean) => (
      <Wrapper>
        <GitDiffTabContent
          environmentId={ENVIRONMENT_ID}
          target={TARGET}
          isDiffPanelActive
          isPanelOpen={isPanelOpen}
          gitDiffPresentation={{
            view: "unified",
            overflow: "scroll",
            showLineNumbers: true,
          }}
        />
      </Wrapper>
    );

    const view = render(renderTab(false));
    expect(sdk.environments.diffFiles).not.toHaveBeenCalled();

    view.rerender(renderTab(true));
    await waitFor(() => {
      expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(1);
    });

    view.rerender(renderTab(false));
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: environmentDiffFilesQueryKeyPrefix(ENVIRONMENT_ID),
      });
    });
    expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(1);

    view.rerender(renderTab(true));
    await waitFor(() => {
      expect(sdk.environments.diffFiles).toHaveBeenCalledTimes(2);
    });
  });
});

describe("WorkspaceFilePreviewTabContent panel gating", () => {
  it("does not refetch an invalidated preview while the panel is closed", async () => {
    vi.mocked(sdk.environments.diffFile).mockResolvedValue(previewFile);
    const { queryClient, wrapper: Wrapper } = createQueryClientTestHarness();
    const renderTab = (isPanelOpen: boolean) => (
      <Wrapper>
        <WorkspaceFilePreviewTabContent
          activePath={previewFile.path}
          environmentId={ENVIRONMENT_ID}
          isPanelOpen={isPanelOpen}
          lineRange={null}
          source={{ kind: "working-tree" }}
          statusLabel={null}
          threadId="thr-1"
        />
      </Wrapper>
    );

    const view = render(renderTab(true));
    await waitFor(() => {
      expect(sdk.environments.diffFile).toHaveBeenCalledTimes(1);
    });

    view.rerender(renderTab(false));
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: environmentFilePreviewQueryKeyPrefix(ENVIRONMENT_ID),
      });
    });
    expect(sdk.environments.diffFile).toHaveBeenCalledTimes(1);

    view.rerender(renderTab(true));
    await waitFor(() => {
      expect(sdk.environments.diffFile).toHaveBeenCalledTimes(2);
    });
  });
});

describe("HostScopedFilePreviewTabContent panel gating", () => {
  it("does not start or refetch a host read while the retained panel is closed", async () => {
    vi.mocked(sdk.files.createPreview).mockResolvedValue({
      baseUrl: "/api/v1/file-previews/lease-1",
      expiresAtMs: Date.now() + 60_000,
    });
    vi.mocked(sdk.files.read).mockResolvedValue({
      path: "/tmp/example.txt",
      content: "hello\n",
      contentEncoding: "utf8",
      mimeType: "text/plain",
      modifiedAtMs: 1,
      sha256: "hash",
      sizeBytes: 6,
    });
    const { queryClient, wrapper: Wrapper } = createQueryClientTestHarness();
    const renderTab = (isPanelOpen: boolean) => (
      <Wrapper>
        <HostScopedFilePreviewTabContent
          activePath="/tmp/example.txt"
          hostId="host-1"
          isPanelOpen={isPanelOpen}
          lineRange={null}
        />
      </Wrapper>
    );

    const view = render(renderTab(false));
    expect(sdk.files.read).not.toHaveBeenCalled();
    expect(sdk.files.createPreview).not.toHaveBeenCalled();

    view.rerender(renderTab(true));
    await waitFor(() => {
      expect(sdk.files.read).toHaveBeenCalledTimes(1);
    });

    view.rerender(renderTab(false));
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: hostFilePreviewQueryKey("host-1", "/tmp/example.txt"),
      });
    });
    expect(sdk.files.read).toHaveBeenCalledTimes(1);

    view.rerender(renderTab(true));
    await waitFor(() => {
      expect(sdk.files.read).toHaveBeenCalledTimes(2);
    });
  });
});
