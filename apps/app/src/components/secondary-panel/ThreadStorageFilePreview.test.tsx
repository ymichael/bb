// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FilePreview } from "@/lib/file-preview";
import {
  MANAGER_STATUS_HTML_FILE_PATH,
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
  it("renders STATUS.html in an unsandboxed srcdoc iframe", () => {
    const statusHtml = [
      "<!doctype html>",
      '<script src="https://cdn.tailwindcss.com"></script>',
      "<h1>Status</h1>",
    ].join("\n");
    const { container } = render(
      <ThreadStorageFilePreview
        activePath={MANAGER_STATUS_HTML_FILE_PATH}
        filePreview={makeTextPreview({
          content: statusHtml,
          path: MANAGER_STATUS_HTML_FILE_PATH,
        })}
        isLoading={false}
        pinnedPath={MANAGER_STATUS_HTML_FILE_PATH}
      />,
    );

    const iframe = container.querySelector("iframe");

    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("srcdoc")).toBe(statusHtml);
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
      />,
    );

    expect(screen.getByRole("heading", { name: "Status" })).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
