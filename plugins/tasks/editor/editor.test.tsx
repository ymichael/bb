// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { POINTER_COARSE_QUERY } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { createEditorExtensions } from "./extensions.js";
import { TasksEditor } from "./tasks-editor.js";

afterEach(cleanup);

function mockPointerCoarse(matches: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === POINTER_COARSE_QUERY ? matches : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  return () => {
    window.matchMedia = original;
  };
}

function getEditorSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector(".tiptap");
  if (!(surface instanceof HTMLElement)) {
    throw new Error("Expected TipTap surface");
  }
  return surface;
}

function roundTrip(markdown: string): string {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content: markdown,
  });
  try {
    return editor.storage.markdown.getMarkdown() as string;
  } finally {
    editor.destroy();
  }
}

describe("markdown round-trip", () => {
  const cases: Array<[string, string]> = [
    ["paragraphs", "First paragraph.\n\nSecond paragraph."],
    ["headings", "# Title\n\n## Section\n\n### Subsection"],
    ["marks", "Some **bold**, *italic*, ~~struck~~, and `inline code` text."],
    ["bullet list", "- one\n- two\n- three"],
    ["ordered list", "1. first\n2. second"],
    ["nested bullets", "- parent\n  - child"],
    ["task list", "- [ ] open task\n- [x] done task"],
    ["code block", "```ts\nconst answer = 42;\n```"],
    ["blockquote", "> quoted wisdom"],
    ["link", "Read the [bb guide](https://example.com/guide)."],
    ["image", "![diagram](https://example.com/diagram.png)"],
    ["mention", "Blocked on [TSK-42](bbtask://TSK-42) for review."],
    [
      "thread mention",
      "Discussed in [Fix login flow](bbthread://thr_a82u8wp8qq) yesterday.",
    ],
    [
      "mixed document",
      "## Plan\n\nShip the **editor** with `tiptap`.\n\n- [x] parse\n- [ ] serialize\n\n> Notes on [TSK-7](bbtask://TSK-7)\n\n```\nplain code\n```",
    ],
  ];
  it.each(cases)("preserves %s", (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("preserves table rows and cells", () => {
    const markdown =
      "| Item | Owner |\n| --- | --- |\n| Parser | Ada |\n| Styles | Lin |";

    expect(roundTrip(markdown).trimEnd()).toBe(markdown);
  });

  it.each([
    ["plain text", "left \\| right"],
    ["inline code", "`left\\|right`"],
  ])("preserves a pipe inside table-cell %s", (_name, cell) => {
    const markdown = `| Value |\n| --- |\n| ${cell} |`;

    expect(roundTrip(markdown).trimEnd()).toBe(markdown);
  });

  it("preserves a pipe inside a table-cell link destination", () => {
    const markdown =
      "| Value |\n| --- |\n| [destination](https://example.com/a\\|b) |";

    expect(roundTrip(markdown).trimEnd()).toBe(
      "| Value |\n| --- |\n| [destination](https://example.com/a%7Cb) |",
    );
  });

  it("preserves atom-only cells when another block is edited", async () => {
    const value = [
      "| Image | Task | Thread |",
      "| --- | --- | --- |",
      "| ![diagram](https://example.com/diagram.png) | [TSK-42](bbtask://TSK-42) | [Fix login](bbthread://thr_test) |",
      "",
      "Edit here",
    ].join("\n");
    const onChange = vi.fn();
    let editor: Editor | null = null;
    render(
      <TasksEditor
        value={value}
        onChange={onChange}
        onEditorReady={(ready) => (editor = ready)}
      />,
    );

    editor!.chain().focus("end").insertContent(" elsewhere").run();

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(`${value} elsewhere`),
    );
  });

  it("renders table headers and cells", () => {
    const screen = render(
      <TasksEditor
        value={"| Item | Owner |\n| --- | --- |\n| Parser | Ada |"}
        onChange={() => undefined}
        readOnly
      />,
    );

    expect(screen.getByRole("table").closest(".tableWrapper")).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getAllByRole("cell")).toHaveLength(2);
  });
});

