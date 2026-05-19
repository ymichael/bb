// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePreview } from "./FilePreview";
import { BB_STATUS_TELL_MESSAGE_TYPE } from "@/lib/iframe-status-bridge";

const { sendThreadMessageMock } = vi.hoisted(() => ({
  sendThreadMessageMock: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("@/lib/api", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    sendThreadMessage: sendThreadMessageMock,
  };
});

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

  it(
    "forwards bb-status:tell messages from the STATUS.html iframe to the manager thread and acks the iframe",
    async () => {
      const { container, unmount } = render(
        <FilePreview
          path="STATUS.html"
          state={{
            kind: "html",
            file: { name: "STATUS.html", contents: "<p>status</p>" },
            managerThreadId: "thr_manager_42",
          }}
        />,
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).not.toBeNull();
      const iframeWindow = iframe?.contentWindow ?? null;
      expect(iframeWindow).not.toBeNull();
      if (iframeWindow === null) throw new Error("iframe contentWindow null");

      const replies: unknown[] = [];
      iframeWindow.postMessage = ((payload: unknown) => {
        replies.push(payload);
      }) as Window["postMessage"];

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            id: 1,
            type: BB_STATUS_TELL_MESSAGE_TYPE,
            text: "Mark todo #3 as done",
          },
          source: iframeWindow,
        }),
      );

      await waitFor(() => {
        expect(sendThreadMessageMock).toHaveBeenCalledWith("thr_manager_42", {
          input: [{ type: "text", text: "Mark todo #3 as done" }],
          mode: "auto",
        });
      });
      await waitFor(() => {
        expect(replies).toEqual([
          {
            type: "bb-status:tell-result",
            id: 1,
            ok: true,
          },
        ]);
      });

      unmount();
      sendThreadMessageMock.mockClear();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            id: 2,
            type: BB_STATUS_TELL_MESSAGE_TYPE,
            text: "ignored after unmount",
          },
          source: iframeWindow,
        }),
      );
      // brief microtask flush; nothing should hit the sender or the iframe
      await Promise.resolve();
      expect(sendThreadMessageMock).not.toHaveBeenCalled();
      expect(replies).toHaveLength(1);
    },
  );

  it(
    "ignores postMessage events whose source isn't the iframe's own contentWindow",
    async () => {
      const { container } = render(
        <FilePreview
          path="STATUS.html"
          state={{
            kind: "html",
            file: { name: "STATUS.html", contents: "<p>status</p>" },
            managerThreadId: "thr_manager_42",
          }}
        />,
      );
      const iframe = container.querySelector("iframe");
      expect(iframe).not.toBeNull();

      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            id: 1,
            type: BB_STATUS_TELL_MESSAGE_TYPE,
            text: "spoofed",
          },
          source: window,
        }),
      );

      await Promise.resolve();
      expect(sendThreadMessageMock).not.toHaveBeenCalled();
    },
  );

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
