// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationMarkdown } from "../src/thread-timeline/ConversationMarkdown.js";
import type { ThreadTimelineLocalFileLink } from "../src/thread-timeline/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

interface RenderConversationMarkdownArgs {
  content: string;
  onOpenLocalFileLink?: (link: ThreadTimelineLocalFileLink) => boolean;
}

function renderConversationMarkdown(
  args: RenderConversationMarkdownArgs,
): HTMLAnchorElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <ConversationMarkdown
        content={args.content}
        onOpenLocalFileLink={args.onOpenLocalFileLink}
      />,
    );
  });

  const link = container.querySelector("a");
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error("Expected markdown to render a link");
  }
  return link;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("ConversationMarkdown local file links", () => {
  it("does not prevent navigation when the local link handler returns false", () => {
    const onOpenLocalFileLink = vi.fn(() => false);
    const link = renderConversationMarkdown({
      content: "[Thread](/projects/proj_1/threads/thr_1)",
      onOpenLocalFileLink,
    });

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(clickEvent);

    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineNumber: null,
      path: "/projects/proj_1/threads/thr_1",
    });
    expect(clickEvent.defaultPrevented).toBe(false);
  });

  it("prevents navigation when the local link handler returns true", () => {
    const onOpenLocalFileLink = vi.fn(() => true);
    const link = renderConversationMarkdown({
      content: "[File](/Users/me/project/src/file.ts:12)",
      onOpenLocalFileLink,
    });

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(clickEvent);

    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineNumber: 12,
      path: "/Users/me/project/src/file.ts",
    });
    expect(clickEvent.defaultPrevented).toBe(true);
  });
});