describe("mention extension", () => {
  it("parses a bbtask link into a pill node and serializes it back", () => {
    const editor = new Editor({
      extensions: createEditorExtensions(),
      content: "Ping [TSK-42](bbtask://TSK-42) today.",
    });
    const findMentions = () => {
      const found: Array<Record<string, unknown>> = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "taskMention")
          found.push(node.attrs as Record<string, unknown>);
      });
      return found;
    };
    try {
      expect(findMentions()).toEqual([{ key: "TSK-42", label: "TSK-42" }]);
      const pill = editor.view.dom.querySelector(
        '[data-task-mention="TSK-42"]',
      );
      expect(pill?.classList.contains("bb-tasks-mention")).toBe(true);
      expect(pill?.textContent).toBe("TSK-42");
      editor.commands.setContent("[docs](https://example.com)");
      expect(findMentions()).toEqual([]);
      expect(editor.storage.markdown.getMarkdown()).toBe(
        "[docs](https://example.com)",
      );
    } finally {
      editor.destroy();
    }
  });

  it("suggests and inserts mentions from the mentionItems prop", async () => {
    let instance: Editor | null = null;
    const onChange = vi.fn();
    const screen = render(
      <TasksEditor
        value=""
        onChange={onChange}
        mentionItems={(query) =>
          Promise.resolve(
            [
              {
                type: "task" as const,
                id: "1",
                key: "TSK-42",
                title: "Round-trip review",
              },
              {
                type: "task" as const,
                id: "2",
                key: "TSK-7",
                title: "Detail panel",
              },
            ].filter((item) =>
              item.key.toLowerCase().includes(query.toLowerCase()),
            ),
          )
        }
        onEditorReady={(editor) => {
          instance = editor;
        }}
      />,
    );
    expect(instance).not.toBeNull();
    instance!.chain().focus().insertContent("@").run();
    const option = await screen.findByText("Round-trip review");
    fireEvent.click(option.closest("button")!);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("[TSK-42](bbtask://TSK-42) "),
    );
    expect(
      screen.container.querySelector('[data-task-mention="TSK-42"]'),
    ).toBeTruthy();
  });

  it("stays inert without a mentionItems prop", async () => {
    let instance: Editor | null = null;
    const screen = render(
      <TasksEditor
        value=""
        onChange={() => undefined}
        onEditorReady={(editor) => {
          instance = editor;
        }}
      />,
    );
    instance!.chain().focus().insertContent("@").run();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("offers a Threads section and inserts a thread pill", async () => {
    let instance: Editor | null = null;
    const onChange = vi.fn();
    const screen = render(
      <TasksEditor
        value=""
        onChange={onChange}
        mentionItems={() =>
          Promise.resolve([
            {
              type: "task" as const,
              id: "1",
              key: "TSK-42",
              title: "Round-trip review",
            },
            {
              type: "thread" as const,
              id: "thr_a82u8wp8qq",
              title: "Fix login flow",
            },
          ])
        }
        onEditorReady={(editor) => {
          instance = editor;
        }}
      />,
    );
    instance!.chain().focus().insertContent("@").run();
    await screen.findByText("Threads");
    expect(screen.getByText("Tasks")).toBeTruthy();
    fireEvent.click(screen.getByText("Fix login flow").closest("button")!);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        "[Fix login flow](bbthread://thr_a82u8wp8qq) ",
      ),
    );
    expect(
      screen.container.querySelector('[data-thread-mention="thr_a82u8wp8qq"]'),
    ).toBeTruthy();
  });
});

