// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  PluginComposerApi,
  PluginComposerScope,
  PluginMessageDirectiveProps,
  PluginNavPanelProps,
  ExperimentalPluginFixedTabReference,
} from "../../app-contract.js";
import {
  installTestPluginRuntime,
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "../app.js";
import { defineRpcContract } from "../../rpc-contract.js";

installTestPluginRuntime();
const {
  definePluginApp,
  experimental_FileLink: FileLink,
  UrlLink: UrlLink,
  experimental_ProviderModelPicker: ProviderModelPicker,
  experimental_PermissionModePicker: PermissionModePicker,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  ThreadChat,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} = await import("../../app.js");

type TestTaskTarget = {
  kind: "task";
  taskId: string;
};

const taskDetailsTab = {
  panelId: "tasks",
  id: "details",
  experimental_target: {
    validate(value): value is TestTaskTarget {
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        value.kind === "task" &&
        typeof value.taskId === "string"
      );
    },
  },
} satisfies ExperimentalPluginFixedTabReference<TestTaskTarget>;

function FixedTabProbe() {
  const panel = experimental_useAppPanel();
  const targetState = experimental_useFixedTabTarget(taskDetailsTab);
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          panel.openFixedTab({
            surface: { kind: "current" },
            tab: taskDetailsTab,
            target: { kind: "task", taskId: "TASK-42" },
          })
        }
      >
        Open details
      </button>
      <button
        type="button"
        onClick={() =>
          panel.openFixedTab({
            surface: { kind: "current" },
            tab: taskDetailsTab,
          })
        }
      >
        Select details
      </button>
      {targetState === null ? null : (
        <button type="button" onClick={targetState.clear}>
          Clear {targetState.target.taskId}
        </button>
      )}
    </div>
  );
}

const typedRpcContract = defineRpcContract({
  getItem: {
    input: z.object({ id: z.string() }),
    output: z.object({ title: z.string() }),
  },
});

function TypedRpcPanel() {
  const rpc = useRpc<typeof typedRpcContract>();
  const [title, setTitle] = useState("Loading typed RPC…");
  useEffect(() => {
    void rpc.call("getItem", { id: "item-1" }).then((result) => {
      const exactTitle: string = result.title;
      setTitle(exactTitle);
    });
  }, [rpc]);
  return <div>{title}</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("experimental_ProviderModelPicker test runtime", () => {
  it("applies all execution edits as one controlled value", () => {
    const onChange = vi.fn();
    const picker = render(
      <ProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
          serviceTier: "default",
        }}
        onChange={onChange}
        routing={{ kind: "host", hostId: "host-test" }}
        align="end"
      />,
    );

    fireEvent.change(picker.getByRole("textbox", { name: "Provider ID" }), {
      target: { value: "claude-code" },
    });
    fireEvent.change(picker.getByRole("textbox", { name: "Model" }), {
      target: { value: "claude-opus-4-7" },
    });
    fireEvent.change(picker.getByRole("textbox", { name: "Reasoning level" }), {
      target: { value: "xhigh" },
    });
    fireEvent.change(picker.getByRole("combobox", { name: "Service tier" }), {
      target: { value: "fast" },
    });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(
      picker.getByRole("button", { name: "Apply execution selection" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      providerId: "claude-code",
      model: "claude-opus-4-7",
      reasoningLevel: "xhigh",
      serviceTier: "fast",
    });
    expect(
      picker.getByTestId("bb-provider-model-picker").dataset.routingKind,
    ).toBe("host");
    expect(
      picker.getByTestId("bb-provider-model-picker").dataset.routingId,
    ).toBe("host-test");
    expect(picker.getByTestId("bb-provider-model-picker").dataset.align).toBe(
      "end",
    );
  });
});

describe("experimental_PermissionModePicker test runtime", () => {
  it("exposes the controlled mode, provider, and routing", () => {
    const onChange = vi.fn();
    const picker = render(
      <PermissionModePicker
        providerId="codex"
        value="auto"
        onChange={onChange}
        routing={{ kind: "environment", environmentId: "env-test" }}
        align="start"
      />,
    );

    fireEvent.change(
      picker.getByRole("combobox", { name: "Permission mode" }),
      { target: { value: "full" } },
    );

    expect(onChange).toHaveBeenCalledWith("full");
    expect(
      picker.getByTestId("bb-permission-mode-picker").dataset.providerId,
    ).toBe("codex");
    expect(
      picker.getByTestId("bb-permission-mode-picker").dataset.routingKind,
    ).toBe("environment");
    expect(
      picker.getByTestId("bb-permission-mode-picker").dataset.routingId,
    ).toBe("env-test");
    expect(picker.getByTestId("bb-permission-mode-picker").dataset.align).toBe(
      "start",
    );
  });
});

function Panel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc();
  const [items, setItems] = useState<string[] | null>(null);
  const refresh = () => {
    void rpc
      .call("listItems", { subPath })
      .then((result) => setItems(result as string[]))
      .catch((error: unknown) =>
        setItems([
          `error: ${error instanceof Error ? error.message : String(error)}`,
        ]),
      );
  };
  useEffect(refresh, []);
  useRealtime("items-changed", refresh);
  if (items === null) return <div>Loading…</div>;
  return (
    <div>
      {items.map((item) => (
        <div key={item}>{item}</div>
      ))}
    </div>
  );
}

function RealtimeConnectionProbe() {
  const state = useRealtimeConnectionState();
  return <div>Realtime: {state}</div>;
}

