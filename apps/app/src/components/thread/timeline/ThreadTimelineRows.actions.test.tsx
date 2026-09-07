// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps, type ReactElement } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import { POINTER_COARSE_QUERY } from "@bb/shared-ui/hooks/use-pointer-coarse";
import type { PluginMessageActionRegistration } from "@get-bb/plugin-sdk";
import {
  conversationRow,
  delegationRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "@/lib/plugin-slots";
import { ThreadTimelineRows } from "./ThreadTimelineRows";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

function messageActionRegistrationSet(
  messageActions: readonly PluginMessageActionRegistration[],
): PluginRegistrationSet {
  return makePluginRegistrationSet({
    messageActions,
  });
}

const toMarkup = (ui: ReactElement) =>
  renderToStaticMarkup(<MemoryRouter>{ui}</MemoryRouter>);
const renderWithRouter = (
  ui: ReactElement,
  initialEntries: ComponentProps<typeof MemoryRouter>["initialEntries"] = ["/"],
) => render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);

function SameThreadSearchNavigationHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          navigate("/thread", {
            state: { searchMessageSeq: 12, searchThreadId: "thr_main" },
          })
        }
      >
        Open search match
      </button>
      <ThreadTimelineRows
        initialExpanded={new Set(["turn_with_match"])}
        threadId="thr_main"
        timelineRows={[
          turnRow({
            id: "turn_with_match",
            sourceSeqStart: 10,
            sourceSeqEnd: 20,
            children: [
              conversationRow({
                id: "nested_match",
                role: "assistant",
                text: "Nested answer containing the search result.",
                sourceSeqStart: 12,
                sourceSeqEnd: 12,
                threadId: "thr_main",
              }),
            ],
            threadId: "thr_main",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />
    </>
  );
}

function EditActionAvailabilityHarness({
  onEditMessage,
}: {
  onEditMessage: NonNullable<
    ComponentProps<typeof ThreadTimelineRows>["onEditMessage"]
  >;
}) {
  const [rows] = useState(() => [
    conversationRow({
      id: "earlier_user_message",
      role: "user",
      text: "An earlier request.",
      sourceSeqStart: 3,
    }),
    conversationRow({
      id: "latest_user_message",
      role: "user",
      text: "The latest request.",
      sourceSeqStart: 7,
    }),
  ]);
  return (
    <ThreadTimelineRows
      timelineRows={rows}
      onEditMessage={onEditMessage}
      threadRuntimeDisplayStatus="active"
      workspaceRootPath={undefined}
    />
  );
}

function SearchOlderRowsHarness({
  onLoadOlderRows,
}: {
  onLoadOlderRows: () => void;
}) {
  const [loadedOlderRows, setLoadedOlderRows] = useState(false);
  const rows = loadedOlderRows
    ? [
        conversationRow({
          id: "older_match",
          role: "assistant",
          text: "Older answer containing the search result.",
          sourceSeqStart: 12,
          sourceSeqEnd: 12,
          threadId: "thr_main",
        }),
        conversationRow({
          id: "latest_message",
          role: "assistant",
          text: "Latest answer.",
          sourceSeqStart: 30,
          sourceSeqEnd: 30,
          threadId: "thr_main",
        }),
      ]
    : [
        conversationRow({
          id: "latest_message",
          role: "assistant",
          text: "Latest answer.",
          sourceSeqStart: 30,
          sourceSeqEnd: 30,
          threadId: "thr_main",
        }),
      ];

  return (
    <ThreadTimelineRows
      threadId="thr_main"
      timelineRows={rows}
      hasOlderTimelineRows={!loadedOlderRows}
      isLoadingOlderTimelineRows={false}
      onLoadOlderRows={() => {
        onLoadOlderRows();
        setLoadedOlderRows(true);
      }}
      threadRuntimeDisplayStatus="idle"
      workspaceRootPath={undefined}
    />
  );
}

function SearchOlderRowsFailedLoadHarness({
  onLoadOlderRows,
}: {
  onLoadOlderRows: () => void;
}) {
  const [isLoadingOlderRows, setIsLoadingOlderRows] = useState(false);

  return (
    <>
      <span data-testid="older-load-state">
        {isLoadingOlderRows ? "loading" : "idle"}
      </span>
      <ThreadTimelineRows
        threadId="thr_main"
        timelineRows={[
          conversationRow({
            id: "latest_message",
            role: "assistant",
            text: "Latest answer.",
            sourceSeqStart: 30,
            sourceSeqEnd: 30,
            threadId: "thr_main",
          }),
        ]}
        hasOlderTimelineRows
        isLoadingOlderTimelineRows={isLoadingOlderRows}
        onLoadOlderRows={() => {
          onLoadOlderRows();
          setIsLoadingOlderRows(true);
          return Promise.resolve().then(() => {
            setIsLoadingOlderRows(false);
            throw new Error("Older page failed");
          });
        }}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />
    </>
  );
}

function mockWindowSelection({ node, text }: { node: Node; text: string }) {
  const rect = new DOMRect(10, 20, 30, 8);
  const range = {
    commonAncestorContainer: node,
    getBoundingClientRect: () => rect,
    getClientRects: () => ({
      length: 1,
      item: (index: number) => (index === 0 ? rect : null),
    }),
  } as unknown as Range;
  vi.spyOn(window, "getSelection").mockReturnValue({
    anchorNode: node,
    focusNode: node,
    getRangeAt: () => range,
    isCollapsed: false,
    rangeCount: 1,
    removeAllRanges: vi.fn(),
    toString: () => text,
  } as unknown as Selection);
}

function mockSelectionMenuMedia({
  isCompactViewport = false,
  isPointerCoarse = false,
}: {
  isCompactViewport?: boolean;
  isPointerCoarse?: boolean;
} = {}) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches:
      (query === COMPACT_VIEWPORT_QUERY && isCompactViewport) ||
      (query === POINTER_COARSE_QUERY && isPointerCoarse),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  vi.restoreAllMocks();
});

