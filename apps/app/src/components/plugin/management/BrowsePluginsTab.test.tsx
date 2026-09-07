// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type {
  PluginCatalogSearchData,
  PluginCatalogSearchEntry,
} from "@/hooks/queries/plugin-catalog-queries";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { BrowsePluginsTab } from "./BrowsePluginsTab";

vi.mock("@/components/plugin/PluginNewThreadComposer", () => ({
  PluginNewThreadComposer: ({ initialPrompt }: { initialPrompt?: string }) => (
    <div data-testid="inline-composer">{initialPrompt}</div>
  ),
}));

const MEMORY_ENTRY: PluginCatalogSearchEntry = {
  entryId: "memory",
  pluginId: "memory",
  displayName: "Memory",
  description: "Durable memory for agents.",
  icon: "Brain",
  iconUrl: null,
  iconTinted: false,
  categoryId: "memory-and-context",
  category: "Memory & Context",
  screenshots: [],
  collections: [],
  publishedAt: "2026-08-20T00:00:00Z",
  source: "builtin:memory",
  repositoryUrl: null,
  marketplace: "bb-official",
  marketplaceDisplayName: "BB Official",
  publisherKey: "bb-official",
  publisherLabel: "BB Official",
  official: true,
  author: {
    name: "BB",
    github: "get-bb",
    url: "https://github.com/get-bb",
  },
  installed: false,
  installs: 4_210,
  compatible: true,
  incompatibleReason: null,
};

const SECURITY_ENTRY: PluginCatalogSearchEntry = {
  ...MEMORY_ENTRY,
  entryId: "security",
  pluginId: "security",
  displayName: "Security",
  description: "Protect agent work.",
  categoryId: "security",
  category: "Security",
  publishedAt: undefined,
  installs: 900,
};

const TASKS_ENTRY: PluginCatalogSearchEntry = {
  ...MEMORY_ENTRY,
  entryId: "tasks",
  pluginId: "tasks",
  displayName: "Tasks",
  description: "Track work.",
  categoryId: "tasks-and-workflows",
  category: "Tasks & Workflows",
  publishedAt: "2026-08-25T00:00:00Z",
  installs: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubCatalog(data: PluginCatalogSearchData) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/plugin-catalog/search")) {
        return jsonResponse({
          results: data.entries,
          collections: data.collections,
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    }),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderBrowse(
  data: PluginCatalogSearchData,
  initialEntry = "/extensions/plugins",
  onInstall = vi.fn(),
  onOpenPlugin = vi.fn(),
) {
  stubCatalog(data);
  const { wrapper } = createQueryClientTestHarness();
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <BrowsePluginsTab
        onInstall={onInstall}
        onOpenPlugin={onOpenPlugin}
        onInstallFromSource={() => undefined}
      />
      <LocationProbe />
    </MemoryRouter>,
    { wrapper },
  );
  return { onInstall, onOpenPlugin };
}

