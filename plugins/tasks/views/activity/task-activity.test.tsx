// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComment, createStore } from "../../api/index.js";
import type { Attachment, DisplayComment } from "../../shared/contract.js";
import {
  AgentNotificationControl,
  AttachmentTracks,
  agentNotificationTarget,
  CommentComposer,
} from "./task-activity.js";

const { rpcCall } = vi.hoisted(() => ({ rpcCall: vi.fn() }));

vi.mock("../../shell/data.js", () => ({
  useMentionItems: () => [],
  useTasksQuery: () => ({ data: [] }),
  useTasksRpc: () => ({ call: rpcCall }),
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({ toThread: vi.fn() }),
}));

vi.mock("../../editor/tasks-editor.js", () => ({
  TasksEditor: (props: {
    value: string;
    onChange: (value: string) => void;
    onSubmit?: () => void;
  }) => (
    <textarea
      aria-label="Comment body"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !props.onSubmit) return;
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.shiftKey || event.altKey) return;
        event.preventDefault();
        props.onSubmit();
      }}
    />
  ),
}));

afterEach(() => {
  cleanup();
  rpcCall.mockReset();
});

function comment(
  kind: DisplayComment["kind"],
  threadId: string | null = null,
  threadTitle: string | null = null,
): DisplayComment {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZZ${kind === "agent" ? "A" : "U"}`,
    taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
    kind,
    authorName: kind === "agent" ? "Agent" : "You",
    presetName: null,
    threadId,
    threadTitle,
    body: "Reply",
    notifiedCount: 0,
    createdAt: "2026-07-15T00:00:00.000Z",
  };
}

describe("AttachmentTracks", () => {
  const attachment = (
    id: string,
    fileName: string,
    isImage: boolean,
  ): Attachment => ({
    id,
    taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
    commentId: "01HZZZZZZZZZZZZZZZZZZZZZC1",
    fileName,
    mime: isImage ? "image/png" : "text/plain",
    sizeBytes: 1024,
    isImage,
    createdAt: "2026-07-15T00:00:00.000Z",
  });

  it("renders file cards before images regardless of input order", () => {
    const screen = render(
      <AttachmentTracks
        attachments={[
          attachment("01HZZZZZZZZZZZZZZZZZZZZ1I1", "shot-a.png", true),
          attachment("01HZZZZZZZZZZZZZZZZZZZZ1F1", "notes.md", false),
          attachment("01HZZZZZZZZZZZZZZZZZZZZ1I2", "shot-b.png", true),
        ]}
        onOpenImage={() => {}}
      />,
    );
    const file = screen.getByText("notes.md");
    const image = screen.getByAltText("shot-a.png");
    expect(
      file.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps each caption inside its own image figure", () => {
    const screen = render(
      <AttachmentTracks
        attachments={[
          attachment("01HZZZZZZZZZZZZZZZZZZZZ1I1", "shot.png", true),
        ]}
        onOpenImage={() => {}}
      />,
    );
    const figure = screen.getByRole("figure");
    expect(figure.contains(screen.getByAltText("shot.png"))).toBe(true);
    expect(figure.contains(screen.getByText("shot.png"))).toBe(true);
  });
});

describe("agent notification target", () => {
  it("uses the last agent reply rather than the last activity entry", () => {
    expect(
      agentNotificationTarget([
        comment("agent", "thr_first", "First agent"),
        comment("agent", "thr_latest", "Latest agent"),
        comment("user"),
      ]),
    ).toEqual({ kind: "ready", title: "Latest agent" });
  });

  it("distinguishes no prior reply from an unavailable latest responder", () => {
    expect(agentNotificationTarget([comment("user")])).toEqual({
      kind: "none",
    });
    expect(
      agentNotificationTarget([comment("agent", "thr_private", null)]),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("AgentNotificationControl", () => {
  it("exposes an enabled, on-by-default switch named for the latest responder", () => {
    const onCheckedChange = vi.fn();
    render(
      <AgentNotificationControl
        target={{ kind: "ready", title: "Fix the login bug" }}
        checked
        onCheckedChange={onCheckedChange}
      />,
    );

    const toggle = screen.getByRole("switch", {
      name: "Notify Fix the login bug",
    });
    expect(toggle.getAttribute("aria-disabled")).toBe("false");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("reads as off and toggles on when the opt-in is unchecked", () => {
    const onCheckedChange = vi.fn();
    render(
      <AgentNotificationControl
        target={{ kind: "ready", title: "Fix the login bug" }}
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );

    const toggle = screen.getByRole("switch", {
      name: "Notify Fix the login bug",
    });
    expect(toggle.getAttribute("aria-disabled")).toBe("false");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("names the full destination even for a long thread title", () => {
    const title =
      "Make all of the filters in the task list remembered across reloads";
    render(
      <AgentNotificationControl
        target={{ kind: "ready", title }}
        checked
        onCheckedChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("switch", { name: `Notify ${title}` }),
    ).toBeTruthy();
  });

  it("never reads as on and cannot be toggled while unavailable", () => {
    const onCheckedChange = vi.fn();
    render(
      <AgentNotificationControl
        target={{ kind: "unavailable" }}
        checked
        onCheckedChange={onCheckedChange}
      />,
    );

    const toggle = screen.getByRole("switch", {
      name: "Latest responding agent can’t be notified",
    });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("disables and explains the control when no agent has replied", () => {
    const onCheckedChange = vi.fn();
    render(
      <AgentNotificationControl
        target={{ kind: "none" }}
        checked
        onCheckedChange={onCheckedChange}
      />,
    );

    const toggle = screen.getByRole("switch", {
      name: "No prior agent reply to notify",
    });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(toggle);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

async function renderComposerWithTask(options?: {
  body?: string;
  holdSend?: boolean;
}) {
  let releaseSend!: () => void;
  const sendGate = options?.holdSend
    ? new Promise<void>((resolve) => {
        releaseSend = resolve;
      })
    : Promise.resolve();
  if (!options?.holdSend) {
    releaseSend = () => {};
  }
  const { bb, harness } = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, status: "active" }),
        send: async () => sendGate,
      },
    },
  });
  const store = createStore(bb);
  const project = store.tasks.createProject({
    name: "Composer",
    prefix: "CMP",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Submit once",
  });
  store.tasks.createComment({
    taskId: task.id,
    kind: "agent",
    authorName: "Worker",
    threadId: "thr_worker",
    body: "Ready for input",
  });
  rpcCall.mockImplementation(async (method, input) => {
    if (method !== "createComment") {
      throw new Error(`Unexpected RPC method: ${String(method)}`);
    }
    const request = input as {
      taskId: string;
      body: string;
      notify: boolean;
    };
    return {
      comment: await createComment(bb, store, {
        taskId: request.taskId,
        kind: "user",
        authorName: "You",
        presetName: null,
        threadId: null,
        body: request.body,
        notify: request.notify,
      }),
    };
  });

  render(
    <CommentComposer
      taskId={task.id}
      notificationTarget={{ kind: "ready", title: "Worker" }}
    />,
  );
  if (options?.body !== undefined) {
    fireEvent.change(screen.getByRole("textbox", { name: "Comment body" }), {
      target: { value: options.body },
    });
  }
  return { store, task, harness, releaseSend };
}

describe("CommentComposer", () => {
  it("single-flights rapid submit activation into one comment and send", async () => {
    const { store, task, harness, releaseSend } = await renderComposerWithTask({
      body: "Only once",
      holdSend: true,
    });
    try {
      const submit = screen.getByRole("button", { name: "Comment" });
      fireEvent.click(submit);
      fireEvent.click(submit);

      await waitFor(() => expect(rpcCall).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(harness.sdk.callsTo("threads.send")).toHaveLength(1),
      );
      expect(
        store.tasks
          .listComments(task.id)
          .filter((entry) => entry.body === "Only once"),
      ).toHaveLength(1);

      releaseSend();
      await waitFor(() =>
        expect(
          store.tasks
            .listComments(task.id)
            .find((entry) => entry.body === "Only once")?.notifiedCount,
        ).toBe(1),
      );
    } finally {
      releaseSend();
      await harness.dispose();
    }
  });

  it("submits on Enter and single-flights rapid Enter presses", async () => {
    const { store, task, harness, releaseSend } = await renderComposerWithTask({
      body: "From keyboard",
      holdSend: true,
    });
    try {
      const body = screen.getByRole("textbox", { name: "Comment body" });
      fireEvent.keyDown(body, { key: "Enter" });
      fireEvent.keyDown(body, { key: "Enter" });

      await waitFor(() => expect(rpcCall).toHaveBeenCalledTimes(1));
      expect(
        store.tasks
          .listComments(task.id)
          .filter((entry) => entry.body === "From keyboard"),
      ).toHaveLength(1);
      releaseSend();
    } finally {
      releaseSend();
      await harness.dispose();
    }
  });

  it("does not submit on Shift+Enter", async () => {
    const { harness, releaseSend } = await renderComposerWithTask({
      body: "Keep drafting",
    });
    try {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment body" }), {
        key: "Enter",
        shiftKey: true,
      });
      expect(rpcCall).not.toHaveBeenCalled();
    } finally {
      releaseSend();
      await harness.dispose();
    }
  });

  it("does not submit during IME composition", async () => {
    const { harness, releaseSend } = await renderComposerWithTask({
      body: "候補",
    });
    try {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment body" }), {
        key: "Enter",
        isComposing: true,
      });
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment body" }), {
        key: "Enter",
        keyCode: 229,
      });
      expect(rpcCall).not.toHaveBeenCalled();
    } finally {
      releaseSend();
      await harness.dispose();
    }
  });

  it("does not submit when the comment is empty", async () => {
    const { harness, releaseSend } = await renderComposerWithTask({ body: "" });
    try {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment body" }), {
        key: "Enter",
      });
      expect(rpcCall).not.toHaveBeenCalled();
      expect(
        (screen.getByRole("button", { name: "Comment" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    } finally {
      releaseSend();
      await harness.dispose();
    }
  });

  it("submits on Cmd+Enter", async () => {
    const { store, task, harness, releaseSend } = await renderComposerWithTask({
      body: "Mod submit",
    });
    try {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment body" }), {
        key: "Enter",
        metaKey: true,
      });
      await waitFor(() => expect(rpcCall).toHaveBeenCalledTimes(1));
      expect(
        store.tasks
          .listComments(task.id)
          .some((entry) => entry.body === "Mod submit"),
      ).toBe(true);
    } finally {
      releaseSend();
      await harness.dispose();
    }
  });
});
