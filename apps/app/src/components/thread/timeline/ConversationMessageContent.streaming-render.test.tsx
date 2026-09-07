// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk";
import { MemoryRouter } from "react-router-dom";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import {
  buildMessageDirectiveRegistry,
  MessageDirectiveRegistryProvider,
} from "@/components/ui/markdown-message-directives";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import type { ThreadTimelineLocalFileLinkHandler } from "./types";
import { ConversationMessageContent } from "./ConversationMessageContent";

const mentionedThread = makeThreadListEntry({
  id: "thr_mentioned",
  title: "Related thread",
});

function Directive(props: PluginMessageDirectiveProps) {
  return (
    <div
      data-testid="directive"
      data-source={props.source}
      data-file={props.attributes.file}
    />
  );
}

const registry = buildMessageDirectiveRegistry([
  { id: "inline-vis", pluginId: "test", generation: 1, component: Directive },
]);

function assistant(
  text: string,
  streaming = true,
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler,
  showActions = false,
) {
  return (
    <MemoryRouter>
      <RouteNavigationProvider>
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map([[mentionedThread.id, mentionedThread]])}
        >
          <MessageDirectiveRegistryProvider registry={registry}>
            <ConversationMessageContent
              role="assistant"
              attachments={null}
              id="msg_stream"
              threadId="thr_stream"
              turnId="turn_stream"
              streaming={streaming}
              showActions={showActions}
              mobileActionDisplay="inline"
              onOpenLocalFileLink={onOpenLocalFileLink}
              text={text}
            />
          </MessageDirectiveRegistryProvider>
        </ThreadTitleMentionResourcesProvider>
      </RouteNavigationProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("assistant streaming Markdown rendering", () => {
  it.each([
    ["**Live bold", "strong", "Live bold"],
    ["`live code", "code", "live code"],
  ])(
    "renders incomplete formatting and returns to original Markdown when stopped: %s",
    (source, selector, text) => {
      const view = render(assistant(source));
      expect(view.container.querySelector(selector)?.textContent).toBe(text);

      view.rerender(assistant(source, false));
      expect(view.container.querySelector(selector)).toBeNull();
      expect(view.container.textContent).toContain(source);
    },
  );

  it("shows incomplete links as text and mounts links only after their destination completes", () => {
    const view = render(assistant("Read [the docs](https://example"));
    expect(screen.queryByRole("link")).toBeNull();
    expect(view.container.textContent).toContain("Read the docs");
    expect(view.container.textContent).not.toContain("https://example");

    view.rerender(assistant("Read [the docs](https://example.com)"));
    expect(
      screen.getByRole("link", { name: "the docs" }).getAttribute("href"),
    ).toBe("https://example.com");
  });

  it("does not load an incomplete image and loads the completed local image", () => {
    const view = render(assistant("Image ![preview](/workspace/preview"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(view.container.textContent).not.toContain("![preview]");

    view.rerender(assistant("Image ![preview](/workspace/preview.png)"));
    expect(
      screen.getByRole("img", { name: "preview" }).getAttribute("src"),
    ).toBe(
      "/api/v1/threads/thr_stream/host-files/content?path=%2Fworkspace%2Fpreview.png",
    );
  });

  it.each([
    "::inline-vis[label",
    '::inline-vis{file="[draft',
    '::inline-vis{file="a__b',
  ])(
    "does not fabricate a directive mount from partial syntax: %s",
    (source) => {
      const view = render(assistant(source));
      expect(screen.queryByTestId("directive")).toBeNull();
      expect(view.container.textContent).toContain(source);
    },
  );

  it("preserves complete directive source and attributes while the following prose streams", () => {
    const source = '::inline-vis{file="[draft]_a__b.html"}';
    const view = render(assistant(source));
    expect(screen.getByTestId("directive").getAttribute("data-source")).toBe(
      source,
    );
    expect(screen.getByTestId("directive").getAttribute("data-file")).toBe(
      "[draft]_a__b.html",
    );

    view.rerender(assistant(source + "\n\nA paragraph.\n\n**Live bold"));
    expect(screen.getAllByTestId("directive")).toHaveLength(1);
    expect(screen.getByTestId("directive").getAttribute("data-source")).toBe(
      source,
    );
    expect(view.container.querySelector("strong")?.textContent).toBe(
      "Live bold",
    );
  });

  it("preserves local-file destinations with spaces and line numbers alongside thread mentions", () => {
    const onOpenLocalFileLink = vi.fn(() => true);
    render(
      assistant(
        "[My file](</workspace/My File.ts:12>) and @thread:thr_mentioned with **live bold",
        true,
        onOpenLocalFileLink,
      ),
    );
    fireEvent.click(screen.getByRole("link", { name: "My file" }));
    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      path: "/workspace/My File.ts",
      lineRange: { startLineNumber: 12, endLineNumber: 12 },
    });
    expect(
      screen.getByRole("link", { name: "Related thread" }).getAttribute("href"),
    ).toBe(`/projects/${mentionedThread.projectId}/threads/thr_mentioned`);
  });

  it("copies original message text while the rendered tail is repaired", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const source = "**Original source";
    const view = render(assistant(source, true, undefined, true));
    expect(view.container.querySelector("strong")?.textContent).toBe(
      "Original source",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  });
});