describe("thread mention extension", () => {
  it("parses a bbthread link into a pill and serializes it back", () => {
    const editor = new Editor({
      extensions: createEditorExtensions(),
      content: "See [Fix login flow](bbthread://thr_a82u8wp8qq).",
    });
    try {
      const pill = editor.view.dom.querySelector(
        '[data-thread-mention="thr_a82u8wp8qq"]',
      );
      expect(pill?.classList.contains("bb-tasks-thread-mention")).toBe(true);
      expect(pill?.textContent).toBe("Fix login flow");
      expect(pill?.querySelector("svg.bb-tasks-mention-icon")).toBeTruthy();
      expect(editor.storage.markdown.getMarkdown()).toBe(
        "See [Fix login flow](bbthread://thr_a82u8wp8qq).",
      );
    } finally {
      editor.destroy();
    }
  });

  it("opens the thread when a pill is clicked, including read-only", () => {
    const onOpenThread = vi.fn();
    const screen = render(
      <TasksEditor
        value="See [Fix login flow](bbthread://thr_a82u8wp8qq)."
        onChange={() => undefined}
        readOnly
        variant="comment"
        onOpenThread={onOpenThread}
      />,
    );
    const pill = screen.container.querySelector(
      '[data-thread-mention="thr_a82u8wp8qq"]',
    );
    fireEvent.click(pill!);
    expect(onOpenThread).toHaveBeenCalledWith("thr_a82u8wp8qq");
  });
});

describe("heading toggle", () => {
  function editorWith(markdown: string): Editor {
    return new Editor({
      extensions: createEditorExtensions(),
      content: markdown,
    });
  }

  function selectBlocks(
    editor: Editor,
    fromBlock: number,
    toBlock = fromBlock,
  ) {
    const positions: number[] = [];
    editor.state.doc.forEach((_node, offset) => {
      positions.push(offset + 2);
    });
    editor.commands.setTextSelection({
      from: positions[fromBlock - 1]!,
      to: positions[toBlock - 1]!,
    });
  }

  it("converts only the block under a within-block selection", () => {
    const editor = editorWith("First\n\nSecond\n\nThird");
    try {
      selectBlocks(editor, 2);
      editor.chain().toggleHeading({ level: 2 }).run();
      expect(editor.storage.markdown.getMarkdown()).toBe(
        "First\n\n## Second\n\nThird",
      );
    } finally {
      editor.destroy();
    }
  });

  it("converts only intersecting blocks for a multi-block selection", () => {
    const editor = editorWith("First\n\nSecond\n\nThird");
    try {
      selectBlocks(editor, 2, 3);
      editor.chain().toggleHeading({ level: 2 }).run();
      expect(editor.storage.markdown.getMarkdown()).toBe(
        "First\n\n## Second\n\n## Third",
      );
    } finally {
      editor.destroy();
    }
  });

  it("toggles a heading back to a paragraph", () => {
    const editor = editorWith("First\n\n## Second\n\nThird");
    try {
      selectBlocks(editor, 2);
      editor.chain().toggleHeading({ level: 2 }).run();
      expect(editor.storage.markdown.getMarkdown()).toBe(
        "First\n\nSecond\n\nThird",
      );
    } finally {
      editor.destroy();
    }
  });

  it("converts only the caret's block with no selection", () => {
    const editor = editorWith("First\n\nSecond\n\nThird");
    try {
      selectBlocks(editor, 3);
      editor.commands.setTextSelection(editor.state.selection.from);
      editor.chain().toggleHeading({ level: 2 }).run();
      expect(editor.storage.markdown.getMarkdown()).toBe(
        "First\n\nSecond\n\n## Third",
      );
    } finally {
      editor.destroy();
    }
  });
});

