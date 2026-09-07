// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PromptTextMention, ThreadListEntry } from "@bb/domain";
import type { TimelineTitleLink } from "@bb/thread-view";
import { ConversationMessageContent } from "./ConversationMessageContent";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import type { TimelineTitleActionResolver } from "./TimelineTitleView";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeThreadListEntry as makeThreadListEntryFixture } from "@bb/test-helpers/domain-fixtures";
import { GENERATED_MESSAGE_COLLAPSED_PREVIEW_CHAR_CAP } from "@bb/client-core";
import { generatedConversationCollapsedPreview } from "./GeneratedConversationMessage";

function resolveThreadLink(link: TimelineTitleLink): string | null {
  return link.kind === "thread"
    ? `/projects/proj_demo/threads/${link.threadId}`
    : null;
}

const MARKDOWN_BODY = [
  "# Final report",
  "",
  "Status: **done**. Handed off to @thread:thr_child.",
  "",
  "- migration landed",
  "- `pnpm test` green",
].join("\n");

function renderChildCompleted(text = MARKDOWN_BODY) {
  const token = "@thread:thr_child";
  const start = text.indexOf(token);
  const mentions: readonly PromptTextMention[] =
    start < 0
      ? []
      : [
          {
            start,
            end: start + token.length,
            resource: {
              kind: "thread",
              threadId: "thr_child",
              projectId: "proj_demo",
              label: "Rebuild comments",
            },
          },
        ];
  return render(
    <MemoryRouter>
      <RouteNavigationProvider>
        <ConversationMessageContent
          role="user"
          initiator="system"
          originKind={null}
          senderThreadId={null}
          senderThreadTitle={null}
          resolveSegmentLinkHref={resolveThreadLink}
          systemMessageKind="child-completed"
          systemMessageSubject={{
            kind: "thread",
            threadId: "thr_child",
            threadName: "Rebuild comments",
          }}
          attachments={null}
          mentions={mentions}
          text={text}
          turnRequest={{ kind: "message", status: "accepted" }}
          projectId="proj_demo"
        />
      </RouteNavigationProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const AGENT_BODY = "# notes\nedited path:src/app.ts here";
const AGENT_PATH_TOKEN = "path:src/app.ts";
const AGENT_PATH_START = AGENT_BODY.indexOf(AGENT_PATH_TOKEN);
const OVERFLOWING_ONE_LINE_AGENT_BODY =
  "TEST RESULT refines the diagnosis — RULE OUT eviction. A fire-and-forget direct POST with no wait parameter and no client-held stream should still render the complete report after expansion.";
const RAW_THREAD_ID = "thr_dcwivn5n8w";
const RAW_THREAD_BODY = `Continue in ${RAW_THREAD_ID}; exact code reference \`${RAW_THREAD_ID}\`.\nMore details.`;

function threadListEntry(
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThreadListEntryFixture({
    id: "thr_test",
    projectId: "proj_demo",
    title: "Thread",
    titleFallback: "Thread",
    lastReadAt: 0,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

function renderAgentMessage(
  text = AGENT_BODY,
  {
    senderIsPluginSideChat = false,
    senderThreadTitle = "Worker",
    onTitleAction,
    mentions: suppliedMentions,
  }: {
    mentions?: readonly PromptTextMention[];
    onTitleAction?: TimelineTitleActionResolver;
    senderIsPluginSideChat?: boolean;
    senderThreadTitle?: string;
  } = {},
) {
  const mentions =
    suppliedMentions ??
    (text === AGENT_BODY
      ? [
          {
            start: AGENT_PATH_START,
            end: AGENT_PATH_START + AGENT_PATH_TOKEN.length,
            resource: {
              kind: "path" as const,
              source: "workspace" as const,
              entryKind: "file" as const,
              path: "src/app.ts",
              label: "src/app.ts",
            },
          },
        ]
      : []);

  const rawMentionTarget = threadListEntry({
    id: RAW_THREAD_ID,
    projectId: "proj_target",
    title: "Raw agent mention target",
    titleFallback: "Raw agent mention target",
  });
  const { wrapper } = createQueryClientTestHarness();

  return render(
    <MemoryRouter>
      <RouteNavigationProvider>
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map([[rawMentionTarget.id, rawMentionTarget]])}
        >
          <ConversationMessageContent
            role="user"
            initiator="agent"
            originKind={null}
            senderThreadId="thr_agent"
            senderThreadTitle={senderThreadTitle}
            senderIsPluginSideChat={senderIsPluginSideChat}
            onTitleAction={onTitleAction}
            resolveSegmentLinkHref={resolveThreadLink}
            systemMessageKind="unlabeled"
            systemMessageSubject={null}
            attachments={null}
            mentions={mentions}
            text={text}
            turnRequest={{ kind: "message", status: "accepted" }}
            projectId="proj_demo"
          />
        </ThreadTitleMentionResourcesProvider>
      </RouteNavigationProvider>
    </MemoryRouter>,
    { wrapper },
  );
}

function mockResizeObserverDeliveries(): () => void {
  const observers: Array<{
    callback: ResizeObserverCallback;
    instance: ResizeObserver;
    targets: Set<Element>;
  }> = [];

  class ResizeObserverMock {
    private readonly record: (typeof observers)[number];
    constructor(callback: ResizeObserverCallback) {
      this.record = {
        callback,
        instance: this as unknown as ResizeObserver,
        targets: new Set(),
      };
      observers.push(this.record);
    }
    observe(target: Element): void {
      this.record.targets.add(target);
    }
    unobserve(target: Element): void {
      this.record.targets.delete(target);
    }
    disconnect(): void {
      this.record.targets.clear();
    }
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  return () => {
    act(() => {
      for (const { callback, instance, targets } of observers) {
        callback(
          Array.from(
            targets,
            (target) => ({ target }) as unknown as ResizeObserverEntry,
          ),
          instance,
        );
      }
    });
  };
}

function mockInnerPreviewTextOverflow(text: string): () => void {
  const notifyResize = mockResizeObserverDeliveries();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(20);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(20);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function scrollWidth(this: HTMLElement) {
      return this.textContent === text &&
        (this.tagName === "SPAN" || this.tagName === "DIV")
        ? 240
        : 100;
    },
  );
  return notifyResize;
}

function mockContinuationSensitiveOverflow(): () => void {
  const notifyResize = mockResizeObserverDeliveries();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(20);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(20);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function clientWidth(this: HTMLElement) {
      const continuation = Array.from(this.parentElement?.children ?? []).find(
        (child) => child.textContent === "...",
      );
      return continuation ? 90 : 100;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(100);

  return notifyResize;
}

describe("GeneratedConversationMessage markdown body", () => {
  it("renders the source as a thread pill with title mentions resolved to display text", () => {
    const { container } = renderAgentMessage(AGENT_BODY, {
      senderThreadTitle:
        "Ask @thread:thr_target. Review @docs/foo.test.ts. Keep @owner/repo literal",
    });

    const sourcePill = container.querySelector(
      '[data-prompt-mention-serialized-text="@thread:thr_agent"]',
    );
    expect(sourcePill).not.toBeNull();
    expect(sourcePill?.textContent).toBe(
      "Ask thr_target. Review foo.test.ts. Keep @owner/repo literal",
    );
    expect(screen.queryByText(/@thread:thr_target/u)).toBeNull();
    expect(sourcePill?.className).toContain("prompt-mention-pill");
    expect(sourcePill?.querySelector('[data-icon="UserRound"]')).not.toBeNull();
    expect(sourcePill?.querySelector('[data-icon="MessageSquare"]')).toBeNull();
    expect(sourcePill?.tagName).toBe("A");
    expect(sourcePill?.getAttribute("href")).toBe(
      "/projects/proj_demo/threads/thr_agent",
    );
  });

  it("renders agent Markdown and its offset-based path mention", () => {
    renderAgentMessage();

    fireEvent.click(screen.getByRole("button", { name: /Message from/u }));

    expect(screen.getByRole("heading", { name: "notes" })).toBeTruthy();
    expect(screen.getByText("src/app.ts")).toBeTruthy();
  });

  it("renders prose and exact inline-code raw ids as linked pills when collapsed and expanded", () => {
    const { container } = renderAgentMessage(RAW_THREAD_BODY);
    const toggle = screen.getByRole("button", {
      name: /Message from Worker/u,
    });

    const collapsedLinks = screen.getAllByRole("link", {
      name: "Raw agent mention target",
    });
    expect(collapsedLinks).toHaveLength(2);
    expect(
      collapsedLinks.every(
        (link) =>
          link.getAttribute("href") ===
          `/projects/proj_target/threads/${RAW_THREAD_ID}`,
      ),
    ).toBe(true);
    expect(container.querySelector("code")).toBeNull();

    fireEvent.click(toggle);

    const expandedLinks = screen.getAllByRole("link", {
      name: "Raw agent mention target",
    });
    expect(expandedLinks).toHaveLength(2);
    expect(
      expandedLinks.every(
        (link) =>
          link.getAttribute("href") ===
          `/projects/proj_target/threads/${RAW_THREAD_ID}`,
      ),
    ).toBe(true);
    expect(container.querySelector("code")).toBeNull();
  });

  it("bounds a long single-line preview and reveals the complete body after expansion", () => {
    const visiblePrefix = "VISIBLE_GENERATED_PREFIX";
    const hiddenTail = "FULL_GENERATED_MESSAGE_TAIL";
    const text = `${visiblePrefix} ${"x".repeat(
      GENERATED_MESSAGE_COLLAPSED_PREVIEW_CHAR_CAP,
    )} ${hiddenTail}`;

    const preview = generatedConversationCollapsedPreview(text);
    expect(preview.wasCapped).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(
      GENERATED_MESSAGE_COLLAPSED_PREVIEW_CHAR_CAP,
    );

    renderAgentMessage(text);

    expect(screen.getByText(visiblePrefix)).toBeTruthy();
    expect(screen.queryByText(hiddenTail)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Message from Worker/u }),
    );

    expect(screen.getByText(new RegExp(hiddenTail, "u"))).toBeTruthy();
  });

  it("keeps complete structured and raw thread mentions in a capped preview", () => {
    const pathToken = "path:src/safe-prefix.ts";
    const prefix = `Use ${pathToken} with ${RAW_THREAD_ID}. `;
    const text = `${prefix}${"tail ".repeat(900)}HIDDEN`;
    const pathStart = text.indexOf(pathToken);

    const { container } = renderAgentMessage(text, {
      mentions: [
        {
          start: pathStart,
          end: pathStart + pathToken.length,
          resource: {
            kind: "path",
            source: "workspace",
            entryKind: "file",
            path: "src/safe-prefix.ts",
            label: "safe-prefix.ts",
          },
        },
      ],
    });

    expect(
      container.querySelector(
        '[data-prompt-mention-serialized-text="path:src/safe-prefix.ts"]',
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Raw agent mention target" }),
    ).toBeTruthy();
  });

  it("omits an offset mention crossing the collapsed cap and restores it after expansion", () => {
    const crossingToken = "path:src/crossing-boundary.ts";
    const prefix = "x ".repeat(
      (GENERATED_MESSAGE_COLLAPSED_PREVIEW_CHAR_CAP - 6) / 2,
    );
    const text = `${prefix}${crossingToken} after`;
    const mentionStart = text.indexOf(crossingToken);
    const { container } = renderAgentMessage(text, {
      mentions: [
        {
          start: mentionStart,
          end: mentionStart + crossingToken.length,
          resource: {
            kind: "path",
            source: "workspace",
            entryKind: "file",
            path: "src/crossing-boundary.ts",
            label: "crossing-boundary.ts",
          },
        },
      ],
    });

    expect(
      container.querySelector(
        '[data-prompt-mention-serialized-text="path:src/crossing-boundary.ts"]',
      ),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Message from Worker/u }),
    );

    expect(
      container.querySelector(
        '[data-prompt-mention-serialized-text="path:src/crossing-boundary.ts"]',
      ),
    ).not.toBeNull();
  });

  it("keeps a raw thread id literal when its inline-code span crosses the collapsed cap", () => {
    const text = `Before \`${RAW_THREAD_ID} ${"code ".repeat(900)}END\` after`;
    const { container } = renderAgentMessage(text);

    expect(container.querySelector("code")?.textContent).toContain(
      RAW_THREAD_ID,
    );
    expect(
      screen.queryByRole("link", { name: "Raw agent mention target" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Message from Worker/u }),
    );

    expect(container.querySelector("code")?.textContent).toContain(
      RAW_THREAD_ID,
    );
    expect(
      screen.queryByRole("link", { name: "Raw agent mention target" }),
    ).toBeNull();
  });

  it("does not close a capped mixed code span into an exact raw-id pill", () => {
    const prefix = "x".repeat(
      GENERATED_MESSAGE_COLLAPSED_PREVIEW_CHAR_CAP - RAW_THREAD_ID.length - 1,
    );
    const text = `${prefix}\`${RAW_THREAD_ID} remains mixed\` tail`;
    const { container } = renderAgentMessage(text);

    expect(
      screen.queryByRole("link", { name: "Raw agent mention target" }),
    ).toBeNull();
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toContain(`\`${RAW_THREAD_ID}`);

    fireEvent.click(
      screen.getByRole("button", { name: /Message from Worker/u }),
    );

    expect(
      screen.queryByRole("link", { name: "Raw agent mention target" }),
    ).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(
      `${RAW_THREAD_ID} remains mixed`,
    );
  });

  it("does not close a first-line mixed code span into an exact raw-id pill", () => {
    const text = `\`${RAW_THREAD_ID}\nremains mixed\``;
    const { container } = renderAgentMessage(text);

    expect(
      screen.queryByRole("link", { name: "Raw agent mention target" }),
    ).toBeNull();
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toContain(`\`${RAW_THREAD_ID}`);

    fireEvent.click(
      screen.getByRole("button", { name: /Message from Worker/u }),
    );

    expect(
      screen.queryByRole("link", { name: "Raw agent mention target" }),
    ).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(
      `${RAW_THREAD_ID} remains mixed`,
    );
  });

  it("preserves an unmatched backtick in an untruncated agent preview", () => {
    const { container } = renderAgentMessage("hello `world");

    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toContain("hello `world");
  });

  it("does not mount remote Markdown images for ordinary agent messages", () => {
    const { container } = renderAgentMessage(
      "![Remote diagram](https://example.com/private.png)\nExpanded details",
    );

    expect(container.querySelector("img, source")).toBeNull();
    expect(screen.getByText("[Image: Remote diagram]")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Message from Worker/u }),
    );

    expect(container.querySelector("img, source")).toBeNull();
    expect(screen.getByText("[Image: Remote diagram]")).toBeTruthy();
  });

  it("does not execute Mermaid diagrams in ordinary agent messages", () => {
    const source = [
      "```mermaid",
      "architecture-beta",
      'service tracker(image: "https://example.com/private.png")',
      "```",
    ].join("\n");
    const { container } = renderAgentMessage(source);

    fireEvent.click(
      screen.getByRole("button", { name: /Message from Worker/u }),
    );

    expect(container.querySelector("pre code")?.textContent).toContain(
      "https://example.com/private.png",
    );
    expect(screen.getByText("mermaid")).not.toBeNull();
    expect(screen.queryByText("Rendering diagram...")).toBeNull();
    expect(screen.queryByRole("img", { name: "Mermaid diagram" })).toBeNull();
  });

  it("expands a one-line agent message when its preview text overflows", () => {
    const notifyResize = mockInnerPreviewTextOverflow(
      OVERFLOWING_ONE_LINE_AGENT_BODY,
    );
    renderAgentMessage(OVERFLOWING_ONE_LINE_AGENT_BODY);
    notifyResize();

    const toggle = screen.getByRole("button", { name: /Message from Worker/u });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("...").className).toContain("invisible");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(OVERFLOWING_ONE_LINE_AGENT_BODY)).toBeTruthy();
  });

  it("renders side-chat handoffs as markdown", () => {
    renderAgentMessage("**Ready** to merge.\n\n- checks passed", {
      senderIsPluginSideChat: true,
    });

    expect(screen.getByText("Ready").tagName).toBe("STRONG");
    expect(screen.queryByText("**Ready** to merge.")).toBeNull();

    const toggle = screen.getByRole("button", {
      name: /Replying to side chat/u,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(screen.getByRole("list").textContent).toContain("checks passed");
  });

  it("keeps Markdown images enabled for plugin side chats", () => {
    const { container } = renderAgentMessage(
      "![Side-chat diagram](https://example.com/side-chat.png)\nDetails",
      { senderIsPluginSideChat: true },
    );

    expect(
      container.querySelector('img[alt="Side-chat diagram"]'),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Replying to side chat/u }),
    );

    expect(
      container.querySelector('img[alt="Side-chat diagram"]'),
    ).not.toBeNull();
  });

  it("opens a side-chat sender in the plugin panel instead of linking it", () => {
    const openPanel = vi.fn();
    const { container } = renderAgentMessage("Handed back.", {
      senderIsPluginSideChat: true,
      onTitleAction: (action) =>
        action.kind === "open-plugin-side-chat" ? openPanel : null,
    });

    const sourcePill = container.querySelector(
      '[data-prompt-mention-serialized-text="@thread:thr_agent"]',
    );
    expect(sourcePill?.tagName).not.toBe("A");
    fireEvent.click(sourcePill as Element);
    expect(openPanel).toHaveBeenCalledOnce();
  });
});

describe("GeneratedConversationMessage markdown body (system)", () => {
  it("keeps the continuation width stable when it makes the preview overflow", () => {
    const notifyResize = mockContinuationSensitiveOverflow();
    renderChildCompleted();
    notifyResize();

    const continuation = screen.getByText("...");
    expect(continuation.className).toContain("invisible");

    notifyResize();
    notifyResize();

    expect(screen.getByText("...")).toBe(continuation);
    expect(continuation.className).toContain("invisible");
  });

  it("shows a first-line preview and reveals the rest when expanded", () => {
    renderChildCompleted();

    expect(screen.getByText("Final report")).toBeTruthy();
    expect(screen.queryByText("migration landed")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Rebuild comments finished/u }),
    );

    expect(screen.getByText("migration landed")).toBeTruthy();
  });

  it("keeps Markdown images enabled for system messages", () => {
    const { container } = renderChildCompleted(
      "![System diagram](https://example.com/system.png)\nDetails",
    );

    expect(container.querySelector('img[alt="System diagram"]')).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Rebuild comments finished/u }),
    );

    expect(container.querySelector('img[alt="System diagram"]')).not.toBeNull();
  });
});
