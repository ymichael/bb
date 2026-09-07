// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PLUGIN_UPDATE_STATE,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { PluginDetailPaneView, ToolsView } from "./ToolsView";
import {
  CatalogPluginDetail,
  CatalogPluginDetailBanner,
  PluginDetail,
  PluginDetailBanners,
  PluginProvenancePill,
  pluginFrontendDiagnosticRequiresFailureBanner,
} from "@/components/tools/PluginDetail";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import { pluginSourceQueryKey } from "@/hooks/queries/query-keys";
import type { PluginFrontendDiagnostic } from "@/lib/plugin-frontend";
import {
  makePluginListItem,
  makePluginRegistrationSet,
} from "@/test/fixtures/plugins";

vi.mock("react-resizable-panels", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const require = createRequire(import.meta.url);
  return require(
    join(
      dirname(require.resolve("react-resizable-panels/package.json")),
      "dist/react-resizable-panels.browser.cjs.js",
    ),
  );
});

const GITHUB_PLUGIN = makePluginListItem({
  id: "github",
  source: "builtin:github",
  rootDir: "/Users/you/.bb/plugins/github",
  description: "Browse GitHub issues and pull requests in BB.",
  name: "GitHub",
  icon: "Github",
  app: { hasApp: true, bundle: null },
  provenance: "catalog",
  catalogEntryId: "github",
  publisherLabel: "BB Official",
  sourceDisplay: "BB Official · GitHub",
});

const GITHUB_CATALOG_ENTRY = {
  entryId: "github",
  marketplace: "bb-official",
  pluginId: "github",
  displayName: "GitHub",
  description: "Browse GitHub issues and pull requests in BB.",
  icon: "Github",
  iconUrl: null,
  iconTinted: false,
  category: "Developer tools",
  screenshots: [],
  collections: [],
  source: "builtin:github",
  repositoryUrl: null,
  marketplaceDisplayName: "BB Official",
  publisherKey: "bb-official",
  publisherLabel: "BB Official",
  official: true,
  author: null,
  installed: false,
  installs: null,
  compatible: true,
  incompatibleReason: null,
} satisfies PluginCatalogSearchEntry;

function RoutedToolsView() {
  const location = useLocation();
  const isSettings = location.pathname.startsWith("/settings/plugins/");
  const prefix = isSettings ? "/settings/plugins/" : "/extensions/plugins/";
  const pluginId = location.pathname.startsWith(prefix)
    ? decodeURIComponent(location.pathname.slice(prefix.length))
    : undefined;
  return (
    <>
      <TooltipProvider>
        {isSettings && pluginId ? (
          <PluginDetailPaneView pluginId={pluginId} />
        ) : (
          <ToolsView pluginId={pluginId} />
        )}
      </TooltipProvider>
      <output data-testid="route-path">{location.pathname}</output>
      <output data-testid="route-search">{location.search}</output>
    </>
  );
}

function HistoryBackButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Browser back</button>;
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PluginDetail official catalog lifecycle", () => {
  it("offers Install from an unowned BB Official plugin detail page", () => {
    const onInstall = vi.fn();
    const { container } = render(
      <CatalogPluginDetail
        entry={GITHUB_CATALOG_ENTRY}
        onInstall={onInstall}
        catalogEntries={[GITHUB_CATALOG_ENTRY]}
        onOpenPlugin={() => undefined}
      />,
    );

    expect(screen.getByRole("heading", { name: "GitHub" })).toBeTruthy();
    expect(screen.getByText("BB Official")).toBeTruthy();
    expect(screen.getByText("Developer tools")).toBeTruthy();
    expect(
      screen.getByText("Browse GitHub issues and pull requests in BB."),
    ).toBeTruthy();
    expect(screen.queryByText("Capabilities")).toBeNull();
    expect(container.querySelector('[data-icon="Github"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Install GitHub" }));
    expect(onInstall).toHaveBeenCalledWith(GITHUB_CATALOG_ENTRY);
  });

  it("links the catalog entry's repository from the metadata line", () => {
    render(
      <CatalogPluginDetail
        entry={{
          ...GITHUB_CATALOG_ENTRY,
          repositoryUrl: "https://github.com/acme/bb-github",
        }}
        onInstall={() => {}}
        catalogEntries={[]}
        onOpenPlugin={() => undefined}
      />,
    );

    const link = screen.getByRole("link", {
      name: /github\.com\/acme\/bb-github/u,
    });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/bb-github");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("loads remote screenshots only in detail and shows the listed date", () => {
    const { container } = render(
      <CatalogPluginDetail
        entry={{
          ...GITHUB_CATALOG_ENTRY,
          screenshots: ["https://images.example/plugin.png"],
          publishedAt: "2026-08-20T00:00:00Z",
        }}
        onInstall={() => undefined}
        catalogEntries={[]}
        onOpenPlugin={() => undefined}
      />,
    );

    const screenshot = screen.getByRole("img", {
      name: "GitHub screenshot 1",
    });
    expect(screenshot.getAttribute("src")).toBe(
      "https://images.example/plugin.png",
    );
    expect(screenshot.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screenshot.getAttribute("loading")).toBe("lazy");
    expect(screen.getByText("Listed")).toBeTruthy();
    expect(container.textContent).not.toContain("Last updated");
  });

  it("explains why an incompatible official plugin cannot be installed", () => {
    const incompatibleEntry = {
      ...GITHUB_CATALOG_ENTRY,
      compatible: false,
      incompatibleReason: "Requires bb 0.20 or newer.",
    };
    render(
      <>
        <CatalogPluginDetailBanner entry={incompatibleEntry} />
        <CatalogPluginDetail
          entry={incompatibleEntry}
          onInstall={() => {}}
          catalogEntries={[incompatibleEntry]}
          onOpenPlugin={() => undefined}
        />
      </>,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    const compatibilityStatus = screen
      .getByText("Update bb to install this plugin")
      .closest("div[class*='bg-surface-recessed']");
    expect(compatibilityStatus).not.toBeNull();
    if (compatibilityStatus === null) return;
    expect(compatibilityStatus.textContent).toContain(
      "Update bb to install this plugin",
    );
    expect(compatibilityStatus.textContent).toContain(
      "Requires bb 0.20 or newer.",
    );
    expect(
      screen
        .getByRole("button", { name: "Install GitHub" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("omits a provenance badge for default direct and local sources", () => {
    const directPlugin: PluginListItem = {
      ...GITHUB_PLUGIN,
      source: "npm:@example/github@^1.0.0",
      provenance: "direct",
      catalogEntryId: null,
      publisherLabel: null,
    };
    const { container, rerender } = render(
      <PluginProvenancePill plugin={directPlugin} />,
    );
    expect(container.textContent).toBe("");

    rerender(
      <PluginProvenancePill
        plugin={{
          ...directPlugin,
          source: "path:/Users/you/Code/github-plugin",
        }}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("keeps catalog provenance and release management in the unified detail taxonomy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    const onDelete = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginDetail
            isLoading={false}
            plugin={GITHUB_PLUGIN}
            pending={false}
            openSourceDisabled
            onToggle={() => {}}
            onEdit={() => {}}
            onOpenSource={() => {}}
            onDelete={onDelete}
            catalogEntry={GITHUB_CATALOG_ENTRY}
            catalogEntries={[GITHUB_CATALOG_ENTRY]}
            onOpenPlugin={() => undefined}
          />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(screen.getAllByText("BB Official").length).toBeGreaterThan(0);
    expect(screen.getByText("Developer tools")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Uninstall GitHub" }),
    ).toBeNull();

    expect(screen.getByText("Release")).toBeTruthy();
    expect(
      screen.getByText("Browse GitHub issues and pull requests in BB."),
    ).toBeTruthy();
    const meta = screen.getByText("0.1.0");
    expect(
      meta
        .closest("[data-resource-detail-section]")
        ?.getAttribute("data-resource-detail-section"),
    ).toBe("release");
    expect(screen.getByText("~/.bb/plugins/github")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Copy plugin path: /Users/you/.bb/plugins/github",
      }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/Users/you/.bb/plugins/github");
    });
    expect(screen.getByText("Updates with bb")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();

    expect(container.querySelector('[data-icon="Github"]')).not.toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "GitHub actions" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Uninstall" }));
    expect(onDelete).toHaveBeenCalledWith(GITHUB_PLUGIN);
  });

  it("keeps update in the Release section without embedding it in the table", () => {
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    const plugin: PluginListItem = {
      ...GITHUB_PLUGIN,
      source: "npm:@example/github@^1.0.0",
      provenance: "direct",
      catalogEntryId: null,
      publisherLabel: null,
      updateState: {
        ...EMPTY_PLUGIN_UPDATE_STATE,
        availableVersion: "1.5.0",
      },
    };
    render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginDetail
            isLoading={false}
            plugin={plugin}
            pending={false}
            openSourceDisabled
            onToggle={() => {}}
            onEdit={() => {}}
            onOpenSource={() => {}}
            onDelete={() => {}}
            catalogEntries={[]}
            onOpenPlugin={() => undefined}
          />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    const version = screen.getByText(GITHUB_PLUGIN.version);
    const update = screen.getByRole("button", {
      name: "Update GitHub to 1.5.0",
    });
    const activation = screen.getByRole("switch", { name: "Disable GitHub" });
    const path = screen.getByText("~/.bb/plugins/github");
    const releaseSection = document.querySelector(
      '[data-resource-detail-section="release"]',
    );

    expect(releaseSection?.contains(version)).toBe(true);
    expect(releaseSection?.contains(update)).toBe(true);
    expect(releaseSection?.contains(activation)).toBe(false);
    expect(releaseSection?.contains(path)).toBe(false);
    expect(version.closest("td")).not.toBe(update.closest("td"));
    expect(update.closest("table")).toBeNull();
    const updateRow = screen
      .getByRole("rowheader", { name: "Update" })
      .closest("tr");
    const updateLabel = screen.getByRole("rowheader", { name: "Update" });
    expect(updateRow).not.toBeNull();
    if (updateRow === null) return;
    const updateDetails = within(updateRow).getByRole("cell");
    expect(updateRow?.textContent).toContain("1.5.0");
    expect(updateRow?.textContent).toContain("Available");
    expect(updateRow?.contains(update)).toBe(false);
    expect(updateLabel.tagName).toBe("TH");
    expect(updateDetails.tagName).toBe("TD");
    expect(updateLabel).not.toBe(updateDetails);
    const versionLabel = screen.getByRole("rowheader", { name: "Version" });
    expect(releaseSection?.contains(versionLabel)).toBe(true);
  });

  it("never describes a managed plugin with an unknown install date as bundled", () => {
    const plugin: PluginListItem = {
      ...GITHUB_PLUGIN,
      source: "npm:@example/github@^1.0.0",
      provenance: "direct",
      catalogEntryId: null,
      publisherLabel: null,
    };
    const { queryClient, wrapper: QueryClientWrapper } =
      createQueryClientTestHarness();
    queryClient.setQueryData(pluginSourceQueryKey(plugin.id), null);

    render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginDetail
            isLoading={false}
            plugin={plugin}
            pending={false}
            openSourceDisabled
            onToggle={() => {}}
            onEdit={() => {}}
            onOpenSource={() => {}}
            onDelete={() => {}}
            catalogEntries={[]}
            onOpenPlugin={() => undefined}
          />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(screen.getByRole("rowheader", { name: "Installed" })).toBeTruthy();
    expect(screen.getByText("Install date unavailable")).toBeTruthy();
    expect(screen.queryByText("Updates with bb")).toBeNull();
  });

  it.each([
    {
      state: "failed",
      updateState: {
        ...EMPTY_PLUGIN_UPDATE_STATE,
        availableVersion: "1.5.0",
        lastFailure: {
          version: "1.5.0",
          at: null,
          detail: "The plugin failed to load.",
        },
      },
      expected: "Update failed",
      actionName: "Retry update to 1.5.0",
    },
    {
      state: "blocked",
      updateState: {
        ...EMPTY_PLUGIN_UPDATE_STATE,
        blockedVersion: "2.0.0",
        blockedReasons: ["Requires bb 0.20 or newer."],
      },
      expected: "Update blocked",
      actionName: null,
    },
  ])(
    "places $state information in the Update row and keeps its action above the table",
    ({ updateState, expected, actionName }) => {
      const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
      render(
        <MemoryRouter>
          <QueryClientWrapper>
            <PluginDetail
              isLoading={false}
              plugin={{
                ...GITHUB_PLUGIN,
                source: "npm:@example/github@^1.0.0",
                provenance: "direct",
                catalogEntryId: null,
                publisherLabel: null,
                updateState,
              }}
              pending={false}
              openSourceDisabled
              onToggle={() => {}}
              onEdit={() => {}}
              onOpenSource={() => {}}
              onDelete={() => {}}
              catalogEntries={[]}
              onOpenPlugin={() => undefined}
            />
          </QueryClientWrapper>
        </MemoryRouter>,
      );

      const updateLabel = screen.getByRole("rowheader", { name: "Update" });
      const updateRow = updateLabel.closest("tr");
      const status = screen.getByRole("status", { name: expected });
      expect(updateRow?.contains(status)).toBe(true);
      expect(screen.queryByText(expected)).toBeNull();
      expect(
        screen.getByRole("rowheader", { name: "Version" }).closest("tr"),
      ).not.toBe(updateRow);
      const action =
        actionName === null
          ? null
          : screen.getByRole("button", { name: actionName });
      expect(action?.closest("table") ?? null).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("uses a plugin-owned canonical icon when no rich logo is declared", () => {
    const compactIconUrl = "/api/v1/plugins/omega/assets/icon?h=abc";
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    const { container } = render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginDetail
            isLoading={false}
            plugin={{
              ...GITHUB_PLUGIN,
              id: "omega",
              name: "Omegacode",
              icon: null,
              compactIconUrl,
              source: "path:/plugins/omega",
              provenance: "direct",
              catalogEntryId: null,
              publisherLabel: null,
            }}
            pending={false}
            openSourceDisabled
            onToggle={() => {}}
            onEdit={() => {}}
            onOpenSource={() => {}}
            onDelete={() => {}}
            catalogEntries={[]}
            onOpenPlugin={() => undefined}
          />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    const icon = container.querySelector(
      `[data-plugin-icon-asset="${compactIconUrl}"]`,
    );
    expect(icon).not.toBeNull();
  });

  it("shows a disabled Uninstall action for a built-in plugin", async () => {
    const onDelete = vi.fn();
    const builtinPlugin = {
      ...GITHUB_PLUGIN,
      id: "automations",
      name: "Automations",
      source: "builtin:automations",
      provenance: "builtin" as const,
      catalogEntryId: null,
      publisherKey: "bb-official",
      publisherLabel: "BB Official",
    };
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginDetail
            isLoading={false}
            plugin={builtinPlugin}
            pending={false}
            openSourceDisabled
            onToggle={() => {}}
            onEdit={() => {}}
            onOpenSource={() => {}}
            onDelete={onDelete}
            catalogEntries={[]}
            onOpenPlugin={() => undefined}
          />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(screen.getByText("BB Official")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Disable Automations" }),
    ).toBeTruthy();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Automations actions" }),
    );
    const uninstall = await screen.findByRole("menuitem", {
      name: "Uninstall",
    });
    expect(uninstall.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(uninstall);
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.pointerMove(uninstall);
    expect(
      await screen.findAllByText(
        "Included with BB; disable this plugin instead.",
      ),
    ).not.toHaveLength(0);
  });
});

describe("BB Official plugin detail routing", () => {
  it("resolves an uninstalled catalog plugin and opens its install confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/plugins") {
          return new Response(JSON.stringify({ enabled: true, plugins: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "/api/v1/plugin-catalog/search?q=") {
          return new Response(
            JSON.stringify({
              results: [GITHUB_CATALOG_ENTRY],
              collections: [],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/extensions/plugins/github"]}>
        <Routes>
          <Route
            path="/extensions/plugins/:pluginId"
            element={
              <TooltipProvider>
                <ToolsView pluginId="github" />
              </TooltipProvider>
            }
          />
        </Routes>
      </MemoryRouter>,
      { wrapper: QueryClientWrapper },
    );

    expect(await screen.findByRole("heading", { name: "GitHub" })).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Install GitHub" }).at(-1)!,
    );
    expect(
      await screen.findByRole("heading", { name: "Install GitHub?" }),
    ).toBeTruthy();
    expect(screen.getByTestId("full-trust-warning")).toBeTruthy();
  });

  it("opens one detail tab beside Browse and restores card focus", async () => {
    const catalogEntry = {
      ...GITHUB_CATALOG_ENTRY,
      categoryId: "code-and-reviews",
      category: "Code & Reviews",
      author: {
        name: "BB",
        github: "get-bb",
        url: "https://github.com/get-bb",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/v1/plugins") {
          return new Response(JSON.stringify({ enabled: true, plugins: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("/api/v1/plugin-catalog/search")) {
          return new Response(
            JSON.stringify({ results: [catalogEntry], collections: [] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/extensions/plugins"]}>
        <Routes>
          <Route path="/extensions/plugins/*" element={<RoutedToolsView />} />
        </Routes>
        <HistoryBackButton />
      </MemoryRouter>,
      { wrapper: QueryClientWrapper },
    );

    const card = await screen.findByRole("button", {
      name: "Open GitHub details",
    });
    const panels = Array.from(document.querySelectorAll("[data-panel]"));
    expect(panels).toHaveLength(2);
    expect(panels[0]?.getAttribute("data-panel-size")).toBe("100.0");
    expect(panels[1]?.getAttribute("data-panel-size")).toBe("0.0");
    const search = screen.getByRole("textbox", { name: "Search plugins" });
    card.focus();
    fireEvent.click(card);
    expect(
      await screen.findByRole("button", { name: "Close GitHub" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Search plugins" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Close /u })).toHaveLength(1);
    expect(Array.from(document.querySelectorAll("[data-panel]"))).toEqual(
      panels,
    );
    expect(screen.getByRole("textbox", { name: "Search plugins" })).toBe(
      search,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close GitHub" }));
    await waitFor(() => {
      expect(screen.getByTestId("route-path").textContent).toBe(
        "/extensions/plugins",
      );
      expect(document.activeElement).toBe(card);
    });
    expect(Array.from(document.querySelectorAll("[data-panel]"))).toEqual(
      panels,
    );
    expect(panels[0]?.getAttribute("data-panel-size")).toBe("100.0");
    expect(panels[1]?.getAttribute("data-panel-size")).toBe("0.0");
    expect(screen.getByRole("textbox", { name: "Search plugins" })).toBe(
      search,
    );

    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    await waitFor(() => {
      expect(screen.getByTestId("route-path").textContent).toBe(
        "/extensions/plugins/github",
      );
    });
  });

  it.each([
    "/extensions/plugins/github?view=installed",
    "/extensions/plugins?view=installed",
  ])("opens installed plugin settings from %s", async (path) => {
    const author = {
      name: "BB",
      github: "get-bb",
      url: "https://github.com/get-bb",
    };
    const catalogEntries = [
      { ...GITHUB_CATALOG_ENTRY, author, installed: true },
      {
        ...GITHUB_CATALOG_ENTRY,
        entryId: "automations",
        pluginId: "automations",
        displayName: "Automations",
        author,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/v1/plugins") {
          return new Response(
            JSON.stringify({
              enabled: true,
              plugins: [
                {
                  ...GITHUB_PLUGIN,
                  iconUrl: null,
                  screenshots: [],
                  collections: [],
                  providerIds: [],
                  icons: {},
                  updateState: {},
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (url.startsWith("/api/v1/plugin-catalog/search")) {
          return new Response(
            JSON.stringify({ results: catalogEntries, collections: [] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/extensions/plugins/*" element={<RoutedToolsView />} />
          <Route path="/settings/plugins/*" element={<RoutedToolsView />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: QueryClientWrapper },
    );

    if (path === "/extensions/plugins?view=installed") {
      expect(
        await screen.findByRole("textbox", {
          name: "Search installed plugins",
        }),
      ).toBeTruthy();
      expect(screen.getByTestId("route-path").textContent).toBe(
        "/extensions/plugins",
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "GitHub plugin details" }),
      );
    }

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open Automations details",
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("route-path").textContent).toBe(
        "/settings/plugins/automations",
      );
    });
    expect(screen.getByTestId("route-search").textContent).toBe(
      "?view=installed",
    );
    expect(
      screen.queryByRole("button", { name: "Close Automations" }),
    ).toBeNull();
  });

  it("opens an author from a card and returns to the prior Browse filters", async () => {
    const author = {
      name: "BB",
      github: "get-bb",
      url: "https://github.com/get-bb",
    };
    const catalogEntries = [
      {
        ...GITHUB_CATALOG_ENTRY,
        categoryId: "code-and-reviews",
        category: "Code & Reviews",
        author,
      },
      {
        ...GITHUB_CATALOG_ENTRY,
        entryId: "automations",
        pluginId: "automations",
        displayName: "Automations",
        categoryId: "tasks-and-workflows",
        category: "Tasks & Workflows",
        author,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/v1/plugins") {
          return new Response(JSON.stringify({ enabled: true, plugins: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("/api/v1/plugin-catalog/search")) {
          return new Response(
            JSON.stringify({ results: catalogEntries, collections: [] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter
        initialEntries={[
          "/extensions/plugins?category=code-and-reviews&sort=recently-added",
        ]}
      >
        <Routes>
          <Route path="/extensions/plugins/*" element={<RoutedToolsView />} />
        </Routes>
        <HistoryBackButton />
      </MemoryRouter>,
      { wrapper: QueryClientWrapper },
    );

    fireEvent.click((await screen.findAllByRole("link", { name: "BB" }))[0]!);
    expect(await screen.findByRole("heading", { name: /^BB/u })).toBeTruthy();
    let params = new URLSearchParams(
      screen.getByTestId("route-search").textContent ?? "",
    );
    expect(params.get("author")).toBe("11:bb-official:github:get-bb");
    expect(params.getAll("category")).toEqual(["code-and-reviews"]);
    expect(params.get("sort")).toBe("recently-added");

    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /^BB/u })).toBeNull();
    });
    params = new URLSearchParams(
      screen.getByTestId("route-search").textContent ?? "",
    );
    expect(params.has("author")).toBe(false);
    expect(params.getAll("category")).toEqual(["code-and-reviews"]);
    expect(params.get("sort")).toBe("recently-added");

    fireEvent.click((await screen.findAllByRole("link", { name: "BB" }))[0]!);
    const card = await screen.findByRole("button", {
      name: "Open GitHub details",
    });
    card.focus();
    fireEvent.click(card);
    expect(
      await screen.findByRole("heading", { name: "More from this author" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close GitHub" }));
    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it("routes the detail author link to the restored author page", async () => {
    const author = {
      name: "BB",
      github: "get-bb",
      url: "https://github.com/get-bb",
    };
    const catalogEntries = [
      { ...GITHUB_CATALOG_ENTRY, author },
      {
        ...GITHUB_CATALOG_ENTRY,
        entryId: "automations",
        pluginId: "automations",
        displayName: "Automations",
        author,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/v1/plugins") {
          return new Response(JSON.stringify({ enabled: true, plugins: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("/api/v1/plugin-catalog/search")) {
          return new Response(
            JSON.stringify({ results: catalogEntries, collections: [] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/extensions/plugins/github"]}>
        <Routes>
          <Route path="/extensions/plugins/*" element={<RoutedToolsView />} />
        </Routes>
      </MemoryRouter>,
      { wrapper: QueryClientWrapper },
    );

    expect(
      await screen.findByRole("heading", { name: "More from this author" }),
    ).toBeTruthy();
    const authorLinks = screen.getAllByRole("link", { name: "BB" });
    fireEvent.click(authorLinks.at(-1)!);
    await waitFor(() => {
      expect(screen.getByTestId("route-path").textContent).toBe(
        "/extensions/plugins",
      );
    });
    expect(await screen.findByRole("heading", { name: /^BB/u })).toBeTruthy();
    expect(
      new URLSearchParams(
        screen.getByTestId("route-search").textContent ?? "",
      ).get("author"),
    ).toBe("11:bb-official:github:get-bb");
  });
});

describe("plugin removal confirmation", () => {
  it("warns that removing a local plugin deletes its settings, secrets, and schedules and names the move path", async () => {
    const localPlugin = {
      id: "github",
      source: "path:/Users/you/src/bb-plugin-github",
      rootDir: "/Users/you/src/bb-plugin-github",
      version: "0.1.0",
      provenance: "direct",
      isOrphanedBuiltin: false,
      publisherLabel: null,
      sourceDisplay: "path · /Users/you/src/bb-plugin-github",
      updateState: {},
      enabled: true,
      description: "Browse GitHub issues and pull requests in BB.",
      name: "GitHub",
      icon: "Github",
      iconUrl: null,
      status: "running",
      statusDetail: null,
      handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
      services: [],
      schedules: [],
      cliCommand: null,
      capabilities: [],
      hasSettings: false,
      app: { hasApp: false, bundle: null },
      logoUrl: null,
      logoDarkUrl: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/v1/plugins") {
          return new Response(
            JSON.stringify({ enabled: true, plugins: [localPlugin] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter initialEntries={["/extensions/plugins/github"]}>
        <Routes>
          <Route
            path="/extensions/plugins/:pluginId"
            element={
              <TooltipProvider>
                <ToolsView pluginId="github" />
              </TooltipProvider>
            }
          />
        </Routes>
      </MemoryRouter>,
      { wrapper: QueryClientWrapper },
    );

    expect(await screen.findByRole("heading", { name: "GitHub" })).toBeTruthy();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "GitHub actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from bb" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Remove plugin from bb?" }),
    ).toBeTruthy();
    const description = screen.getByText(/Remove "github" from bb/);
    expect(description.textContent).toContain(
      "delete its settings, secrets, and schedules",
    );
    expect(description.textContent).toContain("source files stay on disk");
    expect(description.textContent).toContain("install the new path instead");
  });
});

describe("PluginDetail banner precedence", () => {
  const managedPlugin: PluginListItem = {
    ...GITHUB_PLUGIN,
    source: "npm:@example/github@^1.0.0",
    provenance: "direct",
    catalogEntryId: null,
    publisherLabel: null,
  };
  const collision: PluginListItem = {
    ...managedPlugin,
    status: "degraded",
    statusDetail: "service issue-sync did not stop",
    handlerStats: {
      ...managedPlugin.handlerStats,
      errorCount: 3,
    },
    updateState: {
      ...EMPTY_PLUGIN_UPDATE_STATE,
      availableVersion: "1.5.0",
      blockedVersion: "2.0.0",
      blockedReasons: ["Requires a newer bb."],
      lastFailure: {
        version: "1.4.5",
        at: null,
        detail: "The plugin failed to load after the update.",
      },
    },
  };

  it("renders only current health and keeps diagnostics out of user copy", () => {
    const { wrapper } = createQueryClientTestHarness();
    render(<PluginDetailBanners plugin={collision} />, { wrapper });

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Degraded");
    expect(alerts[0]?.textContent).toContain(
      "A background service is still stopping.",
    );
    expect(alerts[0]?.textContent).toContain(
      "Wait a moment, then reload the plugin.",
    );
    expect(alerts[0]?.textContent).not.toContain("issue-sync");
    expect(alerts[0]?.textContent).not.toContain("handler");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("does not promote cumulative handler diagnostics into a page banner", () => {
    const { wrapper } = createQueryClientTestHarness();
    render(
      <PluginDetailBanners
        plugin={{
          ...managedPlugin,
          handlerStats: { ...managedPlugin.handlerStats, errorCount: 3 },
        }}
      />,
      { wrapper },
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("does not treat a cleanup failure from an active frontend as a startup failure", () => {
    const activeWithCleanupFailure = {
      pluginId: "github",
      status: "active",
      active: { generation: 2, hash: "v2", contentScriptIds: ["sync"] },
      lastFailure: {
        phase: "dispose",
        message: "old generation cleanup failed",
        scriptId: "sync",
      },
    } satisfies PluginFrontendDiagnostic;
    const failedToLoad = {
      pluginId: "github",
      status: "failed",
      active: null,
      lastFailure: {
        phase: "load",
        message: "bundle import failed",
        scriptId: null,
      },
    } satisfies PluginFrontendDiagnostic;

    expect(
      pluginFrontendDiagnosticRequiresFailureBanner(activeWithCleanupFailure),
    ).toBe(false);
    expect(pluginFrontendDiagnosticRequiresFailureBanner(failedToLoad)).toBe(
      true,
    );
  });
});

describe("PluginDetail runtime health", () => {
  function renderRuntimeStatus(
    status: Extract<
      PluginListItem["status"],
      "error" | "incompatible" | "missing" | "needs-configuration" | "degraded"
    >,
    overrides: Partial<PluginListItem> = {},
  ) {
    const { queryClient, wrapper: QueryClientWrapper } =
      createQueryClientTestHarness();
    const plugin = {
      ...GITHUB_PLUGIN,
      source: "builtin:github",
      provenance: "builtin" as const,
      catalogEntryId: null,
      publisherKey: "bb-official",
      publisherLabel: "BB Official",
      status,
      statusDetail: "The runtime reported a problem.",
      ...overrides,
    };
    const result = render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginDetailBanners plugin={plugin} />
          <PluginDetail
            isLoading={false}
            plugin={plugin}
            pending={false}
            openSourceDisabled
            onToggle={() => {}}
            onEdit={() => {}}
            onOpenSource={() => {}}
            onDelete={() => {}}
            catalogEntries={[]}
            onOpenPlugin={() => undefined}
          />
        </QueryClientWrapper>
      </MemoryRouter>,
    );
    return { ...result, queryClient };
  }

  it("lifts a failed runtime status into a destructive alert above the content", () => {
    const { container } = renderRuntimeStatus("error");
    const alert = screen.getByRole("alert");

    expect(alert.textContent).toContain("Failed");
    expect(alert.textContent).toContain("The plugin couldn't start.");
    expect(alert.textContent).not.toContain("runtime reported");
    expect(alert.textContent).toContain("Reload the plugin.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();

    const about = container.querySelector(
      '[data-resource-detail-section="overview"]',
    ) as HTMLElement;
    expect(
      alert.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("offers Reload for degraded runtime status without a bottom rule", () => {
    renderRuntimeStatus("degraded", {
      statusDetail: "service issue-sync did not stop",
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "A background service is still stopping.",
    );
    expect(alert.textContent).toContain(
      "Wait a moment, then reload the plugin.",
    );
    expect(alert.textContent).not.toContain("issue-sync");
    expect(alert.textContent).not.toContain("Restart bb");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("does not fold cumulative handler diagnostics into the runtime banner", () => {
    renderRuntimeStatus("degraded", {
      handlerStats: {
        ...GITHUB_PLUGIN.handlerStats,
        errorCount: 3,
      },
    });

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Degraded");
    expect(alerts[0]?.textContent).not.toContain("handler");
  });

  it.each(["incompatible", "missing"] as const)(
    "does not offer Reload for %s runtime status",
    (status) => {
      renderRuntimeStatus(status);

      expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    },
  );

  it.each([
    [
      "incompatible",
      "This plugin version isn't compatible with your version of bb.",
      "Update bb to load a compatible bundled plugin.",
    ],
    [
      "missing",
      "The plugin's files are missing.",
      "Restart bb. If the files are still missing, reinstall bb.",
    ],
  ] as const)(
    "explains the %s condition and a supported recovery",
    (status, condition, recovery) => {
      renderRuntimeStatus(status);

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(condition);
      expect(alert.textContent).toContain(recovery);
      expect(alert.textContent).not.toContain("runtime reported");
    },
  );

  it("keeps needs-configuration actionless because saving Settings retries it", () => {
    renderRuntimeStatus("needs-configuration", {
      statusDetail: "An API token is required.",
      hasSettings: true,
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("An API token is required.");
    expect(alert.textContent).toContain(
      "Complete the Configuration section; bb reloads the plugin after you save.",
    );
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("offers Reload when required configuration lives outside Settings", () => {
    renderRuntimeStatus("needs-configuration", {
      statusDetail: "Set GITHUB_TOKEN in the server environment.",
      hasSettings: false,
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "Set GITHUB_TOKEN in the server environment.",
    );
    expect(alert.textContent).toContain(
      "Add the required configuration, then reload the plugin.",
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("reloads the affected plugin and reflects its pending state", async () => {
    let resolveReload: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveReload = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient } = renderRuntimeStatus("error");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/plugins/reload?id=github",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const pending = screen.getByRole("button", { name: "Reloading…" });
    expect(pending.getAttribute("disabled")).not.toBeNull();

    resolveReload?.(
      new Response(JSON.stringify({ ok: true, plugins: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["plugin-list"] });
    });
  });
});

describe("PluginDetail capability inventory", () => {
  it("lists each contributed capability and keeps health separate", async () => {
    const EmptySlot = () => null;
    setPluginSlotRegistrations(
      "capability-demo",
      makePluginRegistrationSet({
        settingsSections: [
          {
            id: "preferences",
            title: "Advanced preferences",
            component: EmptySlot,
          },
        ],
        navPanels: [
          {
            id: "run-monitor",
            title: "Run monitor",
            icon: "Workflow",
            path: "runs",
            component: EmptySlot,
          },
        ],
        threadPanelActions: [],
        composerCustomizations: [
          {
            id: "prompt-tools",
            actions: [{ id: "enhance-prompt", component: EmptySlot }],
          },
        ],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
        messageDirectives: [],
      }),
    );

    const plugin = {
      ...GITHUB_PLUGIN,
      id: "capability-demo",
      name: "Capability demo",
      source: "path:/plugins/capability-demo",
      provenance: "direct" as const,
      catalogEntryId: null,
      publisherLabel: null,
      sourceDisplay: "Local path",
      hasSettings: true,
      cliCommand: {
        name: "capability",
        summary: "Inspect contributed capabilities.",
      },
      capabilities: [
        {
          kind: "skill",
          id: "review",
          label: "review",
          detail: "Review repository changes.",
        },
        {
          kind: "agent-tool",
          id: "fetch_issues",
          label: "fetch_issues",
          detail: "Fetches repository issues.",
        },
        {
          kind: "thread-integration",
          id: "pull-request-mentions",
          label: "Pull request mentions",
          detail: "Displays pull request references.",
        },
        {
          kind: "theme",
          id: "github.dark",
          label: "GitHub Dark",
          detail: "A dark GitHub-inspired theme.",
        },
      ],
      services: [
        { name: "watch", state: "running" as const },
        { name: "restart", state: "backoff" as const },
        { name: "sync", state: "stopped" as const },
      ],
      schedules: [
        {
          name: "daily-cleanup",
          cron: "0 9 * * *",
          nextRunAt: 1_800_000_000_000,
          lastRunAt: null,
          lastStatus: null,
          lastError: null,
        },
        {
          name: "in-progress",
          cron: "0 10 * * *",
          nextRunAt: 1_800_000_000_000,
          lastRunAt: null,
          lastStatus: "running" as const,
          lastError: null,
        },
        {
          name: "completed",
          cron: "0 11 * * *",
          nextRunAt: 1_800_000_000_000,
          lastRunAt: null,
          lastStatus: "ok" as const,
          lastError: null,
        },
        {
          name: "failed",
          cron: "0 12 * * *",
          nextRunAt: 1_800_000_000_000,
          lastRunAt: null,
          lastStatus: "error" as const,
          lastError: "Timed out",
        },
      ],
    } satisfies PluginListItem;
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    const { container } = render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginDetail
            isLoading={false}
            plugin={plugin}
            pending={false}
            openSourceDisabled
            onToggle={() => {}}
            onEdit={() => {}}
            onOpenSource={() => {}}
            onDelete={() => {}}
            catalogEntries={[]}
            onOpenPlugin={() => undefined}
          />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    const includes = container.querySelector(
      '[data-resource-detail-section="includes"]',
    );
    expect(includes).not.toBeNull();
    const inventory = within(includes as HTMLElement);
    const table = includes?.querySelector("table");
    expect(table).not.toBeNull();

    expect(
      includes?.querySelector("[data-plugin-capability-group]"),
    ).toBeNull();
    for (const text of [
      "Run monitor",
      "Adds a page to the app sidebar.",
      "enhance-prompt",
      "Adds an action beside the thread composer.",
      "bb capability",
      "Inspect contributed capabilities.",
      "review",
      "Review repository changes.",
      "fetch_issues",
      "Fetches repository issues.",
      "Pull request mentions",
      "Displays pull request references.",
      "GitHub Dark",
      "A dark GitHub-inspired theme.",
    ]) {
      expect(inventory.getByText(text)).toBeTruthy();
    }
    expect(inventory.queryByText("Advanced preferences")).toBeNull();
    expect(inventory.queryByText("API token")).toBeNull();
    expect(inventory.queryByText("watch")).toBeNull();
    expect(inventory.queryByText("daily-cleanup")).toBeNull();
    expect(includes?.textContent).not.toContain("2 background services");

    const commandGlyph = inventory.getByRole("img", { name: "Command" });
    fireEvent.pointerMove(commandGlyph);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Command");

    const [services, schedules] = Array.from(
      container.querySelectorAll('[data-resource-detail-section="activity"]'),
    ) as HTMLElement[];
    expect(schedules).toBeTruthy();
    expect(container.textContent).not.toContain("Health");

    const serviceSection = within(services as HTMLElement);
    const serviceTable = serviceSection.getByRole("table", {
      name: "Background services",
    });
    const serviceTableQueries = within(serviceTable);
    expect(
      serviceTableQueries
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Status", "Service"]);
    for (const name of ["watch", "restart", "sync"]) {
      expect(serviceTableQueries.getByRole("rowheader", { name })).toBeTruthy();
    }
    expect(serviceTableQueries.queryByText("daily-cleanup")).toBeNull();
    for (const label of ["Running", "Restarting", "Stopped"]) {
      expect(serviceTableQueries.getByText(label)).toBeTruthy();
    }
    expect(
      serviceTableQueries.getByText("Running").getAttribute("class"),
    ).toContain("animate-shine");
    expect(
      serviceTableQueries.getByText("Restarting").getAttribute("class"),
    ).toContain("animate-shine");
    const scheduleTable = within(schedules as HTMLElement);
    expect(scheduleTable.getByText("Scheduled jobs")).toBeTruthy();
    expect(scheduleTable.getByText("daily-cleanup")).toBeTruthy();
    expect(scheduleTable.getByText("in-progress")).toBeTruthy();
    expect(scheduleTable.getByText("completed")).toBeTruthy();
    expect(scheduleTable.getByText("failed")).toBeTruthy();
    expect(scheduleTable.queryByText("watch")).toBeNull();

    for (const [label, icon] of [
      ["Scheduled", "Clock"],
      ["Running", "Clock"],
      ["Succeeded", "CircleCheck"],
      ["Failed", "CircleX"],
    ] as const) {
      const status = scheduleTable
        .getAllByRole("img", { name: label })
        .find(
          (element) => element.querySelector(`[data-icon="${icon}"]`) !== null,
        );
      expect(status, `${label} should use ${icon}`).toBeTruthy();
      expect(status?.getAttribute("tabindex")).toBe("0");
    }
    expect(
      scheduleTable
        .getAllByRole("img", { name: "Running" })
        .some((element) =>
          element
            .querySelector('[data-icon="Clock"]')
            ?.getAttribute("class")
            ?.includes("animate-shine-icon"),
        ),
    ).toBe(true);
  });

  it("names repeated product-titled surfaces by their actual capability", () => {
    const EmptySlot = () => null;
    setPluginSlotRegistrations(
      "simple-notes",
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "docs",
            title: "Docs",
            icon: "FileText",
            path: "docs",
            component: EmptySlot,
          },
        ],
        threadPanelActions: [
          {
            id: "document",
            title: "Document",
            icon: "FileText",
            component: EmptySlot,
          },
        ],
        composerCustomizations: [],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [
          {
            id: "docs",
            title: "Markdown",
            extensions: ["md", "mdx", "markdown"],
            component: EmptySlot,
          },
        ],
        messageDirectives: [{ id: "docs", component: EmptySlot }],
      }),
    );
    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginDetail
            isLoading={false}
            plugin={{
              ...GITHUB_PLUGIN,
              id: "simple-notes",
              name: "Docs",
              capabilities: [],
            }}
            pending={false}
            openSourceDisabled
            onToggle={() => {}}
            onEdit={() => {}}
            onOpenSource={() => {}}
            onDelete={() => {}}
            catalogEntries={[]}
            onOpenPlugin={() => undefined}
          />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(screen.getAllByText("Docs")).toHaveLength(2);
    for (const label of ["Document", "Markdown", "::docs"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});