describe("TasksEditor component", () => {
  it("renders checklists and reports checkbox toggles as markdown", async () => {
    const onChange = vi.fn();
    const screen = render(
      <TasksEditor value={"- [ ] write tests"} onChange={onChange} />,
    );
    const checkbox = screen.container.querySelector<HTMLInputElement>(
      'ul[data-type="taskList"] input[type="checkbox"]',
    );
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox!);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("- [x] write tests"),
    );
  });

  it("renders read-only without a toolbar or editable surface", () => {
    const screen = render(
      <TasksEditor
        value={"**Done** deal"}
        onChange={() => undefined}
        readOnly
        variant="comment"
      />,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
    const surface = screen.container.querySelector(".tiptap");
    expect(surface?.getAttribute("contenteditable")).toBe("false");
    expect(surface?.querySelector("strong")?.textContent).toBe("Done");
    expect(
      screen.container.querySelector('[data-variant="comment"]'),
    ).toBeTruthy();
  });

  it("renders pasted Markdown as rich content", async () => {
    const markdown = "| Task |\n| --- |\n| [TSK-42](bbtask://TSK-42) |";
    const onChange = vi.fn();
    const screen = render(<TasksEditor value="" onChange={onChange} />);

    fireEvent.paste(getEditorSurface(screen.container), {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? markdown : ""),
      },
    });

    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(
      screen.container.querySelector('[data-task-mention="TSK-42"]'),
    ).toBeTruthy();
    expect(onChange.mock.lastCall?.[0]?.trimEnd()).toBe(markdown);
  });

  it("routes pasted and dropped files to onAttachFiles instead of inline upload", () => {
    const onAttachFiles = vi.fn();
    const onUploadImage = vi.fn();
    let editor: Editor | null = null;
    render(
      <TasksEditor
        value=""
        onChange={() => undefined}
        onAttachFiles={onAttachFiles}
        onUploadImage={onUploadImage}
        onEditorReady={(ready) => (editor = ready)}
      />,
    );
    const { handlePaste, handleDrop } = editor!.options.editorProps;
    const file = new File(["png"], "shot.png", { type: "image/png" });

    const pasteEvent = {
      clipboardData: { files: [file] },
    } as unknown as ClipboardEvent;
    expect(
      handlePaste!.call(editor!.view, editor!.view, pasteEvent, null as never),
    ).toBe(true);
    expect(onAttachFiles).toHaveBeenCalledWith([file]);
    expect(onUploadImage).not.toHaveBeenCalled();

    const textPaste = {
      clipboardData: { files: [] },
    } as unknown as ClipboardEvent;
    expect(
      handlePaste!.call(editor!.view, editor!.view, textPaste, null as never),
    ).toBe(false);

    const preventDefault = vi.fn();
    const dropEvent = {
      dataTransfer: { files: [file] },
      preventDefault,
    } as unknown as DragEvent;
    expect(
      handleDrop!.call(
        editor!.view,
        editor!.view,
        dropEvent,
        null as never,
        false,
      ),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(onAttachFiles).toHaveBeenCalledTimes(2);
  });

  it("replaces the document when the value prop changes externally", async () => {
    const onChange = vi.fn();
    const screen = render(
      <TasksEditor value={"original"} onChange={onChange} />,
    );
    screen.rerender(<TasksEditor value={"replaced"} onChange={onChange} />);
    await screen.findByText("replaced");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stays editable when the description is only a single image", async () => {
    let editor: Editor | null = null;
    render(
      <TasksEditor
        value={"![shot](https://example.com/a.png)"}
        onChange={() => undefined}
        onEditorReady={(ready) => (editor = ready)}
      />,
    );
    editor!.chain().focus("end").insertContent("caption").run();
    await waitFor(() => {
      const markdown = editor!.storage.markdown.getMarkdown() as string;
      expect(markdown).toContain("![shot](https://example.com/a.png)");
      expect(markdown).toContain("caption");
    });
  });
});

