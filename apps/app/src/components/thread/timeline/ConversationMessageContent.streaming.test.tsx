// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { ConversationMessageContent } from "./ConversationMessageContent";

const markdownRenders = vi.hoisted(() => [] as string[]);
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    markdownRenders.push(children);
    return <div data-markdown-document="">{children}</div>;
  },
  defaultUrlTransform: (url: string) => url,
}));

function renderAssistantMessage(text: string, streaming: boolean) {
  const element = (
    <MemoryRouter>
      <RouteNavigationProvider>
        <ConversationMessageContent
          role="assistant"
          attachments={null}
          id="msg_stream"
          threadId="thr_stream"
          turnId="turn_stream"
          showActions={false}
          mobileActionDisplay="overflow"
          streaming={streaming}
          text={text}
        />
      </RouteNavigationProvider>
    </MemoryRouter>
  );
  const view = render(element);
  return {
    view,
    update: (nextText: string, nextStreaming: boolean) =>
      view.rerender(
        <MemoryRouter>
          <RouteNavigationProvider>
            <ConversationMessageContent
              role="assistant"
              attachments={null}
              id="msg_stream"
              threadId="thr_stream"
              turnId="turn_stream"
              showActions={false}
              mobileActionDisplay="overflow"
              streaming={nextStreaming}
              text={nextText}
            />
          </RouteNavigationProvider>
        </MemoryRouter>,
      ),
  };
}

function documents(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-markdown-document]"),
  ).map((node) => node.textContent ?? "");
}

beforeEach(() => {
  markdownRenders.length = 0;
});

afterEach(cleanup);

describe("ConversationMessageContent streaming split", () => {
  it.each([
    ["**Streaming bold", "**Streaming bold**"],
    ["`streaming code", "`streaming code`"],
    ["Read [the docs](https://example", "Read the docs"],
    ["Image ![preview](/workspace/preview", "Image "],
  ])(
    "repairs an unsplit live tail and restores raw source on completion: %s",
    (source, repaired) => {
      const { view, update } = renderAssistantMessage(source, true);
      expect(documents(view.container)).toEqual([repaired]);

      update(source, false);
      expect(documents(view.container)).toEqual([source]);
    },
  );

  it("repairs only the live split tail without re-parsing the settled prefix", () => {
    const { view, update } = renderAssistantMessage(
      "Settled **source.\n\nSecond paragraph.\n\n`live code",
      true,
    );
    expect(documents(view.container)).toEqual([
      "Settled **source.\n\n",
      "Second paragraph.\n\n`live code`",
    ]);

    markdownRenders.length = 0;
    update("Settled **source.\n\nSecond paragraph.\n\n`live code grows", true);
    expect(markdownRenders).toEqual(["Second paragraph.\n\n`live code grows`"]);
  });

  it.each([
    "::inline-vis[label",
    '::inline-vis{file="[draft.html"}',
    '::inline-vis{file="a__b.html"}',
    '::unknown{title="**source"}',
  ])("preserves directive source in a live tail: %s", (source) => {
    const { view } = renderAssistantMessage(source, true);
    expect(documents(view.container)).toEqual([source]);
  });

  it("resumes repair after a directive moves into the settled prefix", () => {
    const source = '::inline-vis{file="[draft.html"}';
    const { view, update } = renderAssistantMessage(
      source + "\n\n**live",
      true,
    );
    expect(documents(view.container)).toEqual([source + "\n\n**live"]);

    update(source + "\n\nSecond paragraph.\n\n**live", true);
    expect(documents(view.container)).toEqual([
      source + "\n\n",
      "Second paragraph.\n\n**live**",
    ]);
  });

  it("re-parses only the live tail when a delta arrives and collapses to one document once complete", () => {
    const { view, update } = renderAssistantMessage(
      "Para one.\n\nPara two.\n\nPara th",
      true,
    );
    expect(documents(view.container)).toEqual([
      "Para one.\n\n",
      "Para two.\n\nPara th",
    ]);
    expect(markdownRenders).toEqual(["Para one.\n\n", "Para two.\n\nPara th"]);

    markdownRenders.length = 0;
    update("Para one.\n\nPara two.\n\nPara three.", true);
    expect(markdownRenders).toEqual(["Para two.\n\nPara three."]);

    markdownRenders.length = 0;
    update("Para one.\n\nPara two.\n\nPara three.\n\nPara four", true);
    expect(documents(view.container)).toEqual([
      "Para one.\n\nPara two.\n\n",
      "Para three.\n\nPara four",
    ]);

    markdownRenders.length = 0;
    update("Para one.\n\nPara two.\n\nPara three.\n\nPara four.", false);
    expect(documents(view.container)).toEqual([
      "Para one.\n\nPara two.\n\nPara three.\n\nPara four.",
    ]);
    expect(markdownRenders).toEqual([
      "Para one.\n\nPara two.\n\nPara three.\n\nPara four.",
    ]);
  });

  it.each([
    '~~~ts\nconst x = "**text";\n',
    '> ~~~ts\n> const x = "**text";\n',
    '- ```ts\n  const x = "**text";\n',
  ])("preserves fenced code verbatim in the live tail: %s", (source) => {
    const { view } = renderAssistantMessage(source, true);
    expect(documents(view.container)).toEqual([source]);
  });

  it("keeps an open fenced block inside the live tail", () => {
    const { view } = renderAssistantMessage(
      "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n",
      true,
    );
    expect(documents(view.container)).toEqual([
      "Intro.\n\n",
      "```ts\nconst a = 1;\n\nconst b = 2;\n",
    ]);
  });

  it("renders a single document when no boundary is available or when not streaming", () => {
    const { view, update } = renderAssistantMessage("Only one paragraph", true);
    expect(documents(view.container)).toEqual(["Only one paragraph"]);

    update("Para one.\n\nPara two.\n\nPara three", false);
    expect(documents(view.container)).toEqual([
      "Para one.\n\nPara two.\n\nPara three",
    ]);
  });
});
