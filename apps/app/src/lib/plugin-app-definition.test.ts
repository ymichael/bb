import { describe, expect, it, vi } from "vitest";
import type {
  ExperimentalSidebarFooterDisclosureController,
  PluginSidebarFooterActionContext,
} from "@get-bb/plugin-sdk";
import { getCollectedSidebarFooterItems } from "@get-bb/plugin-sdk/internal/plugin-app-collector";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import {
  collectPluginAppRegistrations,
  definePluginApp,
  isPluginAppDefinition,
} from "./plugin-app-definition";

function Component() {
  return null;
}

describe("definePluginApp", () => {
  it("brands the setup for host detection", () => {
    const definition = definePluginApp(() => {});
    expect(isPluginAppDefinition(definition)).toBe(true);
    expect(isPluginAppDefinition({})).toBe(false);
    expect(isPluginAppDefinition({ __bbPluginApp: true })).toBe(false);
    expect(isPluginAppDefinition(null)).toBe(false);
  });

  it("rejects a non-function setup", () => {
    expect(() => definePluginApp(undefined as unknown as () => void)).toThrow(
      /setup function/,
    );
  });
});

describe("collectPluginAppRegistrations — experimental_appOverlay", () => {
  it("collects additive app overlays", () => {
    const definition = definePluginApp((app) => {
      app.slots.experimental_appOverlay({
        id: "office",
        component: Component,
      });
    });

    expect(collectPluginAppRegistrations(definition).appOverlays).toEqual([
      { id: "office", component: Component },
    ]);
  });

  it("rejects duplicate ids and malformed components", () => {
    const duplicate = definePluginApp((app) => {
      app.slots.experimental_appOverlay({
        id: "office",
        component: Component,
      });
      app.slots.experimental_appOverlay({
        id: "office",
        component: Component,
      });
    });
    const malformed = definePluginApp((app) => {
      app.slots.experimental_appOverlay({
        id: "office",
        component: null as never,
      });
    });

    expect(() => collectPluginAppRegistrations(duplicate)).toThrow(
      'duplicate id "office"',
    );
    expect(() => collectPluginAppRegistrations(malformed)).toThrow(
      '"component" must be a React component function',
    );
  });
});

describe("collectPluginAppRegistrations — experimental_threadHeaderAction", () => {
  it("collects a header action", () => {
    const definition = definePluginApp((app) => {
      app.slots.experimental_threadHeaderAction({
        id: "subagents",
        title: "Subagents",
        component: Component,
      });
    });
    expect(
      collectPluginAppRegistrations(definition).threadHeaderActions,
    ).toEqual([{ id: "subagents", title: "Subagents", component: Component }]);
  });

  it("rejects two header actions with the same id", () => {
    const definition = definePluginApp((app) => {
      app.slots.experimental_threadHeaderAction({
        id: "subagents",
        title: "One",
        component: Component,
      });
      app.slots.experimental_threadHeaderAction({
        id: "subagents",
        title: "Two",
        component: Component,
      });
    });
    expect(() => collectPluginAppRegistrations(definition)).toThrow(
      /subagents/,
    );
  });

  it("keeps ids independent from the thread-list slot", () => {
    const definition = definePluginApp((app) => {
      app.slots.experimental_threadList({
        id: "inbox",
        title: "Inbox",
        component: Component,
      });
      app.slots.experimental_threadHeaderAction({
        id: "inbox",
        title: "Inbox",
        component: Component,
      });
    });
    const collected = collectPluginAppRegistrations(definition);
    expect(collected.threadLists).toHaveLength(1);
    expect(collected.threadHeaderActions).toHaveLength(1);
  });

  it("rejects a missing title", () => {
    const definition = definePluginApp((app) => {
      app.slots.experimental_threadHeaderAction({
        id: "subagents",
        component: Component,
      } as never);
    });
    expect(() => collectPluginAppRegistrations(definition)).toThrow(/title/);
  });
});