function UrlNavigationProbe() {
  const navigate = useBbNavigate();
  return (
    <div>
      <UrlLink href="https://example.com/from-link">Open link</UrlLink>
      <UrlLink
        href="https://example.com/native"
        target="preview-pane"
        rel="nofollow"
      >
        Open in explicit target
      </UrlLink>
      <button
        type="button"
        onClick={() => navigate.openUrl("https://example.com/imperative")}
      >
        Open imperatively
      </button>
    </div>
  );
}

const fileIntent = {
  target: {
    kind: "workspace" as const,
    environmentId: "env_42",
    path: "src/example.ts",
  },
  location: { kind: "line" as const, line: 12, column: 4 },
};

function FileNavigationProbe() {
  const navigate = useBbNavigate();
  return (
    <div>
      <FileLink {...fileIntent}>Open file</FileLink>
      <button
        type="button"
        onClick={() => navigate.experimental_openFileExternally(fileIntent)}
      >
        Open file externally
      </button>
    </div>
  );
}

function MalformedFileLinkProbe() {
  return (
    <FileLink
      target={{
        kind: "workspace",
        environmentId: "env_42",
        path: "../secret",
      }}
    >
      Open malformed file
    </FileLink>
  );
}

function MalformedUnicodeFileLinkProbe() {
  return (
    <FileLink
      target={{
        kind: "workspace",
        environmentId: "env_42",
        path: String.fromCharCode(0xd800),
      }}
    >
      Open malformed Unicode file
    </FileLink>
  );
}

function SchemeLikeFileLinkProbe() {
  return (
    <FileLink
      target={{
        kind: "workspace",
        environmentId: "env_42",
        path: "vscode:foo",
      }}
    >
      Open scheme-like file
    </FileLink>
  );
}

let capturedComposerVisualSetters: Pick<
  PluginComposerApi,
  "setTextEffect" | "setInputLock"
> | null = null;

function InlineVis({
  attributes,
  source,
  message,
}: PluginMessageDirectiveProps) {
  return (
    <div>
      <span data-testid="file">{attributes.file ?? ""}</span>
      <span data-testid="source">{source}</span>
      <span data-testid="thread">{message.threadId}</span>
    </div>
  );
}

function ComposerProbe() {
  const composer = useComposer();
  const view = useComposerView();
  capturedComposerVisualSetters = {
    setTextEffect: composer.setTextEffect,
    setInputLock: composer.setInputLock,
  };
  return (
    <div>
      <span data-testid="composer-scope">{composer.scope.kind}</span>
      <span data-testid="composer-scope-details">
        {JSON.stringify(composer.scope)}
      </span>
      <span data-testid="composer-text">{composer.text}</span>
      <span data-testid="composer-view-text">{view.draft.text}</span>
      <span data-testid="composer-attachment-count">
        {view.draft.attachmentCount}
      </span>
      <span data-testid="composer-is-empty">{String(view.draft.isEmpty)}</span>
      <button type="button" onClick={() => composer.setText("replacement")}>
        replace
      </button>
      <button
        type="button"
        onClick={() => composer.updateText((current) => `${current}!`)}
      >
        update
      </button>
      <button type="button" onClick={() => composer.clear()}>
        clear
      </button>
      <button type="button" onClick={() => composer.addQuote("picked text")}>
        quote
      </button>
      <button
        type="button"
        onClick={() =>
          composer.insertMention({
            provider: "notes",
            id: "ideas",
            label: "Ideas",
          })
        }
      >
        mention
      </button>
      <button type="button" onClick={() => composer.focus()}>
        focus
      </button>
    </div>
  );
}

const messageActionRuns: unknown[] = [];

function ThreadChatPage({ subPath }: PluginNavPanelProps) {
  return (
    <ThreadChat
      threadId={subPath || "thr_default"}
      variant="compact"
      layout="document"
      focusRequest={2}
      className="demo-chat"
      leadingContent={<div>Replying to something earlier</div>}
      messageActions={[
        {
          id: "send-to-main",
          title: "Send to main thread",
          icon: "ArrowTurnBackward",
          roles: ["assistant"],
          run: (message) => {
            messageActionRuns.push(message);
          },
        },
      ]}
    />
  );
}

const app = await loadPluginApp(
  definePluginApp((builder) => {
    builder.slots.navPanel({
      id: "panel",
      title: "Panel",
      icon: "FileText",
      path: "panel",
      component: Panel,
    });
    builder.slots.navPanel({
      id: "chat",
      title: "Chat",
      icon: "MessageSquarePlus",
      path: "chat",
      component: ThreadChatPage,
    });
    builder.slots.messageAction({
      id: "summarize",
      title: "Summarize",
      icon: "Zap",
      run(context) {
        messageActionRuns.push(context);
      },
    });
    builder.slots.messageDirective({
      id: "inline-vis",
      component: InlineVis,
    });
    builder.slots.homepageSection({
      id: "realtime-connection",
      title: "Realtime connection",
      component: RealtimeConnectionProbe,
    });
    builder.composer.customize({
      id: "improve-prompt",
      scopes: ["thread", "new-thread"],
      actions: [{ id: "improve", component: ComposerProbe }],
    });
  }),
);