describe("TasksEditor submit-on-Enter", () => {
  function callHandleKeyDown(editor: Editor, event: KeyboardEvent): boolean {
    const { handleKeyDown } = editor.options.editorProps;
    return Boolean(handleKeyDown?.call(editor.view, editor.view, event));
  }

  it("submits on bare Enter when onSubmit is provided", () => {
    const onSubmit = vi.fn();
    let editor: Editor | null = null;
    const screen = render(
      <TasksEditor
        value="Draft"
        onChange={() => undefined}
        onSubmit={onSubmit}
        variant="comment"
        onEditorReady={(ready) => {
          editor = ready;
        }}
      />,
    );
    editor!.commands.focus("end");
    const surface = getEditorSurface(screen.container);
    expect(surface.getAttribute("enterkeyhint")).toBe("send");

    expect(
      callHandleKeyDown(
        editor!,
        new KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
      ),
    ).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("inserts a newline on Shift+Enter instead of submitting", () => {
    const onSubmit = vi.fn();
    let editor: Editor | null = null;
    render(
      <TasksEditor
        value="Line"
        onChange={() => undefined}
        onSubmit={onSubmit}
        variant="comment"
        onEditorReady={(ready) => {
          editor = ready;
        }}
      />,
    );
    editor!.commands.focus("end");
    expect(
      callHandleKeyDown(
        editor!,
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          cancelable: true,
        }),
      ),
    ).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit during IME composition", () => {
    const onSubmit = vi.fn();
    let editor: Editor | null = null;
    render(
      <TasksEditor
        value="候補"
        onChange={() => undefined}
        onSubmit={onSubmit}
        variant="comment"
        onEditorReady={(ready) => {
          editor = ready;
        }}
      />,
    );
    editor!.commands.focus("end");
    const composing = new KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
      isComposing: true,
    });
    expect(callHandleKeyDown(editor!, composing)).toBe(false);

    const keyCode229 = new KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
    });
    Object.defineProperty(keyCode229, "keyCode", {
      get: () => 229,
    });
    expect(callHandleKeyDown(editor!, keyCode229)).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits on Cmd/Ctrl+Enter even when pointer is coarse", () => {
    const restore = mockPointerCoarse(true);
    try {
      const onSubmit = vi.fn();
      let editor: Editor | null = null;
      const screen = render(
        <TasksEditor
          value="Touch draft"
          onChange={() => undefined}
          onSubmit={onSubmit}
          variant="comment"
          onEditorReady={(ready) => {
            editor = ready;
          }}
        />,
      );
      editor!.commands.focus("end");
      const surface = getEditorSurface(screen.container);
      expect(surface.getAttribute("enterkeyhint")).toBe("enter");

      expect(
        callHandleKeyDown(
          editor!,
          new KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
        ),
      ).toBe(false);
      expect(onSubmit).not.toHaveBeenCalled();

      expect(
        callHandleKeyDown(
          editor!,
          new KeyboardEvent("keydown", {
            key: "Enter",
            metaKey: true,
            cancelable: true,
          }),
        ),
      ).toBe(true);
      expect(onSubmit).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("does not claim Enter when onSubmit is omitted", () => {
    let editor: Editor | null = null;
    render(
      <TasksEditor
        value="Description"
        onChange={() => undefined}
        variant="comment"
        onEditorReady={(ready) => {
          editor = ready;
        }}
      />,
    );
    editor!.commands.focus("end");
    expect(
      callHandleKeyDown(
        editor!,
        new KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
      ),
    ).toBe(false);
  });

  it("lets the mention popover own Enter while open", async () => {
    const onSubmit = vi.fn();
    let editor: Editor | null = null;
    const screen = render(
      <TasksEditor
        value=""
        onChange={() => undefined}
        onSubmit={onSubmit}
        variant="comment"
        mentionItems={() =>
          Promise.resolve([
            {
              type: "task" as const,
              id: "1",
              key: "TSK-1",
              title: "Pick me",
            },
          ])
        }
        onEditorReady={(ready) => {
          editor = ready;
        }}
      />,
    );
    editor!.chain().focus().insertContent("@").run();
    await screen.findByText("Pick me");
    fireEvent.keyDown(getEditorSurface(screen.container), { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.container.querySelector('[data-task-mention="TSK-1"]'),
      ).toBeTruthy(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