describe("collectPluginAppRegistrations — experimental_threadList", () => {
  it("collects a thread list with its optional fields", () => {
    const definition = definePluginApp((app) => {
      app.slots.experimental_threadList({
        id: "inbox",
        title: "Inbox",
        description: "One flat list.",
        component: Component,
      });
    });

    expect(collectPluginAppRegistrations(definition).threadLists).toEqual([
      {
        id: "inbox",
        title: "Inbox",
        description: "One flat list.",
        component: Component,
      },
    ]);
  });

  it("omits absent optionals rather than storing undefined", () => {
    const definition = definePluginApp((app) => {
      app.slots.experimental_threadList({
        id: "inbox",
        title: "Inbox",
        component: Component,
      });
    });

    const [collected] = collectPluginAppRegistrations(definition).threadLists!;
    expect(collected).toEqual({
      id: "inbox",
      title: "Inbox",
      component: Component,
    });
    expect("description" in collected!).toBe(false);
  });

  it("rejects two lists with the same id", () => {
    const definition = definePluginApp((app) => {
      app.slots.experimental_threadList({
        id: "inbox",
        title: "One",
        component: Component,
      });
      app.slots.experimental_threadList({
        id: "inbox",
        title: "Two",
        component: Component,
      });
    });
    expect(() => collectPluginAppRegistrations(definition)).toThrow(/inbox/);
  });

  it("rejects a missing component", () => {
    const definition = definePluginApp((app) => {
      app.slots.experimental_threadList({
        id: "inbox",
        title: "Inbox",
      } as never);
    });
    expect(() => collectPluginAppRegistrations(definition)).toThrow();
  });
});

describe("collectPluginAppRegistrations — experimental_sidebarFooter", () => {
  it("collects actions and disclosures with live disclosure controls", () => {
    let disclosure: ExperimentalSidebarFooterDisclosureController | null = null;
    const onActivate = vi.fn();
    const openPluginDetails = vi.fn();
    const legacyRun = vi.fn(
      ({ openSettings }: PluginSidebarFooterActionContext) => openSettings(),
    );
    const definition = definePluginApp((app) => {
      app.experimental_sidebarFooter.register({
        kind: "action",
        id: "refresh",
        label: "Refresh",
        icon: "Refresh",
        onActivate,
      });
      app.slots.sidebarFooterAction({
        id: "legacy",
        title: "Legacy action",
        icon: "Bolt",
        run: legacyRun,
      });
      disclosure = app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "usage",
        label: "Provider usage",
        icon: "ChartColumn",
        component: Component,
      });
    });

    const registrations = collectPluginAppRegistrations(definition);
    const sidebarFooterItems = getCollectedSidebarFooterItems(registrations);
    expect(sidebarFooterItems).not.toBeNull();
    if (sidebarFooterItems === null)
      throw new Error("expected collected sidebar footer items");
    expect(registrations.experimentalSidebarFooterItems).toHaveLength(2);
    expect(registrations.experimentalSidebarFooterItems[0]).toMatchObject({
      kind: "action",
      id: "refresh",
      label: "Refresh",
      icon: "Refresh",
      onActivate,
    });
    expect(registrations.experimentalSidebarFooterItems[1]).toMatchObject({
      kind: "disclosure",
      id: "usage",
      label: "Provider usage",
      icon: "ChartColumn",
      component: Component,
    });
    expect(
      sidebarFooterItems.map(({ source, id }) => ({
        source,
        id,
      })),
    ).toEqual([
      { source: "experimental_sidebarFooter", id: "refresh" },
      { source: "sidebarFooterAction", id: "legacy" },
      { source: "experimental_sidebarFooter", id: "usage" },
    ]);
    const compatibilityItem = sidebarFooterItems[1];
    expect(compatibilityItem?.kind).toBe("action");
    if (compatibilityItem?.kind !== "action")
      throw new Error("expected action");
    compatibilityItem.onActivate({ openPluginDetails });
    expect(legacyRun).toHaveBeenCalledOnce();
    expect(openPluginDetails).toHaveBeenCalledOnce();

    disclosure!.open();
    const runtime = registrations.experimentalSidebarFooterItems[1]!.runtime;
    expect(runtime.getSnapshot()).toMatchObject({
      command: { kind: "open" },
    });
    const sequence = runtime.getSnapshot().command?.sequence;
    expect(sequence).toBeTypeOf("number");
    runtime.acknowledgeCommand(sequence!);
    expect(runtime.getSnapshot().command).toBeNull();
  });

  it("shares ids with the compatibility footer-action surface", () => {
    const definition = definePluginApp((app) => {
      app.slots.sidebarFooterAction({
        id: "usage",
        title: "Legacy usage",
        icon: "ChartColumn",
        run: () => {},
      });
      app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "usage",
        label: "Usage",
        icon: "ChartColumn",
        component: Component,
      });
    });

    expect(() => collectPluginAppRegistrations(definition)).toThrow(/usage/);
  });

  it("validates registrations at their boundaries", () => {
    const definition = definePluginApp((app) => {
      app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "usage",
        label: "Usage",
        icon: "ChartColumn",
        component: Component,
      });
    });
    collectPluginAppRegistrations(definition);

    const staleDefinition = definePluginApp((app) => {
      app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "usage",
        label: "Usage",
        icon: "ChartColumn",
        component: Component,
        providerId: "coupled-provider",
      } as never);
    });
    expect(() => collectPluginAppRegistrations(staleDefinition)).toThrow(
      /unknown field "providerId"/,
    );
  });
});