describe("loadPluginApp", () => {
  it("captures and validates app overlay registrations", async () => {
    function Overlay() {
      return <div>overlay</div>;
    }
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.slots.experimental_appOverlay({
          id: "office",
          component: Overlay,
        });
      }),
    );

    expect(captured.appOverlays).toEqual([
      { id: "office", component: Overlay },
    ]);
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.experimental_appOverlay({
            id: "office",
            component: Overlay,
          });
          builder.slots.experimental_appOverlay({
            id: "office",
            component: Overlay,
          });
        }),
      ),
    ).rejects.toThrow('slots.experimental_appOverlay: duplicate id "office"');
  });

  it("captures and validates sidebar navigation registrations", async () => {
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.slots.experimental_sidebarNavigation({
          id: "compact",
          title: "Compact navigation",
          description: "Groups the sidebar destinations.",
          component: () => null,
        });
      }),
    );

    expect(captured.experimentalSidebarNavigations).toEqual([
      {
        id: "compact",
        title: "Compact navigation",
        description: "Groups the sidebar destinations.",
        component: expect.any(Function),
      },
    ]);
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.experimental_sidebarNavigation({
            id: "compact",
            title: "One",
            component: () => null,
          });
          builder.slots.experimental_sidebarNavigation({
            id: "compact",
            title: "Two",
            component: () => null,
          });
        }),
      ),
    ).rejects.toThrow(
      'slots.experimental_sidebarNavigation: duplicate id "compact"',
    );
  });

  it("captures and validates New thread panel action registrations", async () => {
    const run = () => {};
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.slots.experimental_newThreadPanelAction({
          id: "template",
          title: "Apply template",
          icon: "Wand",
          component: () => null,
          layout: "flush",
          run,
        });
      }),
    );

    expect(captured.newThreadPanelActions).toEqual([
      {
        id: "template",
        title: "Apply template",
        icon: "Wand",
        component: expect.any(Function),
        layout: "flush",
        run,
      },
    ]);
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.experimental_newThreadPanelAction({
            id: "template",
            title: "One",
            component: () => null,
          });
          builder.slots.experimental_newThreadPanelAction({
            id: "template",
            title: "Two",
            component: () => null,
          });
        }),
      ),
    ).rejects.toThrow(
      'slots.experimental_newThreadPanelAction: duplicate id "template"',
    );
  });

  it("captures, mounts, and exactly-once disposes content scripts in lifecycle order", async () => {
    const events: string[] = [];
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        for (const id of ["first", "second"] as const) {
          builder.contentScripts.register({
            id,
            async mount({ pluginId, generation, signal }) {
              await Promise.resolve();
              events.push(`${id}:mount:${pluginId}:${generation}`);
              signal.addEventListener(
                "abort",
                () => events.push(`${id}:abort`),
                { once: true },
              );
              return () => {
                events.push(`${id}:dispose`);
              };
            },
          });
        }
      }),
    );

    expect(captured.contentScripts.map(({ id }) => id)).toEqual([
      "first",
      "second",
    ]);
    const mounted = await mountPluginContentScripts(captured, {
      pluginId: "demo",
      generation: 7,
    });
    expect(mounted.inspection.mountedIds).toEqual(["first", "second"]);
    expect(events).toEqual(["first:mount:demo:7", "second:mount:demo:7"]);

    await mounted.lifecycle.dispose();
    await mounted.lifecycle.dispose();
    expect(mounted.inspection.disposed).toBe(true);
    expect(mounted.inspection.signal.aborted).toBe(true);
    expect(events).toEqual([
      "first:mount:demo:7",
      "second:mount:demo:7",
      "first:abort",
      "second:abort",
      "second:dispose",
      "first:dispose",
    ]);
  });

  it("models current-host thread-row statuses, validation, and lifecycle cleanup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let retainedSetter:
      | ((
          threadId: string,
          status: {
            icon: string;
            label: string;
            tone?: "running";
          } | null,
        ) => void)
      | undefined;
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.contentScripts.register({
          id: "thread-status",
          mount({ experimental_setThreadRowStatus }) {
            retainedSetter = experimental_setThreadRowStatus;
            retainedSetter?.("  thr_source  ", {
              icon: " AiContentGenerator01 ",
              label: " Improving draft ",
              tone: "running",
            });
            (
              experimental_setThreadRowStatus as
                | ((threadId: unknown, status: unknown) => void)
                | undefined
            )?.(42, {
              icon: "AiContentGenerator01",
              label: "Invalid thread",
            });
          },
        });
      }),
    );

    const mounted = await mountPluginContentScripts(captured, {
      pluginId: "prompt-shaper",
    });
    expect(mounted.inspection.getThreadRowStatus("thr_source")).toEqual({
      icon: "AiContentGenerator01",
      label: "Improving draft",
      tone: "running",
    });
    expect(mounted.inspection.threadRowStatusCalls).toEqual([
      {
        threadId: "thr_source",
        status: {
          icon: "AiContentGenerator01",
          label: "Improving draft",
          tone: "running",
        },
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"threadId" must be a non-empty string'),
    );

    const unsafeSetter = retainedSetter as
      | ((threadId: unknown, status: unknown) => void)
      | undefined;
    unsafeSetter?.("thr_source", {
      icon: "   ",
      label: "Missing icon",
    });
    unsafeSetter?.("thr_source", {
      icon: "AiContentGenerator01",
      label: "Invalid tone",
      tone: "warning",
    });
    expect(mounted.inspection.getThreadRowStatus("thr_source")).toEqual({
      icon: "AiContentGenerator01",
      label: "Improving draft",
      tone: "running",
    });
    expect(mounted.inspection.threadRowStatusCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'contentScript.experimental_setThreadRowStatus: "icon" must be a non-blank string',
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'contentScript.experimental_setThreadRowStatus: "tone" must be "default", "running", "success", or "error" when set',
      ),
    );

    await mounted.lifecycle.dispose();
    expect(mounted.inspection.getThreadRowStatus("thr_source")).toBeNull();
    retainedSetter?.("thr_source", {
      icon: "AiContentGenerator01",
      label: "Late stale status",
      tone: "running",
    });
    expect(mounted.inspection.getThreadRowStatus("thr_source")).toBeNull();
    expect(mounted.inspection.threadRowStatusCalls).toHaveLength(1);
    warn.mockRestore();
  });

  it("can omit the experimental thread-row status API for compatibility tests", async () => {
    let setterWasAvailable = true;
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.contentScripts.register({
          id: "compatibility",
          mount({ experimental_setThreadRowStatus }) {
            setterWasAvailable = experimental_setThreadRowStatus !== undefined;
          },
        });
      }),
    );

    const mounted = await mountPluginContentScripts(captured, {
      pluginId: "prompt-shaper",
      omitExperimentalThreadRowStatus: true,
    });
    expect(setterWasAvailable).toBe(false);
    expect(mounted.inspection.threadRowStatusCalls).toEqual([]);
    await mounted.lifecycle.dispose();
  });

  it("rolls back earlier content scripts when a later mount rejects", async () => {
    const events: string[] = [];
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.contentScripts.register({
          id: "first",
          mount({ signal }) {
            signal.addEventListener("abort", () => events.push("first:abort"), {
              once: true,
            });
            events.push("first:mount");
            return () => {
              events.push("first:dispose");
            };
          },
        });
        builder.contentScripts.register({
          id: "broken",
          async mount() {
            events.push("broken:mount");
            throw new Error("async mount failed");
          },
        });
      }),
    );

    await expect(
      mountPluginContentScripts(captured, { pluginId: "demo" }),
    ).rejects.toThrow("async mount failed");
    expect(events).toEqual([
      "first:mount",
      "broken:mount",
      "first:abort",
      "first:dispose",
    ]);
  });

  it("simulates independent content-script instances for multiple app windows", async () => {
    const signals: AbortSignal[] = [];
    const cleanup = vi.fn();
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.contentScripts.register({
          id: "window-instance",
          mount({ signal }) {
            signals.push(signal);
            return cleanup;
          },
        });
      }),
    );

    const windowA = await mountPluginContentScripts(captured, {
      pluginId: "demo",
    });
    const windowB = await mountPluginContentScripts(captured, {
      pluginId: "demo",
    });
    await windowA.lifecycle.dispose();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await windowB.lifecycle.dispose();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("validates content-script ids and mount functions like the host", async () => {
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.contentScripts.register({
            id: "bad id",
            mount: () => {},
          });
        }),
      ),
    ).rejects.toThrow('contentScripts.register: "id" must match');
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.contentScripts.register({
            id: "missing",
            mount: undefined as never,
          });
        }),
      ),
    ).rejects.toThrow('"mount" must be a function');
  });

  it("rejects registrations the host would reject, with the host's message", async () => {
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.navPanel({
            id: "bad id!",
            title: "x",
            icon: "x",
            path: "p",
            component: Panel,
          });
        }),
      ),
    ).rejects.toThrow('slots.navPanel: "id" must match');
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.navPanel({
            id: "panel",
            title: "Panel",
            icon: "FileText",
            path: "panel",
            component: Panel,
            experimental_sidebarAccessory: "nope" as never,
          });
        }),
      ),
    ).rejects.toThrow(
      '"experimental_sidebarAccessory" must be a React component',
    );
    await expect(loadPluginApp({ default: { nope: true } })).rejects.toThrow(
      "not definePluginApp(...)",
    );
  });

  it("captures a nav panel experimental sidebar accessory", async () => {
    function SidebarAccessory() {
      return <span>12</span>;
    }
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.slots.navPanel({
          id: "tasks",
          title: "Tasks",
          icon: "ListTodo",
          path: "tasks",
          component: Panel,
          experimental_sidebarAccessory: SidebarAccessory,
        });
      }),
    );

    expect(captured.navPanels[0]?.experimental_sidebarAccessory).toBe(
      SidebarAccessory,
    );
  });

  it("validates and captures nav panel fixed tabs", async () => {
    function Navigation({ subPath }: PluginNavPanelProps) {
      return <span>{subPath}</span>;
    }
    const targetContract = {
      validate(
        value: import("../../json-value.js").JsonValue,
      ): value is TestTaskTarget {
        return (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          value.kind === "task" &&
          typeof value.taskId === "string"
        );
      },
    };
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.slots.navPanel({
          id: "tasks",
          title: "Tasks",
          icon: "ListTodo",
          path: "tasks",
          component: Panel,
          fixedTabs: [
            {
              panelId: "tasks",
              id: "navigation",
              title: "Navigation",
              icon: "PanelRight",
              component: Navigation,
              layout: "flush",
              experimental_target: targetContract,
            },
          ],
        });
      }),
    );

    expect(captured.navPanels[0]?.fixedTabs).toEqual([
      {
        panelId: "tasks",
        id: "navigation",
        title: "Navigation",
        icon: "PanelRight",
        component: Navigation,
        layout: "flush",
        experimental_target: targetContract,
      },
    ]);
  });

  it("rejects a malformed fixed-tab target contract", async () => {
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.navPanel({
            id: "tasks",
            title: "Tasks",
            icon: "ListTodo",
            path: "tasks",
            component: Panel,
            fixedTabs: [
              {
                panelId: "tasks",
                id: "details",
                title: "Details",
                icon: "Info",
                component: Panel,
                experimental_target: {
                  // @ts-expect-error Runtime collector coverage for malformed JS.
                  validate: "not-a-function",
                },
              },
            ],
          });
        }),
      ),
    ).rejects.toThrow(
      '"experimental_target.validate" must be a function when set',
    );
  });

  it("rejects a fixed-tab reference scoped to a different nav panel", async () => {
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.navPanel({
            id: "tasks",
            title: "Tasks",
            icon: "ListTodo",
            path: "tasks",
            component: Panel,
            fixedTabs: [
              {
                panelId: "other-page",
                id: "navigation",
                title: "Navigation",
                icon: "PanelRight",
                component: Panel,
              },
            ],
          });
        }),
      ),
    ).rejects.toThrow(
      '"panelId" must match its containing navPanel id "tasks"',
    );
  });

  it("rejects a fixed-tab registration without an owner panel", async () => {
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.navPanel({
            id: "tasks",
            title: "Tasks",
            icon: "ListTodo",
            path: "tasks",
            component: Panel,
            fixedTabs: [
              // @ts-expect-error Runtime collector coverage for malformed JS.
              {
                id: "navigation",
                title: "Navigation",
                icon: "PanelRight",
                component: Panel,
              },
            ],
          });
        }),
      ),
    ).rejects.toThrow('"panelId" must be a non-empty string');
  });

  it("rejects duplicate nav panel fixed tab ids", async () => {
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.navPanel({
            id: "tasks",
            title: "Tasks",
            icon: "ListTodo",
            path: "tasks",
            component: Panel,
            fixedTabs: [
              {
                panelId: "tasks",
                id: "navigation",
                title: "First",
                icon: "PanelRight",
                component: Panel,
              },
              {
                panelId: "tasks",
                id: "navigation",
                title: "Second",
                icon: "PanelRight",
                component: Panel,
              },
            ],
          });
        }),
      ),
    ).rejects.toThrow('duplicate id "navigation"');
  });

  it("captures messageDirective registrations", () => {
    expect(app.messageDirectives).toEqual([
      { id: "inline-vis", component: InlineVis },
    ]);
  });

  it("captures composer customizations", () => {
    expect(app.composerCustomizations).toEqual([
      {
        id: "improve-prompt",
        scopes: ["thread", "new-thread"],
        actions: [{ id: "improve", component: ComposerProbe }],
      },
    ]);
  });

  it("mirrors host isolation for malformed composer regions and duplicate entries", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const malformed = await loadPluginApp(
      definePluginApp((builder) => {
        builder.composer.customize({
          id: "nested",
          actions: {} as never,
          banners: [
            { id: "banner", component: ComposerProbe },
            { id: "banner", component: ComposerProbe },
          ],
          plusMenu: [
            { id: "bad", label: "", run: () => {} },
            { id: "good", label: "Good", run: () => {} },
          ],
        });
      }),
    );

    expect(malformed.composerCustomizations).toEqual([
      {
        id: "nested",
        banners: [{ id: "banner", component: ComposerProbe }],
        plusMenu: [{ id: "good", label: "Good", run: expect.any(Function) }],
      },
    ]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("actions: must be an array"),
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('duplicate id "banner"'),
    );
  });

  it("does not reserve nested ids for malformed composer contributions", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    warning.mockClear();
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.composer.customize({
          id: "reused-after-malformed",
          actions: [
            { id: "same-action", component: null as never },
            { id: "same-action", component: ComposerProbe },
          ],
          banners: [
            {
              id: "same-banner",
              chrome: "dialog" as never,
              component: ComposerProbe,
            },
            { id: "same-banner", component: ComposerProbe },
          ],
          plusMenu: [
            { id: "same-menu", label: "", run: () => {} },
            { id: "same-menu", label: "Valid menu", run: () => {} },
          ],
          richText: {
            effects: [
              { id: "same-effect", className: "", match: () => [] },
              {
                id: "same-effect",
                className: "valid-effect",
                match: () => [],
              },
            ],
          },
        });
      }),
    );

    const [customization] = captured.composerCustomizations;
    expect(customization?.actions?.map(({ id }) => id)).toEqual([
      "same-action",
    ]);
    expect(customization?.banners?.map(({ id }) => id)).toEqual([
      "same-banner",
    ]);
    expect(customization?.plusMenu?.map(({ id }) => id)).toEqual(["same-menu"]);
    expect(customization?.richText?.effects?.map(({ id }) => id)).toEqual([
      "same-effect",
    ]);
    expect(warning).toHaveBeenCalledTimes(4);
    expect(
      warning.mock.calls.some(([reason]) =>
        String(reason).includes("duplicate id"),
      ),
    ).toBe(false);
  });

  it("rejects invalid and duplicate messageDirective ids like the host", async () => {
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.messageDirective({
            id: "Inline_Vis",
            component: InlineVis,
          });
        }),
      ),
    ).rejects.toThrow('slots.messageDirective: "id" must match');
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.messageDirective({
            id: "inline-vis",
            component: InlineVis,
          });
          builder.slots.messageDirective({
            id: "inline-vis",
            component: InlineVis,
          });
        }),
      ),
    ).rejects.toThrow('slots.messageDirective: duplicate id "inline-vis"');
  });

  it("captures messageAction registrations and validates them like the host", async () => {
    expect(app.messageActions).toHaveLength(1);
    expect(app.messageActions[0]).toMatchObject({
      id: "summarize",
      title: "Summarize",
      icon: "Zap",
    });
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.messageAction({
            id: "no-run",
            title: "No run",
            // @ts-expect-error deliberately invalid: run is required
            run: undefined,
          });
        }),
      ),
    ).rejects.toThrow('slots.messageAction: "run" must be a function');
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.messageAction({
            id: "dup",
            title: "One",
            run: () => {},
          });
          builder.slots.messageAction({
            id: "dup",
            title: "Two",
            run: () => {},
          });
        }),
      ),
    ).rejects.toThrow('slots.messageAction: duplicate id "dup"');
  });

  it("validates experimental_providerIcon registrations like the host", async () => {
    const captured = await loadPluginApp(
      definePluginApp((builder) => {
        builder.slots.experimental_providerIcon({
          providerId: "acp-cursor",
          icon: () => null,
        });
      }),
    );
    expect(captured.providerIcons).toHaveLength(1);
    expect(captured.providerIcons[0]?.providerId).toBe("acp-cursor");
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.experimental_providerIcon({
            providerId: "bb-plugin-x/codex",
            icon: () => null,
          });
        }),
      ),
    ).rejects.toThrow(
      'slots.experimental_providerIcon: "providerId" must match',
    );
    await expect(
      loadPluginApp(
        definePluginApp((builder) => {
          builder.slots.experimental_providerIcon({
            providerId: "codex",
            icon: () => null,
          });
          builder.slots.experimental_providerIcon({
            providerId: "codex",
            icon: () => null,
          });
        }),
      ),
    ).rejects.toThrow('slots.experimental_providerIcon: duplicate id "codex"');
  });

  it("invokes a captured messageAction run with a plugin-authored context", () => {
    const openPanel = (options: { actionId: string }) =>
      options.actionId === "panel";
    app.messageActions[0]!.run({
      threadId: "thr_main",
      message: {
        id: "msg_1",
        threadId: "thr_main",
        role: "assistant",
        text: "An answer.",
        sourceSeqEnd: 12,
      },
      selectedText: "answer",
      openPanel,
    });
    expect(messageActionRuns).toHaveLength(1);
    expect(messageActionRuns[0]).toMatchObject({
      threadId: "thr_main",
      selectedText: "answer",
    });
  });

  it("renders the ThreadChat stub with recorded props inside a slot", () => {
    const chatPanel = app.navPanels.find((panel) => panel.id === "chat")!;
    const slot = renderSlot(chatPanel, { subPath: "thr_42" });
    const stub = slot.getByTestId("bb-thread-chat");
    expect(stub.getAttribute("data-thread-id")).toBe("thr_42");
    expect(stub.getAttribute("data-variant")).toBe("compact");
    expect(stub.getAttribute("data-layout")).toBe("document");
    expect(stub.getAttribute("data-focus-request")).toBe("2");
    expect(stub.getAttribute("data-message-actions")).toBe("send-to-main");
    expect(stub.className).toBe("demo-chat");
  });

  it("renders leadingContent and drives messageActions through the stub", () => {
    messageActionRuns.length = 0;
    const chatPanel = app.navPanels.find((panel) => panel.id === "chat")!;
    const slot = renderSlot(chatPanel, { subPath: "thr_42" });
    expect(
      slot.getByTestId("bb-thread-chat-leading-content").textContent,
    ).toContain("Replying to something earlier");

    const action = slot.getByTestId("bb-thread-chat-action-send-to-main");
    expect(action.getAttribute("data-roles")).toBe("assistant");
    fireEvent.click(action);
    expect(messageActionRuns).toEqual([
      {
        id: "test-message",
        threadId: "thr_42",
        role: "assistant",
        text: "test message text",
        sourceSeqEnd: 1,
      },
    ]);
  });
});

