// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilePreview } from "@/lib/file-preview";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import {
  MANAGER_STATUS_FILE_PATH,
  MANAGER_STATUS_MARKDOWN_FILE_PATH,
} from "./managerStorage";
import { ThreadStorageFilePreview } from "./ThreadStorageFilePreview";

interface MakeTextPreviewArgs {
  content: string;
  path: string;
}

function makeTextPreview({ content, path }: MakeTextPreviewArgs): FilePreview {
  return {
    kind: "text",
    content,
    mimeType: "text/plain",
    path,
    url: `/preview/${path}`,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ThreadStorageFilePreview", () => {
  it("renders the unified STATUS route in an unsandboxed iframe", async () => {
    let resolveVersion = (response: Response) => response;
    const versionResponse = new Promise<Response>((resolve) => {
      resolveVersion = (response: Response) => {
        resolve(response);
        return response;
      };
    });
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thr_manager/status-version",
        handler: () => versionResponse,
      },
    ]);
    const { wrapper } = createQueryClientTestHarness();
    const { container } = render(
      <ThreadStorageFilePreview
        activePath={MANAGER_STATUS_FILE_PATH}
        filePreview={undefined}
        isLoading={false}
        pinnedPath={MANAGER_STATUS_FILE_PATH}
        threadId="thr_manager"
      />,
      { wrapper },
    );

    const iframe = container.querySelector("iframe");

    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBe(
      "/api/v1/threads/thr_manager/status/",
    );
    expect(iframe?.hasAttribute("sandbox")).toBe(false);
    expect(iframe?.style.width).toBe("100%");
    expect(iframe?.style.height).toBe("100%");
    expect(iframe?.style.border).toBe("0px");

    resolveVersion(jsonResponse({ source: "folder", hash: "status-hash-1" }));

    await vi.waitFor(() => {
      expect(iframe?.getAttribute("src")).toBe(
        "/api/v1/threads/thr_manager/status/?v=status-hash-1",
      );
    });
  });

  it("updates the STATUS iframe src when the polled hash changes", async () => {
    let requestCount = 0;
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thr_manager/status-version",
        handler: () => {
          requestCount += 1;
          return jsonResponse({
            source: "folder",
            hash: requestCount === 1 ? "status-hash-1" : "status-hash-2",
          });
        },
      },
    ]);
    const { wrapper } = createQueryClientTestHarness();
    const { container } = render(
      <ThreadStorageFilePreview
        activePath={MANAGER_STATUS_FILE_PATH}
        filePreview={undefined}
        isLoading={false}
        pinnedPath={MANAGER_STATUS_FILE_PATH}
        threadId="thr_manager"
      />,
      { wrapper },
    );

    const iframe = container.querySelector("iframe");
    await waitFor(() => {
      expect(iframe?.getAttribute("src")).toBe(
        "/api/v1/threads/thr_manager/status/?v=status-hash-1",
      );
    });

    await waitFor(
      () => {
        expect(iframe?.getAttribute("src")).toBe(
          "/api/v1/threads/thr_manager/status/?v=status-hash-2",
        );
      },
      { timeout: 2_500 },
    );
  }, 8_000);

  it("renders STATUS.md through the markdown preview path", () => {
    const { wrapper } = createQueryClientTestHarness();
    const { container } = render(
      <ThreadStorageFilePreview
        activePath={MANAGER_STATUS_MARKDOWN_FILE_PATH}
        filePreview={makeTextPreview({
          content: "# Status",
          path: MANAGER_STATUS_MARKDOWN_FILE_PATH,
        })}
        isLoading={false}
        pinnedPath={MANAGER_STATUS_MARKDOWN_FILE_PATH}
        threadId="thr_manager"
      />,
      { wrapper },
    );

    expect(screen.getByRole("heading", { name: "Status" })).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
