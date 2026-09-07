// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";

import type { rpcContract } from "./server";
import {
  COMPONENT_SPECIMENS,
  MOCK_VIEWS,
  OVERLAY_SPECIMENS,
  STYLESHEET_SPECIMEN_IDS,
} from "./taxonomy";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

type Catalog = Awaited<ReturnType<PluginRpcTestHandlers<typeof rpcContract>["themeCatalog"]>>;

const DEFAULT_CATALOG: Catalog = {
  activeThemeId: "default",
  revision: 0,
  themes: [
    {
      id: "default",
      name: "Default",
      light: null,
      dark: null,
    },
    {
      id: "plugin:endless:endless-color",
      name: "Endless Color",
      light: null,
      dark: null,
    },
  ],
};

const ENDLESS_CATALOG: Catalog = {
  ...DEFAULT_CATALOG,
  activeThemeId: "plugin:endless:endless-color",
};

const LONG_THEME_NAME = "Endless Color copy with a deliberately descriptive name";
const LONG_NAME_CATALOG: Catalog = {
  activeThemeId: "long-theme",
  revision: 0,
  themes: [
    ...DEFAULT_CATALOG.themes,
    { id: "long-theme", name: LONG_THEME_NAME, light: null, dark: null },
  ],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let panel: Awaited<ReturnType<typeof loadPluginApp>>["navPanels"][number];

beforeAll(async () => {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  // Radix Select relies on pointer-capture and scroll APIs jsdom lacks.
  Object.assign(HTMLElement.prototype, {
    scrollIntoView: () => {},
    hasPointerCapture: () => false,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  });
  const root = document.documentElement.style;
  const tokens: Record<string, string> = {
    canvas: "#ffffff", ink: "#222222", sidebar: "#f5f5f5", "sidebar-foreground": "#222222",
    card: "#ffffff", popover: "#ffffff", secondary: "#eeeeee", muted: "#e8e8e8",
    "surface-recessed-solid": "#f2f2f2", "surface-scrim": "#ffffffee", foreground: "#222222",
    "subtle-foreground": "#666666", "readback-foreground": "#999999",
    primary: "#444444", "file-accent": "#4779a8", "timeline-accent": "#4779a8",
    "surface-selected": "#d7e4ef", "state-hover": "#eeeeee", "state-active": "#dddddd",
    success: "#3b966c", warning: "#b56b2c",
    attention: "#c49a32", destructive: "#b6383f", "pr-merged": "#7550a8", "font-sans": "Inter, sans-serif",
    "diff-added": "#3b966c", "diff-removed": "#b6383f", border: "#cccccc",
    "border-hairline": "#eeeeee", "border-seam": "#dddddd", "sidebar-border": "#cccccc",
    input: "#aaaaaa", ring: "#4779a8",
    "font-mono": "Menlo, monospace", "text-sm": "13px", "text-sm--line-height": "20px", spacing: "4px", "tracking-normal": "0em",
    "bb-sidebar-row-height": "28px", "icon-stroke-width": "1.75", radius: "8px", "shadow-x": "0px",
    "shadow-y": "2px", "shadow-blur": "0px", "shadow-spread": "0px", "shadow-color": "#333333",
    "shadow-opacity": "0.15",
  };
  for (const [name, value] of Object.entries(tokens)) root.setProperty(`--${name}`, value);
  const app = await loadPluginApp(() => import("./app"));
  const registered = app.navPanels.find(({ id }) => id === "preview");
  if (!registered) throw new Error("Theme Preview panel was not registered");
  panel = registered;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  document.documentElement.classList.remove("dark");
  localStorage.removeItem("bb.theme");
});

function renderPreview(rpc: PluginRpcTestHandlers<typeof rpcContract>, subPath = "thread") {
  return renderSlot(panel, { subPath }, { rpc });
}

function themeControl(): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>("[data-tp-theme-control]");
  if (!control) throw new Error("Theme picker control was not rendered");
  return control;
}

function openThemeMenu(): void {
  // Without a real pointer (jsdom), Radix's select takes its touch path:
  // the trigger opens and items commit on click.
  fireEvent.click(themeControl());
}

function pickOption(option: HTMLElement): void {
  fireEvent.click(option);
}