function cardOrder(): string[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Open "][aria-label$=" details"]',
    ),
  ].map((button) => button.getAttribute("aria-label") ?? "");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowsePluginsTab", () => {
  it("shows collection shelves before category shelves", async () => {
    renderBrowse({
      entries: [
        {
          ...MEMORY_ENTRY,
          collections: [{ id: "new-and-notable", rank: 1 }],
        },
        SECURITY_ENTRY,
        {
          ...TASKS_ENTRY,
          collections: [{ id: "new-and-notable", rank: 0 }],
        },
      ],
      collections: [
        {
          id: "new-and-notable",
          displayName: "New & notable",
          pluginIds: ["tasks", "memory"],
        },
      ],
    });

    await screen.findByRole("heading", { name: "New & notable" });
    const labels = [
      ...document.querySelectorAll("[data-testid='plugin-browse-shelves'] h2"),
    ].map((heading) => heading.textContent);
    expect(labels).toEqual([
      "New & notable",
      "Memory & Context",
      "Security",
      "Tasks & Workflows",
    ]);
    expect(screen.getAllByText("Memory")).toHaveLength(2);
    expect(screen.queryByText("BB Official plugins")).toBeNull();
  });

  it("round trips the search parameter", async () => {
    renderBrowse(
      { entries: [MEMORY_ENTRY], collections: [] },
      "/extensions/plugins?query=Mem",
    );

    const search = await screen.findByRole("textbox", {
      name: "Search plugins",
    });
    expect((search as HTMLInputElement).value).toBe("Mem");
    fireEvent.change(search, { target: { value: "Memory" } });

    const params = new URLSearchParams(
      screen.getByTestId("location-search").textContent ?? "",
    );
    expect(params.get("query")).toBe("Memory");
  });

  it("routes the card author name and preserves the Browse filters", async () => {
    const onOpenPlugin = vi.fn();
    renderBrowse(
      { entries: [MEMORY_ENTRY], collections: [] },
      "/extensions/plugins?category=memory-and-context&sort=recently-added",
      vi.fn(),
      onOpenPlugin,
    );

    fireEvent.click(await screen.findByRole("link", { name: "BB" }));
    const params = new URLSearchParams(
      screen.getByTestId("location-search").textContent ?? "",
    );
    expect(params.get("author")).toBe("11:bb-official:github:get-bb");
    expect(params.getAll("category")).toEqual(["memory-and-context"]);
    expect(params.get("sort")).toBe("recently-added");
    expect(onOpenPlugin).not.toHaveBeenCalled();
  });

  it("round trips repeatable category parameters", async () => {
    renderBrowse(
      { entries: [MEMORY_ENTRY, SECURITY_ENTRY, TASKS_ENTRY], collections: [] },
      "/extensions/plugins?category=memory-and-context&category=security",
    );

    const trigger = await screen.findByRole("button", {
      name: "Filter plugins by category: Memory & Context, Security",
    });
    expect(trigger.textContent).toContain("2 categories");
    fireEvent.click(trigger);
    fireEvent.click(
      await screen.findByRole("option", { name: /Tasks & Workflows/u }),
    );

    const params = new URLSearchParams(
      screen.getByTestId("location-search").textContent ?? "",
    );
    expect(params.getAll("category")).toEqual([
      "memory-and-context",
      "security",
      "tasks-and-workflows",
    ]);
    fireEvent.click(screen.getByRole("option", { name: /Security/u }));
    const nextParams = new URLSearchParams(
      screen.getByTestId("location-search").textContent ?? "",
    );
    expect(nextParams.getAll("category")).toEqual([
      "memory-and-context",
      "tasks-and-workflows",
    ]);
  });

  it("orders category options by the shelf category order", async () => {
    renderBrowse({
      entries: [
        TASKS_ENTRY,
        {
          ...MEMORY_ENTRY,
          entryId: "unknown",
          pluginId: "unknown",
          displayName: "Unknown",
          categoryId: "unknown-category",
          category: "Unknown Category",
        },
        {
          ...MEMORY_ENTRY,
          entryId: "uncategorized",
          pluginId: "uncategorized",
          displayName: "Uncategorized",
          categoryId: undefined,
          category: undefined,
        },
        SECURITY_ENTRY,
        MEMORY_ENTRY,
      ],
      collections: [],
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Filter plugins by category: All categories",
      }),
    );
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual([
      expect.stringContaining("Memory & Context"),
      expect.stringContaining("Security"),
      expect.stringContaining("Tasks & Workflows"),
      expect.stringContaining("Unknown Category"),
      expect.stringContaining("Uncategorized"),
    ]);
  });

  it("disables the install sort when no listing publishes a count", async () => {
    renderBrowse({
      entries: [
        { ...MEMORY_ENTRY, installs: null },
        { ...SECURITY_ENTRY, installs: null },
      ],
      collections: [],
    });

    const sortTrigger = await screen.findByRole("button", {
      name: "Sort: Featured",
    });
    fireEvent.pointerDown(sortTrigger);
    expect(
      screen
        .getByRole("menuitemradio", { name: "Most installed" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("sorts by install count and sinks uncounted entries in both directions", async () => {
    renderBrowse(
      { entries: [MEMORY_ENTRY, SECURITY_ENTRY, TASKS_ENTRY], collections: [] },
      "/extensions/plugins?sort=most-installed",
    );

    await screen.findByText("Memory");
    expect(cardOrder()).toEqual([
      "Open Memory details",
      "Open Security details",
      "Open Tasks details",
    ]);
    const trigger = screen.getByRole("button", {
      name: "Sort: Most installed, descending",
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Most installed" }),
    );
    expect(cardOrder()).toEqual([
      "Open Security details",
      "Open Memory details",
      "Open Tasks details",
    ]);
    expect(screen.getByText("Memory & Context")).toBeTruthy();
  });

  it("puts entries without a published date last in both directions", async () => {
    renderBrowse(
      { entries: [MEMORY_ENTRY, SECURITY_ENTRY, TASKS_ENTRY], collections: [] },
      "/extensions/plugins?sort=recently-added",
    );

    await screen.findByText("Memory");
    expect(cardOrder()).toEqual([
      "Open Tasks details",
      "Open Memory details",
      "Open Security details",
    ]);
    const trigger = screen.getByRole("button", {
      name: "Sort: Recently added, descending",
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Recently added" }),
    );
    expect(cardOrder()).toEqual([
      "Open Memory details",
      "Open Tasks details",
      "Open Security details",
    ]);
  });

  it("clears a flat sort and restores the shelves", async () => {
    renderBrowse(
      { entries: [MEMORY_ENTRY, SECURITY_ENTRY], collections: [] },
      "/extensions/plugins?sort=most-installed",
    );

    const trigger = await screen.findByRole("button", {
      name: "Sort: Most installed, descending",
    });
    expect(screen.queryByTestId("plugin-browse-shelves")).toBeNull();
    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Featured" }));
    expect(await screen.findByTestId("plugin-browse-shelves")).toBeTruthy();
    const params = new URLSearchParams(
      screen.getByTestId("location-search").textContent ?? "",
    );
    expect(params.has("sort")).toBe(false);
    expect(params.has("direction")).toBe(false);
  });

  it("expands a shelf beyond the six-entry limit", async () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      ...MEMORY_ENTRY,
      entryId: `memory-${index}`,
      pluginId: `memory-${index}`,
      displayName: `Memory ${index}`,
    }));
    renderBrowse({ entries, collections: [] });

    await screen.findByTestId("plugin-browse-shelves");
    expect(cardOrder()).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "See all" }));
    expect(cardOrder()).toHaveLength(8);
  });

  it("shows all five cards in a narrow shelf", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 700,
    });
    const entries = Array.from({ length: 5 }, (_, index) => ({
      ...MEMORY_ENTRY,
      entryId: `memory-${index}`,
      pluginId: `memory-${index}`,
      displayName: `Memory ${index}`,
    }));
    renderBrowse({ entries, collections: [] });

    await screen.findByTestId("plugin-browse-shelves");
    expect(cardOrder()).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "See all" })).toBeNull();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalWidth,
    });
  });

  it("uses the shared error state and retries catalog searches", async () => {
    let searchAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith("/api/v1/plugin-catalog/search")) {
          searchAttempts += 1;
          return searchAttempts === 1
            ? jsonResponse({ error: "unavailable" }, 503)
            : jsonResponse({ results: [MEMORY_ENTRY], collections: [] });
        }
        return jsonResponse({ error: "not found" }, 404);
      }),
    );
    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <BrowsePluginsTab
          onInstall={() => undefined}
          onOpenPlugin={() => undefined}
          onInstallFromSource={() => undefined}
        />
      </MemoryRouter>,
      { wrapper },
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The plugin catalog is not available.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Memory")).toBeTruthy();
    expect(searchAttempts).toBe(2);
  });

  it("marks installed entries instead of offering install", async () => {
    renderBrowse({
      entries: [{ ...MEMORY_ENTRY, installed: true }],
      collections: [],
    });

    const installed = await screen.findByLabelText("Installed");
    expect(installed.textContent).toContain("Installed");
    expect(installed.querySelector('[data-icon="Check"]')).toBeTruthy();
    expect(screen.getByLabelText("4,210 installs")).toBeTruthy();
    expect(installed.tagName).toBe("SPAN");
    expect(
      screen.queryByRole("button", { name: /Install Memory/u }),
    ).toBeNull();
  });

  it("swaps the browse body for examples while composing", async () => {
    renderBrowse({ entries: [MEMORY_ENTRY], collections: [] });

    expect(
      await screen.findByRole("button", { name: "Open Memory details" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create a plugin" }));
    expect(await screen.findByText("Start from an example")).toBeTruthy();
    expect(screen.getByText("Explore plugin capabilities")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Search plugins" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open Memory details" }),
    ).toBeNull();
  });

  it("routes every create affordance into the inline composer", async () => {
    renderBrowse({ entries: [MEMORY_ENTRY], collections: [] });

    fireEvent.click(
      await screen.findByRole("button", { name: "Create a plugin" }),
    );
    expect((await screen.findByTestId("inline-composer")).textContent).toBe(
      "Create a new bb plugin that ",
    );
    fireEvent.click(
      screen.getByText(
        "Ship a board your agents move cards across while they work.",
      ),
    );
    expect(
      (await screen.findByTestId("inline-composer")).textContent,
    ).toContain("kanban board panel");
    fireEvent.click(screen.getByText("CLI command"));
    expect(
      (await screen.findByTestId("inline-composer")).textContent,
    ).toContain("deploys the current branch to staging");
  });

  it("shows compact install data and reports the card trigger", async () => {
    const onInstall = vi.fn();
    const onOpenPlugin = vi.fn();
    renderBrowse(
      { entries: [MEMORY_ENTRY], collections: [] },
      "/extensions/plugins?sort=most-installed",
      onInstall,
      onOpenPlugin,
    );

    const install = await screen.findByRole("button", {
      name: "Install Memory — 4,210 installs",
    });
    expect(install.textContent).toContain("4.2K");
    fireEvent.click(install);
    expect(onInstall).toHaveBeenCalledWith({
      entryId: "memory",
      pluginId: "memory",
      marketplace: "bb-official",
      publisherLabel: "BB Official",
      displayName: "Memory",
      icon: "Brain",
      iconUrl: null,
      iconTinted: false,
      source: "builtin:memory",
    });
    const open = screen.getByRole("button", {
      name: "Open Memory details",
    });
    fireEvent.click(open);
    expect(onOpenPlugin).toHaveBeenCalledWith("memory", open);
  });
});
