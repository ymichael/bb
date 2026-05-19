// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePreview } from "./FilePreview";

type ClipboardWriteText = (text: string) => Promise<void>;

function installClipboardWriteTextMock() {
  const writeText = vi.fn<ClipboardWriteText>();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FilePreview", () => {
  it("does not render the copy button until an absolute copy path is provided", () => {
    render(<FilePreview path="src/App.tsx" state={{ kind: "loading" }} />);

    expect(
      screen.queryByRole("button", { name: "Copy file path" }),
    ).toBeNull();
  });

  it("copies the absolute path when the preview displays a relative path", async () => {
    const writeText = installClipboardWriteTextMock();

    render(
      <FilePreview
        path="src/App.tsx"
        copyPath="/Users/me/project/src/App.tsx"
        state={{ kind: "loading" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy file path" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/Users/me/project/src/App.tsx");
    });
  });

  it("renders sanitized HTML in markdown file previews", () => {
    const { container } = render(
      <FilePreview
        path="README.md"
        state={{
          kind: "ready",
          lineNumber: null,
          file: {
            name: "README.md",
            contents: [
              "# Readme",
              "",
              "<kbd>Cmd</kbd>",
              '<div onmouseover="alert(1)">Body</div>',
              "<script>alert(1)</script>",
            ].join("\n"),
          },
        }}
      />,
    );

    expect(container.querySelector("kbd")?.textContent).toBe("Cmd");
    expect(screen.getByText("Body").tagName).toBe("DIV");
    expect(screen.getByText("Body").getAttribute("onmouseover")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByText("alert(1)")).toBeNull();
  });
});

describe("HtmlFilePreview status bridge", () => {
  let postedMessages: Array<unknown>;
  let originalPostMessage: typeof window.postMessage;
  let fetchSpy: ReturnType<typeof vi.fn>;

  function jsonResponse(
    body: unknown,
    init: { status?: number } = {},
  ): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }

  function getIframeContentWindow(container: HTMLElement): Window {
    const iframe = container.querySelector("iframe");
    if (!iframe || !iframe.contentWindow) {
      throw new Error("Expected iframe contentWindow to be available");
    }
    return iframe.contentWindow;
  }

  beforeEach(() => {
    postedMessages = [];
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Capture postMessage replies sent back to the iframe content window so we
    // can assert what the parent shipped back.
    originalPostMessage = window.postMessage;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.postMessage = originalPostMessage;
  });

  it("relays a read message from the iframe to the server", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ todos: ["a"] }));

    const { container } = render(
      <FilePreview
        path="STATUS.html"
        iframeStatusBridgeThreadId="thr_demo"
        state={{
          kind: "html",
          file: { name: "STATUS.html", contents: "<html></html>" },
        }}
      />,
    );

    const iframeWindow = getIframeContentWindow(container);
    iframeWindow.postMessage = vi.fn((message) => {
      postedMessages.push(message);
    }) as Window["postMessage"];

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { id: 1, type: "bb-status:read", path: "STATUS_DATA.json" },
          source: iframeWindow,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestedUrl, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(requestedUrl)).toContain("/threads/thr_demo/thread-storage/");
    expect(init).toMatchObject({ method: "GET" });

    await waitFor(() => {
      expect(postedMessages).toEqual([
        {
          id: 1,
          type: "bb-status:result",
          ok: true,
          data: { todos: ["a"] },
        },
      ]);
    });
  });

  it("ignores messages from sources other than the iframe", async () => {
    const { container } = render(
      <FilePreview
        path="STATUS.html"
        iframeStatusBridgeThreadId="thr_demo"
        state={{
          kind: "html",
          file: { name: "STATUS.html", contents: "<html></html>" },
        }}
      />,
    );
    const iframeWindow = getIframeContentWindow(container);
    iframeWindow.postMessage = vi.fn((message) => {
      postedMessages.push(message);
    }) as Window["postMessage"];

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { id: 1, type: "bb-status:read", path: "STATUS_DATA.json" },
          source: window, // not the iframe
        }),
      );
      await Promise.resolve();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(postedMessages).toEqual([]);
  });

  it("reports server failures back to the iframe as ok=false", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const { container } = render(
      <FilePreview
        path="STATUS.html"
        iframeStatusBridgeThreadId="thr_demo"
        state={{
          kind: "html",
          file: { name: "STATUS.html", contents: "<html></html>" },
        }}
      />,
    );
    const iframeWindow = getIframeContentWindow(container);
    iframeWindow.postMessage = vi.fn((message) => {
      postedMessages.push(message);
    }) as Window["postMessage"];

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { id: 4, type: "bb-status:read", path: "STATUS_DATA.json" },
          source: iframeWindow,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(postedMessages).toHaveLength(1);
    });
    expect(postedMessages[0]).toMatchObject({
      id: 4,
      type: "bb-status:result",
      ok: false,
    });
  });
});