describe("collectPluginAppRegistrations", () => {
  it("produces the same complete registration set in the app and test runtimes", async () => {
    const run = () => {};
    const mount = () => {};
    const match = () => [];
    const definition = definePluginApp((app) => {
      app.slots.homepageSection({
        id: "home",
        title: "Home",
        component: Component,
      });
      app.slots.settingsSection({
        id: "settings",
        title: "Settings",
        description: "Configure it.",
        component: Component,
      });
      app.slots.experimental_appOverlay({
        id: "overlay",
        component: Component,
      });
      app.slots.navPanel({
        id: "panel",
        title: "Panel",
        icon: "Columns",
        path: "panel",
        component: Component,
        experimental_sidebarAccessory: Component,
        headerContent: Component,
      });
      app.slots.threadPanelAction({
        id: "thread-panel",
        title: "Thread panel",
        icon: "Columns",
        component: Component,
        layout: "flush",
        run,
      });
      app.slots.experimental_newThreadPanelAction({
        id: "new-thread-panel",
        title: "New thread panel",
        component: Component,
        layout: "padded",
        run,
      });
      app.slots.pendingInteraction({
        id: "interaction",
        component: Component,
      });
      app.slots.sidebarFooterAction({
        id: "footer",
        title: "Footer",
        icon: "Bolt",
        run,
      });
      app.slots.experimental_threadList({
        id: "threads",
        title: "Threads",
        description: "A thread list.",
        component: Component,
      });
      app.slots.experimental_threadHeaderAction({
        id: "thread-header",
        title: "Thread header",
        component: Component,
      });
      app.slots.fileOpener({
        id: "files",
        title: "Files",
        extensions: ["md", "mdx"],
        component: Component,
      });
      app.slots.messageDirective({
        id: "inline-card",
        component: Component,
      });
      app.slots.messageAction({
        id: "message",
        title: "Message",
        icon: "Bolt",
        run,
      });
      app.composer.customize({
        id: "composer",
        scopes: ["thread", "new-thread"],
        actions: [{ id: "action", component: Component }],
        banners: [{ id: "banner", component: Component }],
        plusMenu: [{ id: "menu", label: "Menu", run }],
        richText: {
          effects: [
            {
              id: "effect",
              className: "effect",
              match,
            },
          ],
          onDraftChange: run,
        },
      });
      app.contentScripts.register({ id: "script", mount });
    });

    expect(await loadPluginApp(definition)).toEqual(
      collectPluginAppRegistrations(definition),
    );
  });

  it("collects every slot kind as plain data", () => {
    const run = () => {};
    const mount = () => {};
    const definition = definePluginApp((app) => {
      app.slots.homepageSection({
        id: "issues",
        title: "Issues",
        component: Component,
      });
      app.slots.settingsSection({
        id: "custom-settings",
        title: "Custom settings",
        component: Component,
      });
      app.slots.experimental_appOverlay({
        id: "floating-widget",
        component: Component,
      });
      app.slots.navPanel({
        id: "board",
        title: "Board",
        icon: "columns",
        path: "board",
        component: Component,
      });
      app.slots.threadPanelAction({
        id: "issue",
        title: "Issue",
        icon: "Columns",
        component: Component,
        run,
      });
      app.slots.experimental_newThreadPanelAction({
        id: "template",
        title: "Apply template",
        icon: "Wand",
        component: Component,
        layout: "flush",
        run,
      });
      app.slots.sidebarFooterAction({
        id: "remote",
        title: "Remote access",
        icon: "Smartphone",
        run,
      });
      app.slots.fileOpener({
        id: "editor",
        title: "Notes editor",
        extensions: ["md", "mdx"],
        component: Component,
      });
      app.slots.messageDirective({
        id: "inline-vis",
        component: Component,
      });
      app.slots.messageAction({
        id: "summarize",
        title: "Summarize",
        icon: "Zap",
        run,
      });
      app.composer.customize({
        id: "improve-prompt",
        scopes: ["thread", "new-thread"],
        actions: [{ id: "improve", component: Component }],
      });
      app.contentScripts.register({
        id: "editor-enhancement",
        mount,
      });
    });

    const registrations = collectPluginAppRegistrations(definition);
    expect(registrations.homepageSections).toEqual([
      { id: "issues", title: "Issues", component: Component },
    ]);
    expect(registrations.settingsSections).toEqual([
      {
        id: "custom-settings",
        title: "Custom settings",
        component: Component,
      },
    ]);
    expect(registrations.appOverlays).toEqual([
      { id: "floating-widget", component: Component },
    ]);
    expect(registrations.navPanels).toEqual([
      {
        id: "board",
        title: "Board",
        icon: "columns",
        path: "board",
        component: Component,
      },
    ]);
    expect(registrations.threadPanelActions).toEqual([
      {
        id: "issue",
        title: "Issue",
        icon: "Columns",
        component: Component,
        run,
      },
    ]);
    expect(registrations.newThreadPanelActions).toEqual([
      {
        id: "template",
        title: "Apply template",
        icon: "Wand",
        component: Component,
        layout: "flush",
        run,
      },
    ]);
    expect(registrations.sidebarFooterActions).toEqual([
      {
        id: "remote",
        title: "Remote access",
        icon: "Smartphone",
        run,
      },
    ]);
    expect(registrations.fileOpeners).toEqual([
      {
        id: "editor",
        title: "Notes editor",
        extensions: ["md", "mdx"],
        component: Component,
      },
    ]);
    expect(registrations.messageDirectives).toEqual([
      { id: "inline-vis", component: Component },
    ]);
    expect(registrations.messageActions).toEqual([
      { id: "summarize", title: "Summarize", icon: "Zap", run },
    ]);
    expect(registrations.composerCustomizations).toEqual([
      {
        id: "improve-prompt",
        scopes: ["thread", "new-thread"],
        actions: [{ id: "improve", component: Component }],
      },
    ]);
    expect(registrations.contentScripts).toEqual([
      { id: "editor-enhancement", mount },
    ]);
  });

  it("rejects invalid composer customizations individually while siblings survive", () => {
    const rejected = vi.fn<(reason: string) => void>();
    const definition = definePluginApp((app) => {
      app.composer.customize({ id: "valid-first" });
      app.composer.customize({ id: "has space" });
      app.composer.customize({ id: "valid-first" });
      app.composer.customize({
        id: "bad-scope",
        scopes: ["modal" as never],
      });
      app.composer.customize({ id: "valid-last", scopes: ["side-chat"] });
    });

    const registrations = collectPluginAppRegistrations(definition, rejected);

    expect(registrations.composerCustomizations).toEqual([
      { id: "valid-first" },
      { id: "valid-last", scopes: ["side-chat"] },
    ]);
    expect(rejected.mock.calls.map(([reason]) => reason)).toEqual([
      expect.stringContaining('"id" must match'),
      expect.stringContaining('duplicate id "valid-first"'),
      expect.stringContaining('invalid scope kind "modal"'),
    ]);
  });

  it("isolates malformed and duplicate nested composer contributions", () => {
    const rejected = vi.fn<(reason: string) => void>();
    const definition = definePluginApp((app) => {
      app.composer.customize({
        id: "malformed-array",
        actions: {} as never,
        banners: [
          { id: "good-banner", component: Component },
          { id: "bad-banner", chrome: "dialog" as never, component: Component },
        ],
      });
      app.composer.customize({
        id: "duplicates",
        actions: [
          { id: "action", component: Component },
          { id: "action", component: Component },
          { id: "survivor", component: Component },
        ],
        plusMenu: [
          { id: "bad-menu", label: "", run: () => {} },
          { id: "good-menu", label: "Good", run: () => {} },
        ],
        richText: {
          effects: [
            { id: "paint", className: "paint", match: () => [] },
            { id: "paint", className: "other", match: () => [] },
            { id: "valid-paint", className: "valid", match: () => [] },
          ],
        },
      });
    });

    const registrations = collectPluginAppRegistrations(definition, rejected);
    const customizations = registrations.composerCustomizations ?? [];

    expect(customizations[0]).toEqual({
      id: "malformed-array",
      banners: [{ id: "good-banner", component: Component }],
    });
    expect(customizations[1]?.actions?.map(({ id }) => id)).toEqual([
      "action",
      "survivor",
    ]);
    expect(customizations[1]?.plusMenu?.map(({ id }) => id)).toEqual([
      "good-menu",
    ]);
    expect(customizations[1]?.richText?.effects?.map(({ id }) => id)).toEqual([
      "paint",
      "valid-paint",
    ]);
    expect(rejected).toHaveBeenCalledWith(
      expect.stringContaining("actions: must be an array"),
    );
    expect(rejected).toHaveBeenCalledWith(
      expect.stringContaining('duplicate id "action"'),
    );
  });

  it("does not reserve nested ids for malformed contributions", () => {
    const rejected = vi.fn<(reason: string) => void>();
    const definition = definePluginApp((app) => {
      app.composer.customize({
        id: "reused-after-malformed",
        actions: [
          { id: "same-action", component: null as never },
          { id: "same-action", component: Component },
        ],
        banners: [
          {
            id: "same-banner",
            chrome: "dialog" as never,
            component: Component,
          },
          { id: "same-banner", component: Component },
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
    });

    const [customization] =
      collectPluginAppRegistrations(definition, rejected)
        .composerCustomizations ?? [];

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
    expect(rejected).toHaveBeenCalledTimes(4);
    expect(
      rejected.mock.calls.some(([reason]) => reason.includes("duplicate id")),
    ).toBe(false);
  });

  it.each([
    [
      "content script without a mount function",
      () =>
        definePluginApp((app) => {
          app.contentScripts.register({
            id: "missing-mount",
            mount: undefined as never,
          });
        }),
      /"mount" must be a function/,
    ],
    [
      "duplicate content script id",
      () =>
        definePluginApp((app) => {
          app.contentScripts.register({
            id: "dup",
            mount: () => {},
          });
          app.contentScripts.register({
            id: "dup",
            mount: () => {},
          });
        }),
      /duplicate id "dup"/,
    ],
    [
      "settings section with a non-string title",
      () =>
        definePluginApp((app) => {
          app.slots.settingsSection({
            id: "x",
            title: 12 as never,
            component: Component,
          });
        }),
      /"title" must be a string when set/,
    ],
    [
      "duplicate settings section id",
      () =>
        definePluginApp((app) => {
          app.slots.settingsSection({ id: "a", component: Component });
          app.slots.settingsSection({ id: "a", component: Component });
        }),
      /duplicate id/,
    ],
    [
      "bad id",
      () =>
        definePluginApp((app) => {
          app.slots.homepageSection({
            id: "has space",
            title: "X",
            component: Component,
          });
        }),
      /"id" must match/,
    ],
    [
      "message action without a run function",
      () =>
        definePluginApp((app) => {
          app.slots.messageAction({
            id: "no-run",
            title: "No run",
            run: undefined as never,
          });
        }),
      /"run" must be a function/,
    ],
    [
      "duplicate message action id",
      () =>
        definePluginApp((app) => {
          app.slots.messageAction({
            id: "a",
            title: "A",
            run: () => {},
          });
          app.slots.messageAction({
            id: "a",
            title: "B",
            run: () => {},
          });
        }),
      /duplicate id "a"/,
    ],
    [
      "sidebar footer action missing run",
      () =>
        definePluginApp((app) => {
          app.slots.sidebarFooterAction({
            id: "x",
            title: "X",
            icon: "Smartphone",
          } as never);
        }),
      /"run" must be a function/,
    ],
    [
      "nav panel path with slash",
      () =>
        definePluginApp((app) => {
          app.slots.navPanel({
            id: "x",
            title: "X",
            icon: "columns",
            path: "a/b",
            component: Component,
          });
        }),
      /"path" must match/,
    ],
    [
      "file opener with no extensions",
      () =>
        definePluginApp((app) => {
          app.slots.fileOpener({
            id: "x",
            title: "X",
            extensions: [],
            component: Component,
          });
        }),
      /"extensions" must be a non-empty array/,
    ],
    [
      "file opener with a dotted extension",
      () =>
        definePluginApp((app) => {
          app.slots.fileOpener({
            id: "x",
            title: "X",
            extensions: [".md"],
            component: Component,
          });
        }),
      /extensions must be lowercase alphanumerics/,
    ],
    [
      "thread panel action with a non-function run",
      () =>
        definePluginApp((app) => {
          app.slots.threadPanelAction({
            id: "x",
            title: "X",
            component: Component,
            run: "nope" as never,
          });
        }),
      /"run" must be a function/,
    ],
    [
      "new thread panel action with a non-function run",
      () =>
        definePluginApp((app) => {
          app.slots.experimental_newThreadPanelAction({
            id: "x",
            title: "X",
            component: Component,
            run: "nope" as never,
          });
        }),
      /"run" must be a function/,
    ],
    [
      "missing component",
      () =>
        definePluginApp((app) => {
          app.slots.homepageSection({
            id: "x",
            title: "X",
            component: undefined as never,
          });
        }),
      /"component" must be/,
    ],
    [
      "nav panel with a non-component headerContent",
      () =>
        definePluginApp((app) => {
          app.slots.navPanel({
            id: "x",
            title: "X",
            icon: "columns",
            path: "x",
            component: Component,
            headerContent: "nope" as never,
          });
        }),
      /"headerContent" must be a React component/,
    ],
    [
      "nav panel with the pre-0.4.16 SDK experimental_fixedTabs key",
      () =>
        definePluginApp((app) => {
          app.slots.navPanel({
            id: "x",
            title: "X",
            icon: "columns",
            path: "x",
            component: Component,
            experimental_fixedTabs: [],
          } as never);
        }),
      'slots.navPanel: "experimental_fixedTabs" was renamed to "fixedTabs" in SDK 0.4.16',
    ],
    [
      "nav panel with an unknown experimental_ key",
      () =>
        definePluginApp((app) => {
          app.slots.navPanel({
            id: "x",
            title: "X",
            icon: "columns",
            path: "x",
            component: Component,
            experimental_badge: Component,
          } as never);
        }),
      'slots.navPanel: unknown field "experimental_badge"',
    ],
    [
      "nav panel with a non-component experimental sidebar accessory",
      () =>
        definePluginApp((app) => {
          app.slots.navPanel({
            id: "x",
            title: "X",
            icon: "columns",
            path: "x",
            component: Component,
            experimental_sidebarAccessory: "nope" as never,
          });
        }),
      /"experimental_sidebarAccessory" must be a React component/,
    ],
    [
      "message directive with uppercase id",
      () =>
        definePluginApp((app) => {
          app.slots.messageDirective({
            id: "Inline-Vis",
            component: Component,
          });
        }),
      /"id" must match/,
    ],
    [
      "message directive with underscore id",
      () =>
        definePluginApp((app) => {
          app.slots.messageDirective({
            id: "inline_vis",
            component: Component,
          });
        }),
      /"id" must match/,
    ],
    [
      "message directive with leading digit",
      () =>
        definePluginApp((app) => {
          app.slots.messageDirective({
            id: "1inline",
            component: Component,
          });
        }),
      /"id" must match/,
    ],
    [
      "duplicate message directive id",
      () =>
        definePluginApp((app) => {
          app.slots.messageDirective({
            id: "inline-vis",
            component: Component,
          });
          app.slots.messageDirective({
            id: "inline-vis",
            component: Component,
          });
        }),
      /duplicate id/,
    ],
    [
      "message directive missing component",
      () =>
        definePluginApp((app) => {
          app.slots.messageDirective({
            id: "inline-vis",
            component: undefined as never,
          });
        }),
      /"component" must be/,
    ],
  ])("rejects %s", (_name, build, message) => {
    expect(() => collectPluginAppRegistrations(build())).toThrow(message);
  });

  it("keeps a headerContent registration", () => {
    function Accessory() {
      return null;
    }
    const definition = definePluginApp((app) => {
      app.slots.navPanel({
        id: "board",
        title: "Board",
        icon: "columns",
        path: "board",
        component: Component,
        headerContent: Accessory,
      });
    });
    expect(
      collectPluginAppRegistrations(definition).navPanels[0],
    ).toMatchObject({
      headerContent: Accessory,
    });
  });

  it("keeps an experimental_sidebarAccessory registration", () => {
    function SidebarAccessory() {
      return null;
    }
    const definition = definePluginApp((app) => {
      app.slots.navPanel({
        id: "board",
        title: "Board",
        icon: "columns",
        path: "board",
        component: Component,
        experimental_sidebarAccessory: SidebarAccessory,
      });
    });
    expect(
      collectPluginAppRegistrations(definition).navPanels[0],
    ).toMatchObject({
      experimental_sidebarAccessory: SidebarAccessory,
    });
  });
});
