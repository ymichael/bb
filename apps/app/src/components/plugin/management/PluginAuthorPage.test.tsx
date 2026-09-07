// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { PluginAuthorPage } from "./PluginAuthorPage";

function catalogEntry(
  pluginId: string,
  overrides: Partial<PluginCatalogSearchEntry> = {},
): PluginCatalogSearchEntry {
  return {
    entryId: pluginId,
    pluginId,
    displayName: pluginId,
    description: `${pluginId} description`,
    icon: "Zap",
    iconUrl: null,
    iconTinted: false,
    categoryId: "thread-content",
    category: "Thread Content",
    screenshots: [],
    collections: [],
    publishedAt: "2026-08-01T00:00:00Z",
    source: `npm:${pluginId}`,
    repositoryUrl: null,
    marketplace: "bb-community",
    marketplaceDisplayName: "BB Community",
    publisherKey: "bb-community",
    publisherLabel: "BB Community",
    official: true,
    author: {
      name: "Pat Lee",
      github: "patlee",
      url: "https://github.com/patlee",
    },
    installed: false,
    installs: 10,
    compatible: true,
    incompatibleReason: null,
    ...overrides,
  };
}

function catalogEntryForAuthor(pluginId: string, name: string) {
  return catalogEntry(pluginId, {
    author: {
      name,
      github: "patlee",
      url: "https://github.com/patlee",
    },
  });
}

const ALPHA = catalogEntry("Alpha", { installs: null });
const BETA = catalogEntry("Beta", {
  author: {
    name: "Patricia Lee",
    github: "PatLee",
    url: "https://github.com/PatLee",
  },
  categoryId: "security",
  category: "Security",
  publishedAt: "2026-08-20T00:00:00Z",
  installs: 50,
});
const GAMMA = catalogEntry("Gamma", {
  publishedAt: undefined,
  installs: 100,
});
const OTHER = catalogEntry("Other", {
  author: { name: "Pat Lee", github: null, url: null },
});

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

function cardOrder(): string[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Open "][aria-label$=" details"]',
    ),
  ].map((button) => button.getAttribute("aria-label") ?? "");
}

function renderPage(
  initialEntry: string,
  onOpenPlugin = vi.fn(),
  catalogEntries: readonly PluginCatalogSearchEntry[] = [
    GAMMA,
    OTHER,
    BETA,
    ALPHA,
  ],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const query = new URL(requestUrl, "http://localhost").searchParams.get(
        "q",
      );
      const results =
        query === "Beta" || query === "agent-interaction"
          ? [BETA]
          : catalogEntries;
      return new Response(
        JSON.stringify({
          results,
          collections: [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  const { wrapper } = createQueryClientTestHarness();
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PluginAuthorPage
        authorKey="12:bb-community:github:patlee"
        onInstall={() => undefined}
        onOpenPlugin={onOpenPlugin}
      />
      <LocationProbe />
    </MemoryRouter>,
    { wrapper },
  );
  return onOpenPlugin;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PluginAuthorPage", () => {
  it("aligns the author header with the toolbar and card grid", async () => {
    renderPage(
      "/extensions/plugins?author=12%3Abb-community%3Agithub%3Apatlee",
    );

    await screen.findByRole("heading", { name: /^Pat Lee/u });
    const headerContainer = screen
      .getByRole("link", { name: "Browse plugins" })
      .closest(".max-w-3xl");
    const toolbarContainer = screen
      .getByRole("textbox", { name: "Search plugins" })
      .closest(".max-w-3xl");
    const gridContainer = screen
      .getByRole("button", { name: "Open Alpha details" })
      .closest(".max-w-3xl");
    for (const container of [
      headerContainer,
      toolbarContainer,
      gridContainer,
    ]) {
      expect(container?.classList.contains("mx-auto")).toBe(true);
      expect(container?.classList.contains("w-full")).toBe(true);
    }
  });

  it.each([
    {
      rule: "frequency before length",
      entries: [
        catalogEntryForAuthor("Long", "Divyesh Puri"),
        catalogEntryForAuthor("Short One", "Divyesh"),
        catalogEntryForAuthor("Short Two", "Divyesh"),
      ],
      expected: "Divyesh",
    },
    {
      rule: "length for equal counts",
      entries: [
        catalogEntryForAuthor("Short", "Divyesh"),
        catalogEntryForAuthor("Long", "Divyesh Puri"),
      ],
      expected: "Divyesh Puri",
    },
  ])("selects an author name by $rule", async ({ entries, expected }) => {
    renderPage(
      "/extensions/plugins?author=12%3Abb-community%3Agithub%3Apatlee",
      vi.fn(),
      entries,
    );

    const heading = await screen.findByRole("heading");
    expect(heading.firstElementChild?.textContent).toBe(expected);
  });

  it("restores the URL and shows only the selected author's plugins", async () => {
    renderPage(
      "/extensions/plugins?author=12%3Abb-community%3Agithub%3Apatlee&sort=recently-added&direction=asc",
    );

    expect(
      await screen.findByRole("heading", { name: /^Pat Lee/u }),
    ).toBeTruthy();
    expect(screen.getByText("3 plugins")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /github\.com\/patlee/u })
        .getAttribute("href"),
    ).toBe("https://github.com/patlee");
    expect(cardOrder()).toEqual([
      "Open Alpha details",
      "Open Beta details",
      "Open Gamma details",
    ]);
    expect(screen.queryByText("Other")).toBeNull();
    expect(screen.getByTestId("location").textContent).toContain(
      "author=12%3Abb-community%3Agithub%3Apatlee",
    );
  });

  it("applies search, multiple categories, and both optional-value sorts", async () => {
    const onOpenPlugin = renderPage(
      "/extensions/plugins?author=12%3Abb-community%3Agithub%3Apatlee&sort=most-installed",
    );

    await screen.findByRole("heading", { name: /^Pat Lee/u });
    expect(cardOrder()).toEqual([
      "Open Gamma details",
      "Open Beta details",
      "Open Alpha details",
    ]);
    const sort = screen.getByRole("button", {
      name: "Sort: Most installed, descending",
    });
    fireEvent.pointerDown(sort);
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Most installed" }),
    );
    expect(cardOrder()).toEqual([
      "Open Beta details",
      "Open Gamma details",
      "Open Alpha details",
    ]);
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Filter plugins by category: All categories",
      }),
    );
    fireEvent.click(screen.getByRole("option", { name: /Thread Content/u }));
    expect(cardOrder()).toEqual(["Open Gamma details", "Open Alpha details"]);
    fireEvent.click(screen.getByRole("option", { name: /Security/u }));
    expect(cardOrder()).toEqual([
      "Open Beta details",
      "Open Gamma details",
      "Open Alpha details",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
      target: { value: "Beta" },
    });
    await waitFor(() => expect(cardOrder()).toEqual(["Open Beta details"]));
    const beta = screen.getByRole("button", { name: "Open Beta details" });
    fireEvent.click(beta);
    expect(onOpenPlugin).toHaveBeenCalledWith("Beta", beta);
    expect(screen.getByTestId("location").textContent).toContain("query=Beta");
  });

  it("uses the catalog search result for a tag-only query", async () => {
    renderPage(
      "/extensions/plugins?author=12%3Abb-community%3Agithub%3Apatlee&query=agent-interaction",
    );

    expect(
      await screen.findByRole("heading", { name: /^Pat Lee/u }),
    ).toBeTruthy();
    expect(screen.getByText("3 plugins")).toBeTruthy();
    await waitFor(() => expect(cardOrder()).toEqual(["Open Beta details"]));
  });
});