describe("typed rpc test runtime", () => {
  it("preserves contract method, input, and result types while recording calls", async () => {
    const slot = renderSlot<PluginNavPanelProps, typeof typedRpcContract>(
      { component: TypedRpcPanel },
      { subPath: "" },
      {
        rpc: {
          getItem(input) {
            return { title: `Item ${input.id}` };
          },
        },
      },
    );
    await slot.findByText("Item item-1");
    expect(slot.rpcCalls).toEqual([
      { method: "getItem", input: { id: "item-1" } },
    ]);
  });
});

describe("renderSlot", () => {
  it("records URL intents from links and imperative navigation through one host boundary", () => {
    const slot = renderSlot(
      { component: UrlNavigationProbe },
      {},
      { openUrl: () => true },
    );
    fireEvent.click(slot.getByRole("link", { name: "Open link" }));
    const explicitTargetLink = slot.getByRole("link", {
      name: "Open in explicit target",
    });
    expect(explicitTargetLink.getAttribute("target")).toBe("preview-pane");
    expect(explicitTargetLink.getAttribute("rel")).toBe(
      "nofollow noopener noreferrer",
    );
    expect(fireEvent.click(explicitTargetLink)).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Open imperatively" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openUrl", url: "https://example.com/from-link" },
      {
        method: "openUrl",
        url: "https://example.com/imperative",
      },
    ]);
  });

  it("exposes a scheme-safe href for file links", () => {
    const slot = renderSlot(
      { component: SchemeLikeFileLinkProbe },
      {},
      { openFilePreview: () => true },
    );
    const link = slot.getByRole("link", { name: "Open scheme-like file" });
    expect(link.getAttribute("href")).toBe("./vscode%3Afoo");
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "experimental_openFilePreview",
        options: {
          target: {
            kind: "workspace",
            environmentId: "env_42",
            path: "vscode:foo",
          },
          location: null,
        },
      },
    ]);
  });

  it("makes malformed file-link targets inert", () => {
    const slot = renderSlot(
      { component: MalformedFileLinkProbe },
      {},
      { openFilePreview: () => true },
    );
    const invalid = slot.getByText("Open malformed file");
    expect(
      slot.queryByRole("link", { name: "Open malformed file" }),
    ).toBeNull();
    expect(invalid.getAttribute("href")).toBeNull();
    fireEvent.click(invalid);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("makes malformed Unicode file-link targets inert", () => {
    const slot = renderSlot(
      { component: MalformedUnicodeFileLinkProbe },
      {},
      { openFilePreview: () => true },
    );
    const invalid = slot.getByText("Open malformed Unicode file");
    expect(
      slot.queryByRole("link", { name: "Open malformed Unicode file" }),
    ).toBeNull();
    expect(invalid.getAttribute("href")).toBeNull();
    fireEvent.click(invalid);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("records file-link preview and imperative external intents through one host boundary", () => {
    const slot = renderSlot(
      { component: FileNavigationProbe },
      {},
      {
        openFilePreview: () => true,
        openFileExternally: () => true,
      },
    );
    fireEvent.click(slot.getByRole("link", { name: "Open file" }));
    fireEvent.click(slot.getByRole("button", { name: "Open file externally" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "experimental_openFilePreview", options: fileIntent },
      { method: "experimental_openFileExternally", options: fileIntent },
    ]);
  });

  it("records fixed-tab opens and retains target state until the owner clears it", () => {
    const slot = renderSlot(
      { component: FixedTabProbe },
      {},
      {
        experimental_openFixedTab: () => true,
        experimental_fixedTabTarget: {
          panelId: "tasks",
          tabId: "details",
          target: { kind: "task", taskId: "TASK-7" },
        },
      },
    );

    fireEvent.click(slot.getByRole("button", { name: "Clear TASK-7" }));
    expect(slot.queryByRole("button", { name: "Clear TASK-7" })).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Open details" }));
    expect(slot.getByRole("button", { name: "Clear TASK-42" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Select details" }));
    expect(slot.getByRole("button", { name: "Clear TASK-42" })).toBeTruthy();
    expect(slot.inspection.experimental_fixedTabOpenCalls).toEqual([
      {
        surface: { kind: "current" },
        panelId: "tasks",
        tabId: "details",
        target: { kind: "task", taskId: "TASK-42" },
      },
      {
        surface: { kind: "current" },
        panelId: "tasks",
        tabId: "details",
      },
    ]);
  });

  it("drives the shared realtime connection lifecycle", async () => {
    const slot = renderSlot(
      app.homepageSections[0]!,
      { projectId: null },
      { realtimeConnectionState: "connecting" },
    );
    await slot.findByText("Realtime: connecting");

    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Realtime: connected");

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.findByText("Realtime: reconnecting");
  });

  it("refreshes rendered RPC data after a realtime event", async () => {
    let listing = ["a.md"];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { listItems: () => listing } },
    );
    await slot.findByText("a.md");
    expect(slot.rpcCalls).toEqual([
      { method: "listItems", input: { subPath: "" } },
    ]);
    expect(slot.inspection.rpcCalls).toBe(slot.rpcCalls);
    expect(slot.behavior.emitRealtime).toBe(slot.emitRealtime);

    listing = ["a.md", "b.md"];
    await slot.behavior.emitRealtime("items-changed", null);
    await slot.findByText("b.md");
    slot.lifecycle.unmount();
    expect(slot.queryByText("b.md")).toBeNull();
  });

  it("reports RPC methods without handlers", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {});
    await slot.findByText(
      'error: no rpc handler for "listItems" — add it to renderSlot options.rpc',
    );
    expect(slot.rpcCalls).toEqual([
      { method: "listItems", input: { subPath: "" } },
    ]);
  });

  it("renders a messageDirective with attributes, source, and message", async () => {
    const slot = renderSlot(app.messageDirectives[0]!, {
      attributes: { file: "demo.html" },
      source: '::inline-vis{file="demo.html"}',
      message: {
        id: "msg_1",
        threadId: "thr_1",
        turnId: "turn_1",
        projectId: "proj_1",
      },
      openWorkspaceFile: null,
    });
    expect(slot.getByTestId("file").textContent).toBe("demo.html");
    expect(slot.getByTestId("source").textContent).toBe(
      '::inline-vis{file="demo.html"}',
    );
    expect(slot.getByTestId("thread").textContent).toBe("thr_1");
  });

  it("reads, replaces, functionally updates, and clears isolated composer text", () => {
    const threadSlot = renderSlot(
      app.composerCustomizations[0]!.actions![0]!,
      {},
      {
        context: { projectId: "proj_1", threadId: "thr_1" },
        composer: { text: "seed" },
      },
    );
    const newThreadSlot = renderSlot(
      app.composerCustomizations[0]!.actions![0]!,
      {},
      {
        context: { projectId: "proj_1", threadId: null },
        composer: { text: "new-thread seed" },
      },
    );
    const thread = within(threadSlot.container);
    const newThread = within(newThreadSlot.container);

    expect(thread.getByTestId("composer-scope").textContent).toBe("thread");
    expect(thread.getByTestId("composer-text").textContent).toBe("seed");
    fireEvent.click(thread.getByText("replace"));
    fireEvent.click(thread.getByText("update"));
    fireEvent.click(thread.getByText("update"));
    expect(threadSlot.composer.text).toBe("replacement!!");
    expect(thread.getByTestId("composer-text").textContent).toBe(
      "replacement!!",
    );
    expect(newThreadSlot.composer.text).toBe("new-thread seed");

    fireEvent.click(thread.getByText("clear"));
    expect(threadSlot.composer.text).toBe("");
    expect(newThreadSlot.composer.text).toBe("new-thread seed");
    expect(newThread.getByTestId("composer-scope").textContent).toBe(
      "new-thread",
    );
  });

  it("exposes an explicit side-chat composer scope", () => {
    const sideChatScope = {
      kind: "side-chat",
      projectId: "proj_1",
      parentThreadId: "thr_parent",
      tabId: "side-chat:one",
      childThreadId: null,
    } satisfies PluginComposerScope;
    const slot = renderSlot(
      app.composerCustomizations[0]!.actions![0]!,
      {},
      { composer: { text: "side-chat draft", scope: sideChatScope } },
    );

    expect(
      JSON.parse(
        slot.getByTestId("composer-scope-details").textContent ?? "{}",
      ),
    ).toEqual(sideChatScope);
  });

  it("drives host-originated composer text and scope changes", async () => {
    const initialScope = {
      kind: "queued-message",
      threadId: "thr_1",
      queuedMessageId: "qmsg_1",
    } satisfies PluginComposerScope;
    const nextScope = {
      kind: "side-chat",
      projectId: "proj_1",
      parentThreadId: "thr_parent",
      tabId: "side-chat:one",
      childThreadId: null,
    } satisfies PluginComposerScope;
    const slot = renderSlot(
      app.composerCustomizations[0]!.actions![0]!,
      {},
      {
        composer: {
          text: "initial draft",
          scope: initialScope,
          attachmentCount: 2,
        },
      },
    );

    expect(slot.getByTestId("composer-attachment-count").textContent).toBe("2");
    expect(slot.composer.scope).toEqual(initialScope);
    expect(slot.composer.attachmentCount).toBe(2);

    await slot.behavior.setComposerText("host edit");
    expect(slot.getByTestId("composer-text").textContent).toBe("host edit");
    expect(slot.getByTestId("composer-view-text").textContent).toBe(
      "host edit",
    );

    await slot.behavior.setComposerScope(nextScope);
    expect(
      JSON.parse(
        slot.getByTestId("composer-scope-details").textContent ?? "{}",
      ),
    ).toEqual(nextScope);
    expect(slot.composer.scope).toEqual(nextScope);
  });

  it.each([
    {
      name: "attachment-only",
      text: "",
      attachmentCount: 1,
      expected: "false",
    },
    {
      name: "whitespace-only",
      text: " \n\t ",
      attachmentCount: 0,
      expected: "true",
    },
  ])("reports $name composer drafts as empty=$expected", (draft) => {
    const slot = renderSlot(
      app.composerCustomizations[0]!.actions![0]!,
      {},
      { composer: draft },
    );

    expect(slot.getByTestId("composer-is-empty").textContent).toBe(
      draft.expected,
    );
  });

  it("keeps quote, mention, and focus behavior while updating harness text", () => {
    const slot = renderSlot(
      app.composerCustomizations[0]!.actions![0]!,
      {},
      { composer: { text: "draft" } },
    );

    fireEvent.click(slot.getByText("quote"));
    fireEvent.click(slot.getByText("mention"));
    fireEvent.click(slot.getByText("focus"));

    expect(slot.composer.text).toBe("draft\n> picked text\nIdeas ");
    expect(slot.composer.quotes).toEqual(["picked text"]);
    expect(slot.composer.mentions).toEqual([
      { provider: "notes", id: "ideas", label: "Ideas" },
    ]);
    expect(slot.composer.focusCount).toBe(3);
  });

  it("invalidates visual-state setters through both unmount controls", () => {
    for (const control of ["top-level", "lifecycle"] as const) {
      const slot = renderSlot(
        app.composerCustomizations[0]!.actions![0]!,
        {},
        { context: { projectId: "proj_1", threadId: "thr_1" } },
      );
      const setters = capturedComposerVisualSetters;
      if (setters === null)
        throw new Error("composer setters were not captured");

      setters.setTextEffect({ className: "improve-shimmer" });
      setters.setInputLock(true);
      expect(slot.composer.textEffect).toEqual({
        className: "improve-shimmer",
      });
      expect(slot.composer.inputLocked).toBe(true);

      if (control === "top-level") slot.unmount();
      else slot.lifecycle.unmount();
      expect(slot.composer.textEffect).toBeNull();
      expect(slot.composer.inputLocked).toBe(false);

      setters.setTextEffect({ className: "late-effect" });
      setters.setInputLock(true);
      expect(slot.composer.textEffect).toBeNull();
      expect(slot.composer.textEffectCalls).toEqual([
        { className: "improve-shimmer" },
      ]);
      expect(slot.composer.inputLockCalls).toEqual([true]);
    }
  });

  it("invalidates visual-state setters when Testing Library cleans up the root", () => {
    const slot = renderSlot(
      app.composerCustomizations[0]!.actions![0]!,
      {},
      { context: { projectId: "proj_1", threadId: "thr_1" } },
    );
    const setters = capturedComposerVisualSetters;
    if (setters === null) throw new Error("composer setters were not captured");

    setters.setTextEffect({ className: "cleanup-effect" });
    cleanup();

    expect(slot.composer.textEffect).toBeNull();

    setters.setTextEffect({ className: "late-effect" });
    expect(slot.composer.textEffect).toBeNull();
    expect(slot.composer.textEffectCalls).toEqual([
      { className: "cleanup-effect" },
    ]);
  });
});
