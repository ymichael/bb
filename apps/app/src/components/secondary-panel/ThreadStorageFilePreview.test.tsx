// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FilePreview } from "@/lib/file-preview";
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
});

describe("ThreadStorageFilePreview", () => {
  it("renders the unified STATUS route in an unsandboxed iframe", () => {
    const { container } = render(
      <ThreadStorageFilePreview
        activePath={MANAGER_STATUS_FILE_PATH}
        filePreview={undefined}
        isLoading={false}
        pinnedPath={MANAGER_STATUS_FILE_PATH}
        threadId="thr_manager"
      />,
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
  });

  it("renders STATUS.md through the markdown preview path", () => {
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
    );

    expect(screen.getByRole("heading", { name: "Status" })).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