describe("ThreadTimelineRows actions", () => {
  it("uses inline mobile actions only for the last assistant message", () => {
    const { container } = renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            id: "earlier_agent_message",
            role: "assistant",
            text: "An earlier answer.",
          }),
          conversationRow({
            id: "latest_agent_message",
            role: "assistant",
            text: "The latest answer.",
          }),
        ]}
        canSpawnChild
        onForkMessage={vi.fn()}
        onMessageAddToChat={vi.fn()}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    const earlierMessage = container.querySelector(
      '[data-timeline-row-id="earlier_agent_message"]',
    );
    const latestMessage = container.querySelector(
      '[data-timeline-row-id="latest_agent_message"]',
    );

    expect(
      earlierMessage?.querySelector('[aria-label="Message actions"]'),
    ).not.toBeNull();
    expect(
      latestMessage?.querySelector('[aria-label="Message actions"]'),
    ).toBeNull();
  });

  it("uses inline mobile actions only for the last user message", () => {
    const { container } = renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            id: "earlier_user_message",
            role: "user",
            text: "An earlier request.",
          }),
          conversationRow({
            id: "latest_user_message",
            role: "user",
            text: "The latest request.",
          }),
        ]}
        onSelectionAddToChat={vi.fn()}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    const earlierMessage = container.querySelector(
      '[data-timeline-row-id="earlier_user_message"]',
    );
    const latestMessage = container.querySelector(
      '[data-timeline-row-id="latest_user_message"]',
    );

    expect(
      earlierMessage?.querySelector('[aria-label="Message actions"]'),
    ).not.toBeNull();
    expect(
      latestMessage?.querySelector('[aria-label="Message actions"]'),
    ).toBeNull();
  });

  it("keeps edit actions available while the thread is active", () => {
    const onEditMessage = vi.fn();
    renderWithRouter(
      <EditActionAvailabilityHarness onEditMessage={onEditMessage} />,
    );
    const editButtons = screen.getAllByRole("button", {
      name: "Edit message",
    });
    expect(editButtons).toHaveLength(2);
    fireEvent.click(editButtons[0]!);
    expect(onEditMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "earlier_user_message" }),
    );
  });

  it("does not offer edit for a steer request", () => {
    const markup = toMarkup(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "user",
            text: "Change direction.",
            turnRequest: {
              isGrouped: false,
              kind: "steer",
              status: "accepted",
            },
          }),
        ]}
        onEditMessage={vi.fn()}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    expect(markup).not.toContain('aria-label="Edit message"');
  });

  it("does not offer edit for one bubble in a grouped request", () => {
    const markup = toMarkup(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "user",
            text: "One message in a group.",
            turnRequest: {
              isGrouped: true,
              kind: "message",
              status: "accepted",
            },
          }),
        ]}
        onEditMessage={vi.fn()}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    expect(markup).not.toContain('aria-label="Edit message"');
  });

  it("offers edit for an attachment-only request without requiring add-to-chat", () => {
    const onEditMessage = vi.fn();
    renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "user",
            text: "",
            sourceSeqStart: 11,
            attachments: {
              webImages: 0,
              localImages: 1,
              localFiles: 0,
              imageUrls: [],
              localImagePaths: ["uploads/screenshot.png"],
              localFilePaths: [],
            },
          }),
        ]}
        onEditMessage={onEditMessage}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(onEditMessage).toHaveBeenCalledWith({
      messageId: expect.any(String),
      expectedRequestSequence: 11,
      input: [{ type: "localImage", path: "uploads/screenshot.png" }],
    });
  });

  it("adds a copy action to a remote-image-only row", () => {
    const { container } = renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            id: "actionable_user_message",
            role: "user",
            text: "A request with actions.",
          }),
          conversationRow({
            id: "remote_image_only_message",
            role: "user",
            text: "",
            attachments: {
              webImages: 1,
              localImages: 0,
              localFiles: 0,
              imageUrls: ["https://example.com/remote.png"],
              localImagePaths: [],
              localFilePaths: [],
            },
          }),
        ]}
        onSelectionAddToChat={vi.fn()}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    const actionableMessage = container.querySelector(
      '[data-timeline-row-id="actionable_user_message"]',
    );
    const remoteImageOnlyMessage = container.querySelector(
      '[data-timeline-row-id="remote_image_only_message"]',
    );
    expect(
      actionableMessage?.querySelector('[aria-label="Message actions"]'),
    ).toBeNull();
    expect(
      actionableMessage?.querySelector('[aria-label="Copy message"]'),
    ).not.toBeNull();
    expect(
      remoteImageOnlyMessage?.querySelector('[aria-label="Copy message"]'),
    ).not.toBeNull();
  });

  it("keeps the last text footer inline when an attachment-only row has no add action", () => {
    const { container } = renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            id: "copyable_user_message",
            role: "user",
            text: "A request that can be copied.",
          }),
          conversationRow({
            id: "local_attachment_only_message",
            role: "user",
            text: "",
            attachments: {
              webImages: 0,
              localImages: 0,
              localFiles: 1,
              imageUrls: [],
              localImagePaths: [],
              localFilePaths: ["uploads/spec.md"],
            },
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    const copyableMessage = container.querySelector(
      '[data-timeline-row-id="copyable_user_message"]',
    );
    const attachmentOnlyMessage = container.querySelector(
      '[data-timeline-row-id="local_attachment_only_message"]',
    );
    expect(
      copyableMessage?.querySelector('[aria-label="Message actions"]'),
    ).toBeNull();
    expect(
      copyableMessage?.querySelector('[aria-label="Copy message"]'),
    ).not.toBeNull();
    expect(
      attachmentOnlyMessage?.querySelector('[aria-label="Message actions"]'),
    ).toBeNull();
  });

  it("renders send-to-main on assistant rows when the timeline supplies a handler", () => {
    const markup = toMarkup(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "assistant",
            text: "Use this answer in the main chat.",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        onSendToMainMessage={() => undefined}
        workspaceRootPath={undefined}
      />,
    );

    expect(markup).toContain('aria-label="Send to main thread"');
  });

  it("hides assistant message actions inside completed turn summaries", () => {
    const markup = toMarkup(
      <ThreadTimelineRows
        initialExpanded={new Set(["turn_completed"])}
        timelineRows={[
          turnRow({
            id: "turn_completed",
            status: "completed",
            durationMs: 1_000,
            children: [
              conversationRow({
                id: "agent_completed",
                role: "assistant",
                text: "Archived assistant response.",
              }),
            ],
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    expect(markup).toContain("Worked for");
    expect(markup).toContain("Archived assistant response.");
    expect(markup).not.toContain('aria-label="Copy message"');
  });

  it("keeps assistant message actions visible inside pending turn rows", () => {
    const markup = toMarkup(
      <ThreadTimelineRows
        initialExpanded={new Set(["turn_pending"])}
        timelineRows={[
          turnRow({
            id: "turn_pending",
            status: "pending",
            durationMs: null,
            children: [
              conversationRow({
                id: "agent_pending",
                role: "assistant",
                text: "Streaming assistant response.",
              }),
            ],
          }),
        ]}
        threadRuntimeDisplayStatus="active"
        workspaceRootPath={undefined}
      />,
    );

    expect(markup).toContain("Working");
    expect(markup).toContain("Streaming assistant response.");
    expect(markup).toContain('aria-label="Copy message"');
    expect(markup).not.toContain('aria-label="Message actions"');
    expect(markup).toContain("max-md:pointer-coarse:opacity-100");
  });

  it("hides assistant message actions inside delegation rows", () => {
    const markup = toMarkup(
      <ThreadTimelineRows
        initialExpanded={new Set(["delegation_with_child_answer"])}
        timelineRows={[
          conversationRow({
            id: "top_level_agent",
            role: "assistant",
            text: "Top-level agent response.",
          }),
          delegationRow({
            id: "delegation_with_child_answer",
            status: "pending",
            durationMs: null,
            output: "Nested final answer.",
            childRows: [
              conversationRow({
                id: "nested_agent_progress",
                role: "assistant",
                text: "Nested subagent progress.",
              }),
            ],
          }),
        ]}
        threadRuntimeDisplayStatus="active"
        workspaceRootPath={undefined}
      />,
    );

    expect(markup).toContain("Top-level agent response.");
    expect(markup).toContain("Nested subagent progress.");
    expect(markup).toContain("Nested final answer.");
    expect(markup.match(/aria-label="Copy message"/g)).toHaveLength(1);
  });

  it("passes agent message text to add-to-chat", () => {
    const onMessageAddToChat = vi.fn();
    renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "assistant",
            text: "Quote this agent response.",
          }),
        ]}
        onMessageAddToChat={onMessageAddToChat}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onMessageAddToChat).toHaveBeenCalledWith(
      "Quote this agent response.",
    );
  });

  it("passes agent message attachments to add-to-chat", () => {
    const onMessageAddToChat = vi.fn();
    renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "assistant",
            text: "Quote this agent response.",
            attachments: {
              webImages: 1,
              localImages: 1,
              localFiles: 1,
              imageUrls: ["https://example.com/remote.png"],
              localImagePaths: ["uploads/screenshot.png"],
              localFilePaths: ["uploads/spec.md"],
            },
          }),
        ]}
        onMessageAddToChat={onMessageAddToChat}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onMessageAddToChat).toHaveBeenCalledWith(
      "Quote this agent response.",
      [
        {
          type: "localImage",
          path: "uploads/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 0,
        },
      ],
    );
  });

  it("passes regular user message text to add-to-chat", () => {
    const onSelectionAddToChat = vi.fn();
    renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "user",
            text: "  Quote this user prompt.  ",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        onSelectionAddToChat={onSelectionAddToChat}
        workspaceRootPath={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onSelectionAddToChat).toHaveBeenCalledWith(
      "Quote this user prompt.",
    );
  });

  it("passes user message attachments to add-to-chat", () => {
    const onSelectionAddToChat = vi.fn();
    renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "user",
            text: "  Quote this user prompt.  ",
            attachments: {
              webImages: 1,
              localImages: 1,
              localFiles: 1,
              imageUrls: ["https://example.com/remote.png"],
              localImagePaths: ["uploads/screenshot.png"],
              localFilePaths: ["uploads/spec.md"],
            },
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        onSelectionAddToChat={onSelectionAddToChat}
        workspaceRootPath={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onSelectionAddToChat).toHaveBeenCalledWith(
      "Quote this user prompt.",
      [
        {
          type: "localImage",
          path: "uploads/screenshot.png",
          name: "screenshot.png",
          sizeBytes: 0,
        },
        {
          type: "localFile",
          path: "uploads/spec.md",
          name: "spec.md",
          sizeBytes: 0,
        },
      ],
    );
  });

  it("shows add-to-chat for attachment-only user messages", () => {
    const onSelectionAddToChat = vi.fn();
    renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "user",
            text: "",
            attachments: {
              webImages: 0,
              localImages: 0,
              localFiles: 1,
              imageUrls: [],
              localImagePaths: [],
              localFilePaths: ["uploads/spec.md"],
            },
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        onSelectionAddToChat={onSelectionAddToChat}
        workspaceRootPath={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onSelectionAddToChat).toHaveBeenCalledWith("", [
      {
        type: "localFile",
        path: "uploads/spec.md",
        name: "spec.md",
        sizeBytes: 0,
      },
    ]);
  });

  it("hides user message add-to-chat when no add handler is supplied", () => {
    const markup = toMarkup(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "user",
            text: "No add-to-chat handler here.",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    expect(markup).toContain('aria-label="Copy message"');
    expect(markup).not.toContain('aria-label="Add to chat"');
  });

  it("does not let the previously selected row clear a new row selection", async () => {
    const onSelectionAddToChat = vi.fn();
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const flushSelectionFrames = async () => {
      await act(async () => {
        while (frameCallbacks.length > 0) {
          frameCallbacks.shift()?.(performance.now());
        }
      });
    };

    renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            id: "earlier_selection_row",
            role: "assistant",
            text: "Select this earlier answer.",
            sourceSeqEnd: 20,
          }),
          conversationRow({
            id: "later_selection_row",
            role: "assistant",
            text: "Select this later answer.",
            sourceSeqEnd: 40,
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        onSelectionAddToChat={onSelectionAddToChat}
        workspaceRootPath={undefined}
      />,
    );

    const laterTextNode = screen.getByText(
      "Select this later answer.",
    ).firstChild;
    expect(laterTextNode).not.toBeNull();
    mockWindowSelection({ node: laterTextNode!, text: "later answer" });
    fireEvent(document, new Event("selectionchange"));
    await flushSelectionFrames();
    await screen.findByRole("button", { name: "Add to chat" });

    const earlierTextNode = screen.getByText(
      "Select this earlier answer.",
    ).firstChild;
    expect(earlierTextNode).not.toBeNull();
    mockWindowSelection({ node: earlierTextNode!, text: "earlier answer" });
    fireEvent(document, new Event("selectionchange"));
    await flushSelectionFrames();
    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));

    expect(onSelectionAddToChat).toHaveBeenLastCalledWith("earlier answer");
  });

  it("shows the floating selection menu on coarse pointers", async () => {
    mockSelectionMenuMedia({ isPointerCoarse: true });
    const onSelectionAddToChat = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "assistant",
            text: "Mobile selection should expose chat actions.",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        onSelectionAddToChat={onSelectionAddToChat}
        workspaceRootPath={undefined}
      />,
    );
    const textNode = screen.getByText(
      "Mobile selection should expose chat actions.",
    ).firstChild;
    expect(textNode).not.toBeNull();
    mockWindowSelection({
      node: textNode!,
      text: "chat actions",
    });

    await act(async () => {
      fireEvent(document, new Event("selectionchange"));
    });

    const addToChat = await screen.findByRole("button", {
      name: "Add to chat",
    });
    fireEvent.click(addToChat);
    expect(onSelectionAddToChat).toHaveBeenCalledWith("chat actions");
  });

  it("keeps the floating selection menu on compact fine-pointer viewports", async () => {
    mockSelectionMenuMedia({ isCompactViewport: true });
    const onSelectionAddToChat = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            role: "assistant",
            text: "Compact fine pointer keeps the floating selection menu.",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        onSelectionAddToChat={onSelectionAddToChat}
        workspaceRootPath={undefined}
      />,
    );
    const textNode = screen.getByText(
      "Compact fine pointer keeps the floating selection menu.",
    ).firstChild;
    expect(textNode).not.toBeNull();
    mockWindowSelection({
      node: textNode!,
      text: "floating selection menu",
    });

    fireEvent(document, new Event("selectionchange"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add to chat" })).toBeTruthy(),
    );
  });

  it("ignores thread-search scroll state for a different thread", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const { container } = renderWithRouter(
      <ThreadTimelineRows
        threadId="thr_side_chat"
        timelineRows={[
          conversationRow({
            id: "side_chat_message",
            role: "assistant",
            text: "Side chat answer.",
            sourceSeqStart: 12,
            sourceSeqEnd: 12,
            threadId: "thr_side_chat",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
      [
        {
          pathname: "/thread",
          state: { searchMessageSeq: 12, searchThreadId: "thr_main" },
        },
      ],
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(
      container
        .querySelector('[data-timeline-row-id="side_chat_message"]')
        ?.classList.contains("bb-search-flash"),
    ).toBe(false);
  });

  it("scrolls thread-search matches to the nested row instead of the containing parent", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    const { container } = renderWithRouter(
      <ThreadTimelineRows
        threadId="thr_main"
        timelineRows={[
          turnRow({
            id: "turn_with_match",
            sourceSeqStart: 10,
            sourceSeqEnd: 20,
            children: [
              conversationRow({
                id: "nested_match",
                role: "assistant",
                text: "Nested answer containing the search result.",
                sourceSeqStart: 12,
                sourceSeqEnd: 12,
                threadId: "thr_main",
              }),
            ],
            threadId: "thr_main",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
      [
        {
          pathname: "/thread",
          state: { searchMessageSeq: 12, searchThreadId: "thr_main" },
        },
      ],
    );

    const parentRow = container.querySelector(
      '[data-timeline-row-id="turn_with_match"]',
    );
    const nestedRow = await waitFor(() => {
      const row = container.querySelector(
        '[data-timeline-row-id="nested_match"]',
      );
      if (row === null) {
        throw new Error("Nested search row was not rendered");
      }
      return row;
    });

    await waitFor(() =>
      expect(nestedRow.classList.contains("bb-search-flash")).toBe(true),
    );
    expect(parentRow?.classList.contains("bb-search-flash")).toBe(false);
  });

  it("cancels the follow-up search reveals when the rows unmount", () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(
        (callback) => {
          callback(performance.now());
          return 1;
        },
      );
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
      });

      const view = renderWithRouter(
        <ThreadTimelineRows
          threadId="thr_main"
          timelineRows={[
            conversationRow({
              id: "match",
              role: "assistant",
              text: "Answer containing the search result.",
              sourceSeqStart: 12,
              sourceSeqEnd: 12,
              threadId: "thr_main",
            }),
          ]}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />,
        [
          {
            pathname: "/thread",
            state: { searchMessageSeq: 12, searchThreadId: "thr_main" },
          },
        ],
      );
      view.unmount();

      const querySelector = vi.spyOn(document, "querySelector");
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(querySelector).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads older timeline rows before scrolling to an older thread-search match", async () => {
    const onLoadOlderRows = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    const { container } = renderWithRouter(
      <SearchOlderRowsHarness onLoadOlderRows={onLoadOlderRows} />,
      [
        {
          pathname: "/thread",
          state: { searchMessageSeq: 12, searchThreadId: "thr_main" },
        },
      ],
    );

    await waitFor(() => expect(onLoadOlderRows).toHaveBeenCalledTimes(1));
    const olderRow = await waitFor(() => {
      const row = container.querySelector(
        '[data-timeline-row-id="older_match"]',
      );
      if (row === null) {
        throw new Error("Older search row was not rendered");
      }
      return row;
    });

    await waitFor(() =>
      expect(olderRow.classList.contains("bb-search-flash")).toBe(true),
    );
  });

  it("does not retry failed older-row auto-loading until rows advance", async () => {
    const onLoadOlderRows = vi.fn();

    renderWithRouter(
      <SearchOlderRowsFailedLoadHarness onLoadOlderRows={onLoadOlderRows} />,
      [
        {
          pathname: "/thread",
          state: { searchMessageSeq: 12, searchThreadId: "thr_main" },
        },
      ],
    );

    await waitFor(() => expect(onLoadOlderRows).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("older-load-state").textContent).toBe("idle"),
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
  });

  it("renders plugin message actions on user and assistant rows with the narrow message reference", () => {
    const run = vi.fn();
    setPluginSlotRegistrations(
      "demo",
      messageActionRegistrationSet([
        { id: "summarize", title: "Summarize", icon: "Zap", run },
      ]),
    );
    const onOpenPluginPanel = vi.fn().mockReturnValue(true);
    const { container } = renderWithRouter(
      <ThreadTimelineRows
        threadId="thr_main"
        timelineRows={[
          conversationRow({
            id: "user_row",
            role: "user",
            text: "A user request.",
            sourceSeqEnd: 7,
            threadId: "thr_main",
          }),
          conversationRow({
            id: "assistant_row",
            role: "assistant",
            text: "An assistant answer.",
            sourceSeqEnd: 9,
            threadId: "thr_main",
          }),
        ]}
        onOpenPluginPanel={onOpenPluginPanel}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    const userRow = container.querySelector(
      '[data-timeline-row-id="user_row"]',
    );
    expect(userRow?.querySelector('[aria-label="Summarize"]')).not.toBeNull();

    const assistantRow = container.querySelector(
      '[data-timeline-row-id="assistant_row"]',
    );
    const assistantAction = assistantRow?.querySelector(
      '[aria-label="Summarize"]',
    );
    expect(assistantAction).not.toBeNull();
    fireEvent.click(assistantAction!);
    expect(run).toHaveBeenCalledTimes(1);
    const context = run.mock.calls[0]![0];
    expect(context.threadId).toBe("thr_main");
    expect(context.message).toEqual({
      id: "assistant_row",
      threadId: "thr_main",
      role: "assistant",
      text: "An assistant answer.",
      sourceSeqEnd: 9,
    });
    expect(context.selectedText).toBeUndefined();
    expect(context.openPanel({ actionId: "panel", params: { a: 1 } })).toBe(
      true,
    );
    expect(onOpenPluginPanel).toHaveBeenCalledWith({
      pluginId: "demo",
      actionId: "panel",
      params: { a: 1 },
    });
  });

  it("omits plugin message actions when the surface has no thread identity", () => {
    setPluginSlotRegistrations(
      "demo",
      messageActionRegistrationSet([
        { id: "summarize", title: "Summarize", run: vi.fn() },
      ]),
    );
    const markup = toMarkup(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({ role: "assistant", text: "An answer." }),
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );
    expect(markup).not.toContain('aria-label="Summarize"');
  });

  it("contains plugin message action errors without breaking the timeline", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPluginSlotRegistrations(
      "demo",
      messageActionRegistrationSet([
        {
          id: "explodes",
          title: "Explodes",
          run: () => {
            throw new Error("kaboom");
          },
        },
        {
          id: "rejects",
          title: "Rejects",
          run: () => Promise.reject(new Error("async kaboom")),
        },
      ]),
    );
    renderWithRouter(
      <ThreadTimelineRows
        threadId="thr_main"
        timelineRows={[
          conversationRow({
            role: "assistant",
            text: "An answer.",
            threadId: "thr_main",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Explodes" }));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('messageAction "explodes" failed: kaboom'),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rejects" }));
    return waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('messageAction "rejects" failed: async kaboom'),
      ),
    );
  });

  it("renders consumer message actions filtered by role with the message reference", () => {
    const run = vi.fn();
    renderWithRouter(
      <ThreadTimelineRows
        threadId="thr_main"
        timelineRows={[
          conversationRow({
            id: "user_row",
            role: "user",
            text: "A user request.",
            sourceSeqEnd: 7,
            threadId: "thr_main",
          }),
          conversationRow({
            id: "assistant_row",
            role: "assistant",
            text: "An assistant answer.",
            sourceSeqEnd: 9,
            threadId: "thr_main",
          }),
        ]}
        consumerMessageActions={[
          {
            id: "send-to-main",
            pluginId: null,
            icon: "ArrowTurnBackward",
            label: "Send to main thread",
            roles: ["assistant"],
            run,
          },
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    const rowsWithAction = screen.getAllByRole("button", {
      name: "Send to main thread",
    });
    expect(rowsWithAction).toHaveLength(1);
    expect(
      rowsWithAction[0]!
        .closest("[data-timeline-row-id]")
        ?.getAttribute("data-timeline-row-id"),
    ).toBe("assistant_row");

    fireEvent.click(rowsWithAction[0]!);
    expect(run).toHaveBeenCalledWith({
      id: "assistant_row",
      threadId: "thr_main",
      role: "assistant",
      text: "An assistant answer.",
      sourceSeqEnd: 9,
    });
  });

  it("renders roleless consumer actions on both roles and contains run errors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWithRouter(
      <ThreadTimelineRows
        threadId="thr_main"
        timelineRows={[
          conversationRow({
            id: "user_row",
            role: "user",
            text: "A user request.",
            threadId: "thr_main",
          }),
          conversationRow({
            id: "assistant_row",
            role: "assistant",
            text: "An assistant answer.",
            threadId: "thr_main",
          }),
        ]}
        consumerMessageActions={[
          {
            id: "explodes",
            pluginId: null,
            icon: null,
            label: "Explodes",
            run: () => {
              throw new Error("kaboom");
            },
          },
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    const buttons = screen.getAllByRole("button", { name: "Explodes" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('messageAction "explodes" failed: kaboom'),
    );
  });

  it("passes the highlighted text to plugin selection actions", async () => {
    const run = vi.fn();
    setPluginSlotRegistrations(
      "demo",
      messageActionRegistrationSet([
        { id: "summarize", title: "Summarize selection", run },
      ]),
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    renderWithRouter(
      <ThreadTimelineRows
        threadId="thr_main"
        timelineRows={[
          conversationRow({
            id: "selectable_row",
            role: "assistant",
            text: "Select part of this answer.",
            sourceSeqEnd: 11,
            threadId: "thr_main",
          }),
        ]}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );
    const textNode = screen.getByText("Select part of this answer.").firstChild;
    expect(textNode).not.toBeNull();
    mockWindowSelection({ node: textNode!, text: "part of this answer" });

    fireEvent(document, new Event("selectionchange"));
    const selectionAction = await waitFor(() => {
      const menuButton = screen
        .getAllByRole("button", { name: "Summarize selection" })
        .find((button) => !button.hasAttribute("aria-label"));
      if (menuButton === undefined) {
        throw new Error("Selection menu action not rendered yet");
      }
      return menuButton;
    });
    fireEvent.click(selectionAction);

    expect(run).toHaveBeenCalledTimes(1);
    const context = run.mock.calls[0]![0];
    expect(context.selectedText).toBe("part of this answer");
    expect(context.message).toEqual({
      id: "selectable_row",
      threadId: "thr_main",
      role: "assistant",
      text: "Select part of this answer.",
      sourceSeqEnd: 11,
    });
    expect(context.openPanel({ actionId: "panel" })).toBe(false);
  });

  it("forces a manually collapsed same-thread search ancestor open", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    const { container } = renderWithRouter(
      <SameThreadSearchNavigationHarness />,
      ["/thread"],
    );

    expect(
      container.querySelector('[data-timeline-row-id="nested_match"]'),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { expanded: true }));
    await waitFor(() =>
      expect(
        container.querySelector('[data-timeline-row-id="nested_match"]'),
      ).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open search match" }));
    const nestedRow = await waitFor(() => {
      const row = container.querySelector(
        '[data-timeline-row-id="nested_match"]',
      );
      if (row === null) {
        throw new Error("Nested search row was not rendered");
      }
      return row;
    });

    await waitFor(() =>
      expect(nestedRow.classList.contains("bb-search-flash")).toBe(true),
    );
  });
});

describe("ThreadTimelineRows shared message column width", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("expands overflow actions in place from the row list's one column measurement", () => {
    mockSelectionMenuMedia({ isCompactViewport: true, isPointerCoarse: true });
    const observations: { callback: ResizeObserverCallback; node: Element }[] =
      [];
    class ControlledResizeObserver {
      readonly #callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }
      observe(node: Element) {
        observations.push({ callback: this.#callback, node });
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);

    const { container } = renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            id: "earlier_agent_message",
            role: "assistant",
            text: "An earlier answer.",
          }),
          conversationRow({
            id: "latest_agent_message",
            role: "assistant",
            text: "The latest answer.",
          }),
        ]}
        canSpawnChild
        onForkMessage={vi.fn()}
        onMessageAddToChat={vi.fn()}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );

    act(() => {
      for (const { callback, node } of observations) {
        if (!node.hasAttribute("data-timeline-row-list")) continue;
        callback(
          [
            {
              target: node,
              contentRect: { width: 358, height: 600 },
            } as unknown as ResizeObserverEntry,
          ],
          undefined as unknown as ResizeObserver,
        );
      }
    });

    const earlierMessage = container.querySelector(
      '[data-timeline-row-id="earlier_agent_message"]',
    );
    const trigger = earlierMessage?.querySelector<HTMLButtonElement>(
      '[aria-label="Message actions"]',
    );
    if (!trigger) throw new Error("Missing overflow trigger");
    fireEvent.click(trigger);

    expect(document.body.querySelector('[data-side="top"]')).toBeNull();
    expect(
      earlierMessage?.querySelector('[aria-label="Copy message"]'),
    ).not.toBeNull();
    expect(
      earlierMessage?.querySelector('[aria-label="Fork into new thread"]'),
    ).not.toBeNull();
  });

  it("subtracts the assistant column's padding from the shared list width", () => {
    mockSelectionMenuMedia({ isCompactViewport: true, isPointerCoarse: true });
    const observations: { callback: ResizeObserverCallback; node: Element }[] =
      [];
    class ControlledResizeObserver {
      readonly #callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }
      observe(node: Element) {
        observations.push({ callback: this.#callback, node });
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);

    const { container } = renderWithRouter(
      <ThreadTimelineRows
        timelineRows={[
          conversationRow({
            id: "earlier_agent_message",
            role: "assistant",
            text: "An earlier answer.",
          }),
          conversationRow({
            id: "latest_agent_message",
            role: "assistant",
            text: "The latest answer.",
          }),
        ]}
        canSpawnChild
        onForkMessage={vi.fn()}
        onMessageAddToChat={vi.fn()}
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
      />,
    );
    const reportListWidth = (width: number) => {
      act(() => {
        for (const { callback, node } of observations) {
          if (!node.hasAttribute("data-timeline-row-list")) continue;
          callback(
            [
              {
                target: node,
                contentRect: { width, height: 600 },
              } as unknown as ResizeObserverEntry,
            ],
            undefined as unknown as ResizeObserver,
          );
        }
      });
    };
    const earlierMessage = container.querySelector(
      '[data-timeline-row-id="earlier_agent_message"]',
    );
    if (!earlierMessage) throw new Error("Missing earlier assistant row");
    const clickTrigger = () => {
      const trigger = earlierMessage.querySelector<HTMLButtonElement>(
        '[aria-label="Message actions"]',
      );
      if (!trigger) throw new Error("Missing overflow trigger");
      fireEvent.click(trigger);
    };

    reportListWidth(131);
    clickTrigger();
    expect(document.body.querySelector('[data-side="top"]')).not.toBeNull();
    expect(
      earlierMessage.querySelector('[aria-label="Copy message"]'),
    ).toBeNull();

    reportListWidth(132);
    clickTrigger();
    expect(document.body.querySelector('[data-side="top"]')).toBeNull();
    expect(
      earlierMessage.querySelector('[aria-label="Copy message"]'),
    ).not.toBeNull();
    expect(
      earlierMessage.querySelector('[aria-label="Fork into new thread"]'),
    ).not.toBeNull();
  });
});