async function chooseEndlessDark(): Promise<void> {
  const control = themeControl();
  await waitFor(() => expect(control.textContent).toContain("Default"));
  // Selecting the theme is the one setTheme call these tests exercise; the
  // mode switch is a separate control with its own call.
  openThemeMenu();
  const options = await screen.findAllByRole("option");
  const endless = options.find((option) => option.textContent?.includes("Endless Color"));
  if (!endless) throw new Error("Endless Color option was not rendered");
  pickOption(endless);
}

describe("Theme Preview", () => {
  it("keeps the chrome free of implementation notes and personal identity", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });

      await waitFor(() => expect(document.querySelector("[data-tp-band=desktop]")).not.toBeNull());
      expect(screen.queryByText(/amber = sidebar override/i)).toBeNull();
      expect(screen.queryByText(/preview only/i)).toBeNull();
      expect(screen.queryByText(/live values/i)).toBeNull();
      expect(screen.queryByText(/theme applies live/i)).toBeNull();
      expect(screen.queryByText(/values are measured from the rendered theme/i)).toBeNull();
      expect(screen.queryByText("brsbl")).toBeNull();
    } finally {
      width.mockRestore();
    }
  });

  it("navigates views with bb's tabs and offers themes with bb's select", async () => {
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => DEFAULT_CATALOG,
    });

    const tabs = within(screen.getByRole("tablist", { name: "Preview view" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Thread", "New thread", "Split", "Settings"]);
    const threadTab = screen.getByRole("tab", { name: "Thread" });
    expect(threadTab.className).toContain("focus-visible:outline-none");
    expect(threadTab.className).toContain("focus-visible:ring-2");
    expect(threadTab.className).toContain("cursor-pointer");

    const control = themeControl();
    expect(control.getAttribute("role")).toBe("combobox");
    expect(control.className).toContain("focus:outline-none");
    expect(control.className).toContain("focus:ring-1");
  });

  it("keeps the thread table of contents open and interactive", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });

      const toc = await waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-tp-thread-toc]");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      const tabs = within(toc).getAllByRole("tab");
      expect(tabs.map((tab) => tab.textContent)).toEqual(["Agent", "You"]);
      expect(within(toc).getByRole("tab", { name: "You" }).getAttribute("aria-selected")).toBe("true");
      expect(within(toc).getByRole("button", { name: /Make the blacklight variant/i }).getAttribute("aria-current")).toBe("true");

      fireEvent.mouseDown(within(toc).getByRole("tab", { name: "Agent" }));
      const second = await within(toc).findByRole("button", { name: /Selection now reads/i });
      fireEvent.click(second);
      expect(second.getAttribute("aria-current")).toBe("true");
    } finally {
      width.mockRestore();
    }
  });

  it("projects every mock view from its current BB screen anatomy", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    const rpc = {
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => DEFAULT_CATALOG,
    };
    try {
      renderPreview(rpc, "thread");
      const info = await waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-tp-thread-info]");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      expect(within(info).getByText("Info")).toBeDefined();
      expect(within(info).getByText("Diff")).toBeDefined();
      expect(within(info).queryByText("Changes")).toBeNull();

      cleanup();
      renderPreview(rpc, "new");
      const welcome = await waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-tp-new-welcome]");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      expect(
        within(welcome).getByRole("button", {
          name: /New thread\s*Start a new conversation/i,
        }),
      ).toBeDefined();
      expect(
        within(welcome).getByRole("button", {
          name: /Learn what bb can do\s*Get a tour/i,
        }),
      ).toBeDefined();
      expect(within(welcome).queryByText("What are we building?")).toBeNull();

      cleanup();
      renderPreview(rpc, "split");
      await waitFor(() => expect(document.querySelectorAll("[data-tp-split-pane]")).toHaveLength(2));
      const splitPanes = [...document.querySelectorAll<HTMLElement>("[data-tp-split-pane]")];
      expect(splitPanes.map((pane) => pane.dataset.focused)).toEqual(["true", "false"]);
      expect(splitPanes[1]?.querySelector<HTMLElement>("[data-pane-focus-scrim]")?.style.background).toContain("30%");

      cleanup();
      renderPreview(rpc, "settings");
      const settings = await waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-tp-settings-content=appearance]");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("page");
      expect(within(settings).getByRole("button", { name: "Palette" }).textContent).toContain("Default");
      expect(within(settings).getByRole("switch", { name: "Fade inactive splits" })).toBeDefined();
      expect(document.querySelector("[data-tp-mock-sidebar=settings]")).not.toBeNull();
      expect(document.querySelector("[data-tp-mock-sidebar=settings] [data-tp-sidebar-state=selected]")?.textContent).toContain("Appearance");
      expect(within(settings).queryByText("Extensions")).toBeNull();
      expect(within(settings).queryByText("Installed")).toBeNull();
    } finally {
      width.mockRestore();
    }
  });

  it("lists every theme in both modes as real select options", async () => {
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => DEFAULT_CATALOG,
    });

    const control = themeControl();
    await waitFor(() => expect(control.textContent).toContain("Default"));
    // The mode switch carries the accessible labels instead of repeating them
    // per row. Checked before opening: an open select aria-hides the page.
    expect(screen.getByRole("button", { name: "Light mode" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Dark mode" }).getAttribute("aria-pressed")).toBe("false");
    openThemeMenu();

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    // One row per theme; mode is a separate switch, not a repeated label.
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.textContent)).toEqual(["Default", "Endless Color"]);
    expect(listbox.textContent).not.toMatch(/light|dark/i);
    const active = options.find((option) => option.getAttribute("aria-selected") === "true");
    expect(active?.textContent).toContain("Default");
  });

  it("keeps short names intrinsic and truncates long names only at the available-width boundary", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      const short = renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });

      await waitFor(() => expect(themeControl().textContent).toContain("Default"));
      const shortControl = themeControl();
      expect(shortControl.style.width).toBe("fit-content");
      expect(shortControl.style.maxWidth).toBe("100%");
      expect(shortControl.className).not.toContain("max-w-52");
      expect(document.querySelector<HTMLElement>("[data-tp-theme-picker-row]")?.style.width).toBe("fit-content");
      short.lifecycle.unmount();
      cleanup();

      width.mockReturnValue(360);
      renderPreview({
        themeCatalog: () => LONG_NAME_CATALOG,
        setTheme: () => LONG_NAME_CATALOG,
      });

      await waitFor(() => expect(document.querySelector("[data-tp-band=mobile]")).not.toBeNull());
      const longControl = await screen.findByRole("combobox", { name: new RegExp(LONG_THEME_NAME) });
      const longName = document.querySelector<HTMLElement>("[data-tp-theme-name]");
      expect(longName?.textContent).toBe(LONG_THEME_NAME);
      expect(longName?.style.textOverflow).toBe("ellipsis");
      expect(longName?.style.minWidth).toBe("0px");
      expect(longControl.className).toContain("overflow-hidden");
      expect(document.querySelector<HTMLElement>("[data-tp-theme-picker-row]")?.style.maxWidth).toBe("100%");
    } finally {
      width.mockRestore();
    }
  });

  it("uses light and dark icons while preserving keyboard mode selection", async () => {
    const selections: Array<{ themeId: string }> = [];
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: (selection) => {
        selections.push(selection);
        return DEFAULT_CATALOG;
      },
    });

    await screen.findByRole("combobox", { name: /Default light/i });
    const light = screen.getByRole("button", { name: "Light mode" });
    const dark = screen.getByRole("button", { name: "Dark mode" });
    expect(light.querySelector('[data-tp-mode-icon="light"]')).not.toBeNull();
    expect(dark.querySelector('[data-tp-mode-icon="dark"]')).not.toBeNull();
    expect(light.getAttribute("aria-pressed")).toBe("true");
    expect(dark.getAttribute("aria-pressed")).toBe("false");

    dark.focus();
    expect(document.activeElement).toBe(dark);
    fireEvent.click(dark, { detail: 0 });
    await waitFor(() => expect(selections).toEqual([{ themeId: "default" }]));
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    expect(light.getAttribute("aria-pressed")).toBe("false");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("bb.theme")).toBe("dark");

    light.focus();
    fireEvent.click(light, { detail: 0 });
    await waitFor(() => expect(selections).toEqual([
      { themeId: "default" },
      { themeId: "default" },
    ]));
    expect(light.getAttribute("aria-pressed")).toBe("true");
    expect(dark.getAttribute("aria-pressed")).toBe("false");
  });

  it("restacks the main areas on mobile with the read-only style sheet last", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(480);
    try {
      renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });

      await waitFor(() => expect(document.querySelector("[data-tp-band=mobile]")).not.toBeNull());
      expect(screen.queryByRole("button", { name: /full style guide/i })).toBeNull();
      // The compact interaction areas stay together before the style sheet.
      const areas = [...document.querySelectorAll("[data-tp-area]")].map((el) => el.getAttribute("data-tp-area"));
      expect(areas).toEqual(["mock", "overlays", "components", "stylesheet"]);
      expect(document.querySelector("[data-tp-style-readonly]")).not.toBeNull();
      expect(document.querySelector("[data-tp-shadow-preview]")).not.toBeNull();
    } finally {
      width.mockRestore();
    }
  });

  it("renders the complete taxonomy inventory at desktop widths", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });
      await waitFor(() => expect(document.querySelector("[data-tp-band=desktop]")).not.toBeNull());

      // Area 1: one tab per mock view.
      for (const view of MOCK_VIEWS) {
        expect(screen.getByRole("tab", { name: view.label })).toBeDefined();
      }
      // Area 2: every style-sheet specimen is one discrete inspection element.
      expect(screen.queryByRole("button", { name: "Advanced" })).toBeNull();
      expect(document.querySelector("[data-tp-editor-tier=advanced]")).toBeNull();
      expect(document.querySelector("[data-tp-area=stylesheet] input")).toBeNull();
      for (const specimenId of STYLESHEET_SPECIMEN_IDS) {
        const specimens = document.querySelectorAll(`[data-tp-specimen="${specimenId}"]`);
        expect(specimens, specimenId).toHaveLength(1);
        expect(specimens[0]?.hasAttribute("data-tp-style-segment"), specimenId).toBe(true);
        expect((specimens[0] as HTMLElement | undefined)?.style.gridTemplateColumns, specimenId).toContain("minmax(72px, 1fr)");
        expect((specimens[0] as HTMLElement | undefined)?.style.gridColumn, specimenId).toBe("1 / -1");
        expect(specimens[0]?.querySelector("[data-tp-role=label]"), specimenId).not.toBeNull();
        expect(specimens[0]?.querySelector("[data-tp-role=value]"), specimenId).not.toBeNull();
      }
      for (const block of document.querySelectorAll<HTMLElement>("[data-tp-area=stylesheet] [data-tp-grid]")) {
        expect(block.style.display).toBe("grid");
        expect(block.style.gridTemplateColumns).not.toBe("");
        expect(block.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
        expect(block.style.alignContent).toBe("start");
        expect(block.style.border).toContain("1px solid");
        expect(block.style.overflow).toBe("hidden");
        const category = block.querySelector<HTMLElement>("[data-tp-role=category]");
        expect(category?.style.background).toContain("var(--surface-recessed-soft-solid");
        expect(category?.style.minHeight).toBe("32px");
        expect(category?.style.padding).toBe("6px 10px");
      }
      const colorGrid = document.querySelector<HTMLElement>("[data-tp-style-colors]");
      const systemGrid = document.querySelector<HTMLElement>("[data-tp-style-systems]");
      expect(colorGrid?.style.gap).toBe("16px");
      expect(colorGrid?.style.alignItems).toBe("start");
      expect(systemGrid?.style.marginTop).toBe("20px");
      expect(systemGrid?.style.alignItems).toBe("start");
      expect(colorGrid?.querySelector("[data-tp-block=lines]")).toBeNull();
      expect(systemGrid?.querySelector("[data-tp-block=lines]")).not.toBeNull();
      const canvasSegment = document.querySelector<HTMLElement>('[data-tp-specimen="color:canvas"]');
      expect(canvasSegment?.style.minHeight).toBe("32px");
      expect(canvasSegment?.style.padding).toBe("6px 10px");
      expect(canvasSegment?.style.borderTop).toContain("1px solid");
      expect(canvasSegment?.querySelector("[data-tp-role=preview]")).not.toBeNull();
      expect(canvasSegment?.querySelector("[data-tp-role=label]")?.textContent).toBe("canvas");
      expect(canvasSegment?.querySelector("[data-tp-role=value]")?.textContent).toMatch(/^#|—$/);
      const inkMeta = document.querySelector<HTMLElement>('[data-tp-specimen="color:ink"] [data-tp-role=meta]');
      expect(inkMeta?.style.overflow).toBe("hidden");
      expect(inkMeta?.style.textOverflow).toBe("ellipsis");
      const contrastLabels = [...document.querySelectorAll<HTMLElement>('[data-tp-column="contrast"]')];
      expect(contrastLabels).toHaveLength(2);
      expect(contrastLabels.map((label) => label.closest<HTMLElement>("[data-tp-block]")?.dataset.tpBlock)).toEqual(["ink", "status"]);
      for (const label of contrastLabels) {
        expect(label.textContent).toBe("Contrast");
        const header = label.parentElement as HTMLElement;
        const firstSegment = header.closest<HTMLElement>("[data-tp-block]")?.querySelector<HTMLElement>("[data-tp-style-segment]");
        expect(header.style.gridTemplateColumns).toBe(firstSegment?.style.gridTemplateColumns);
      }
      expect(document.querySelector('[data-tp-column="token"]')).toBeNull();
      expect(document.querySelector('[data-tp-column="value"]')).toBeNull();
      // Area 3: every static component block renders.
      for (const specimen of COMPONENT_SPECIMENS) {
        expect(document.querySelector(`[data-tp-block="${specimen.id}"]`), specimen.id).not.toBeNull();
      }
      // The mock already carries representative sidebar rows; there is no
      // redundant standalone thread-list card in the rail.
      expect(document.querySelector("[data-tp-thread-list]")).toBeNull();
      // Area 4: every overlay has its launcher (in the rail at this width).
      for (const overlay of OVERLAY_SPECIMENS) {
        expect(screen.getByRole("button", { name: overlay.label })).toBeDefined();
      }
    } finally {
      width.mockRestore();
    }
  });

  it("composes the mock from natural panels instead of scaling a desktop window", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(480);
    try {
      renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });

      const frame = await waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-tp-frame]");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });
      // No zoom/scale and no hardcoded desktop width — the frame is fluid.
      expect(frame.style.zoom ?? "").toBe("");
      expect(frame.style.transform).toBe("");
      expect(frame.style.width).toBe("100%");
      const container = frame.closest<HTMLElement>("[data-tp-mock-container]");
      expect(container?.style.width).toBe("100%");
      expect(container?.style.maxWidth).toBe("100%");
      expect(container?.style.boxSizing).toBe("border-box");
      expect(container?.style.padding).toBe("16px");
      // At a phone-width pane the sidebar and info panel stay out.
      expect(screen.queryByText("bb-plugins")).toBeNull();
      expect(screen.queryByText("Pull request")).toBeNull();
    } finally {
      width.mockRestore();
    }
  });

  it("keeps the style sheet passive while showing every visual system", async () => {
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => DEFAULT_CATALOG,
    });

    await waitFor(() => expect(document.querySelector("[data-tp-style-readonly]")).not.toBeNull());
    const sheet = document.querySelector("[data-tp-area=stylesheet]");
    expect(sheet?.querySelector("input, select, [role=slider]")).toBeNull();
    expect(within(sheet as HTMLElement).getByText("Typography")).toBeDefined();
    expect(within(sheet as HTMLElement).getByText("Rhythm")).toBeDefined();
    expect(within(sheet as HTMLElement).getByText("Corner radius")).toBeDefined();
    expect(within(sheet as HTMLElement).getByText("Shadow")).toBeDefined();
    expect(document.querySelector("[data-tp-shadow-preview]")).not.toBeNull();
  });

  it("includes the sidebar and info panel once the pane is wide enough", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });

      await waitFor(() => expect(screen.queryByText("bb-plugins")).not.toBeNull());
      expect(screen.getByText("Pull request")).toBeDefined();
      expect(document.querySelector("[data-tp-mock-sidebar=left]")).not.toBeNull();
      expect(document.querySelector("[data-tp-mock-sidebar=right]")).not.toBeNull();
      expect(document.querySelector("[data-tp-mock-sidebar=left] [data-tp-sidebar-state=selected]")?.textContent).toContain("Endless theme family");
    } finally {
      width.mockRestore();
    }
  });

  it("keeps the transient bb surfaces deliberately inspectable in the overlays block", async () => {
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => DEFAULT_CATALOG,
    });

    expect(screen.getByText("Overlays")).toBeDefined();
    for (const name of ["Menu", "Dialog", "Popover", "Tooltip", "Hover card", "Toast"]) {
      expect(screen.getByRole("button", { name })).toBeDefined();
    }

    // The dialog opens as a real bb dialog with its scrim and footer actions.
    fireEvent.click(screen.getByRole("button", { name: "Dialog" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Archive thread?")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // One at a time: the menu opens as a real bb dropdown menu.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Menu" }), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename…",
      "Open in split",
      "Copy link",
      "Archive",
    ]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    // Hover-only surfaces still answer a click, so no specimen button is silent.
    fireEvent.click(screen.getByRole("button", { name: "Tooltip" }));
    expect(await screen.findByRole("tooltip")).toBeDefined();
  });

  it("keeps Components directly below Overlays as a sibling in the desktop rail", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });
      await waitFor(() => expect(document.querySelector("[data-tp-band=desktop]")).not.toBeNull());

      const rail = document.querySelector("[data-tp-section=rail]");
      const areas = [...(rail?.children ?? [])].filter((element) => element.hasAttribute("data-tp-area"));
      expect(areas.map((area) => area.getAttribute("data-tp-area"))).toEqual(["overlays", "components"]);
      expect(areas[0]?.nextElementSibling).toBe(areas[1]);
      expect(areas[0]?.contains(areas[1] ?? null)).toBe(false);
      expect(within(areas[1] as HTMLElement).getByRole("heading", { name: "Components", level: 2 })).toBeDefined();
    } finally {
      width.mockRestore();
    }
  });

  it("keeps badges on one row and the component specimens evenly grouped", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });
      await waitFor(() => expect(document.querySelector("[data-tp-band=desktop]")).not.toBeNull());

      const badges = document.querySelector<HTMLElement>("[data-tp-badge-row]");
      expect(badges?.style.flexWrap).toBe("nowrap");
      expect(badges?.style.overflowX).toBe("auto");

      const components = document.querySelector<HTMLElement>("[data-tp-components]");
      expect(components?.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
      expect(components?.style.columnGap).toBe("16px");
      expect(components?.style.rowGap).toBe("16px");
      expect(document.querySelector<HTMLElement>("[data-tp-button-grid]")?.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
      for (const block of document.querySelectorAll<HTMLElement>("[data-tp-block=switch], [data-tp-block=checkbox]")) {
        expect(block.style.paddingBlock).toBe(
          "calc(var(--spacing, 0.25rem) * 3)",
        );
        expect(block.style.paddingInline).toBe("");
        expect(block.querySelector<HTMLElement>("[data-tp-toggle-controls]")?.style.paddingInline).toBe("");
      }
    } finally {
      width.mockRestore();
    }
  });

  it("gives each split pane its own conversation", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      renderSlot(panel, { subPath: "split" }, {
        rpc: {
          themeCatalog: () => DEFAULT_CATALOG,
          setTheme: () => DEFAULT_CATALOG,
        },
      });

      await waitFor(() => expect(screen.queryAllByText(/lay the specimen sheet out as a grid/i)).toHaveLength(1));
      // The blacklight transcript appears only in the first pane.
      expect(screen.getAllByText(/Three blacks were fragmenting the frame/i)).toHaveLength(1);
    } finally {
      width.mockRestore();
    }
  });

  it("keeps the hover card dismissible and its controls usable", async () => {
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => DEFAULT_CATALOG,
    });

    const trigger = document.querySelector<HTMLButtonElement>("[data-tp-hovercard-trigger]");
    if (!trigger) throw new Error("Hover card trigger was not rendered");

    // Hover is Radix's own lifecycle (delayed open, close once the pointer has
    // left trigger AND content), so the trigger must not force it open itself.
    expect(trigger.getAttribute("data-state")).toBe("closed");

    // Click is an explicit toggle, so a second click dismisses.
    fireEvent.click(trigger);
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-tp-hovercard-content]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    // The card carries real controls, and using one must not dismiss it.
    const copy = within(card).getByRole("button", { name: "Copy branch" });
    expect(within(card).getByRole("button", { name: "Open in split" })).toBeDefined();
    fireEvent.click(copy);
    expect(document.querySelector("[data-tp-hovercard-content]")).not.toBeNull();

    fireEvent.click(trigger);
    await waitFor(() => expect(document.querySelector("[data-tp-hovercard-content]")).toBeNull());
  });

  it("keeps preview controls genuinely interactive", async () => {
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => DEFAULT_CATALOG,
    });

    // Input accepts typing.
    const search = await screen.findByRole("textbox", { name: "Search threads" });
    fireEvent.change(search, { target: { value: "endless color" } });
    expect((search as HTMLInputElement).value).toBe("endless color");
    expect(screen.queryByRole("textbox", { name: "Filter" })).toBeNull();

    // Switch and checkbox toggle, and expose checked state.
    const notifications = screen.getByRole("switch", { name: "Notifications" });
    const before = notifications.getAttribute("aria-checked");
    fireEvent.click(notifications);
    expect(notifications.getAttribute("aria-checked")).not.toBe(before);

    const drafts = screen.getByRole("checkbox", { name: "Include drafts" });
    const checkedBefore = drafts.getAttribute("aria-checked");
    fireEvent.click(drafts);
    expect(drafts.getAttribute("aria-checked")).not.toBe(checkedBefore);

    // Disabled states are real, not painted.
    expect((screen.getByRole("button", { name: "Disabled" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives the tooltip a dismissal delay and keyboard focus support", async () => {
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => DEFAULT_CATALOG,
    });
    const trigger = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>("[data-tp-tooltip-trigger]");
      expect(found).not.toBeNull();
      return found as HTMLButtonElement;
    });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Keyboard focus opens it, not just hover.
    fireEvent.focus(trigger);
    await waitFor(() => expect(document.querySelector("[data-tp-tooltip-content]")).not.toBeNull());

    // Pointer-out does not dismiss immediately: it survives normal movement.
    fireEvent.mouseLeave(trigger);
    await act(async () => { await sleep(250); });
    expect(document.querySelector("[data-tp-tooltip-content]")).not.toBeNull();

    // ...and is gone once the dismissal delay elapses.
    await act(async () => { await sleep(700); });
    await waitFor(() => expect(document.querySelector("[data-tp-tooltip-content]")).toBeNull());
  });

  it("reports neutral contrast ratios without accessibility verdicts or authoring actions", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    try {
      const slot = renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });
      await waitFor(() => expect(document.querySelector("[data-tp-band=desktop]")).not.toBeNull());

      const sheet = document.querySelector("[data-tp-area=stylesheet]");
      const blocks = [...(sheet?.querySelectorAll("[data-tp-block]") ?? [])].map((el) => el.getAttribute("data-tp-block"));
      expect(blocks).toEqual(["surfaces", "ink", "accent", "status", "lines", "typography", "rhythm", "radius", "shadow"]);
      expect(sheet?.querySelector("input, select, [role=slider], button")).toBeNull();
      const ratios = await waitFor(() => {
        const found = document.querySelectorAll("[data-tp-contrast-ratio]");
        expect(found).toHaveLength(13);
        expect(
          document.querySelector(
            "[data-tp-specimen='color:ink'] [data-tp-contrast-ratio]",
          )?.textContent,
        ).toMatch(/^\d+\.\d{2}:1$/);
        expect(
          document.querySelector(
            "[data-tp-specimen='color:readback-foreground'] [data-tp-contrast-ratio]",
          )?.textContent,
        ).toMatch(/^\d+\.\d{2}:1$/);
        return found;
      });
      expect([...ratios].some((ratio) => ratio.textContent?.includes("Pass") || ratio.textContent?.includes("Fail"))).toBe(false);
      expect(sheet?.querySelector("[data-tp-validation]")).toBeNull();
      expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["themeCatalog"]);
    } finally {
      width.mockRestore();
    }
  });

  it("keeps the last resolved catalog across route remounts instead of flashing an empty picker", async () => {
    const first = renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => DEFAULT_CATALOG,
    });
    await screen.findByRole("combobox", { name: /Default/i });
    first.lifecycle.unmount();

    const refresh = deferred<Catalog>();
    renderPreview({
      themeCatalog: () => refresh.promise,
      setTheme: () => DEFAULT_CATALOG,
    });

    expect(screen.getByRole("combobox", { name: /Default/i })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Loading themes" })).toBeNull();
    await act(async () => refresh.resolve(DEFAULT_CATALOG));
  });

  it("keeps the header, preview rail, and guide on one ultrawide alignment spine", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(3120);
    try {
      renderPreview({
        themeCatalog: () => DEFAULT_CATALOG,
        setTheme: () => DEFAULT_CATALOG,
      });

      await waitFor(() => expect(document.querySelector("[data-tp-band=desktop]")).not.toBeNull());
      const header = document.querySelector<HTMLElement>("[data-tp-header-inner]");
      expect(header?.style.maxWidth).toBe("1600px");
      expect(header?.style.padding).toContain("20px");
      expect(document.querySelector<HTMLElement>("[data-tp-layout=desktop]")?.style.maxWidth).toBe("1600px");
      expect(document.querySelector<HTMLElement>("[data-tp-mock-container]")?.style.padding).toBe("20px");
      expect(document.querySelector<HTMLElement>("[data-tp-area=components]")?.closest("[data-tp-layout=desktop]")?.getAttribute("data-tp-layout")).toBe("desktop");
      const stylesheet = document.querySelector<HTMLElement>("[data-tp-area=stylesheet]");
      expect(stylesheet?.style.maxWidth).toBe("1600px");
      expect(stylesheet?.style.padding).toContain("20px");
    } finally {
      width.mockRestore();
    }
  });

  it("queues one immediate refresh when change signals arrive during a stale catalog request", async () => {
    const stale = deferred<Catalog>();
    let catalogCalls = 0;
    const slot = renderPreview({
      themeCatalog: () => {
        catalogCalls += 1;
        return catalogCalls === 1 ? stale.promise : ENDLESS_CATALOG;
      },
      setTheme: () => ENDLESS_CATALOG,
    });

    await waitFor(() => expect(catalogCalls).toBe(1));
    await slot.behavior.emitRealtime("theme-preview:changed", null);
    await slot.behavior.emitRealtime("theme-preview:changed", null);

    await act(async () => stale.resolve(DEFAULT_CATALOG));

    await waitFor(() => expect(catalogCalls).toBe(2));
    expect(screen.getByRole("combobox", { name: /Endless Color/i })).toBeDefined();
    expect(catalogCalls).toBe(2);
  });

  it("times out a stuck catalog request and lets the queued refresh recover", async () => {
    vi.useFakeTimers();
    const stuck = deferred<Catalog>();
    let catalogCalls = 0;
    renderPreview({
      themeCatalog: () => {
        catalogCalls += 1;
        return catalogCalls === 1 ? stuck.promise : ENDLESS_CATALOG;
      },
      setTheme: () => ENDLESS_CATALOG,
    });

    await act(async () => { await Promise.resolve(); });
    expect(catalogCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(catalogCalls).toBe(2);
    expect(screen.getByRole("combobox", { name: /Endless Color/i })).toBeDefined();
  });

  it("owns a visible pending state and blocks duplicate selections", async () => {
    const pending = deferred<Catalog>();
    let selectionCalls = 0;
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => {
        selectionCalls += 1;
        return pending.promise;
      },
    });

    await chooseEndlessDark();

    const control = await screen.findByRole("combobox", { name: /Applying Endless Color/i });
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(control.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(control);
    expect(selectionCalls).toBe(1);
    expect(screen.queryByRole("listbox")).toBeNull();

    await act(async () => pending.resolve(ENDLESS_CATALOG));
    await waitFor(() => expect((screen.getByRole("combobox", { name: /Endless Color/i }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("keeps a failed selection recoverable beside the owning control", async () => {
    let selectionCalls = 0;
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => {
        selectionCalls += 1;
        if (selectionCalls === 1) throw new Error("rpc disconnected");
        return ENDLESS_CATALOG;
      },
    });

    await chooseEndlessDark();

    expect((await screen.findByRole("alert")).textContent).toContain("Theme didn’t apply");
    fireEvent.click(screen.getByRole("button", { name: "Retry theme" }));
    await waitFor(() => expect((screen.getByRole("combobox", { name: /Endless Color/i }) as HTMLButtonElement).disabled).toBe(false));
    expect(selectionCalls).toBe(2);
  });

  it("releases a never-settling selection when its deadline expires", async () => {
    const stuck = deferred<Catalog>();
    renderPreview({
      themeCatalog: () => DEFAULT_CATALOG,
      setTheme: () => stuck.promise,
    });

    const control = themeControl();
    await waitFor(() => expect(control.textContent).toContain("Default"));

    vi.useFakeTimers();
    openThemeMenu();
    const options = screen.getAllByRole("option");
    const endless = options.find((option) => option.textContent?.includes("Endless Color"));
    if (!endless) throw new Error("Endless Color option was not rendered");
    pickOption(endless);

    expect(control.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(control.disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("Theme didn’t apply");
  });
});
