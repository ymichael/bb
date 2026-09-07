import { describe, expect, it } from "vitest";
import {
  applyPluginUpdate,
  checkPluginUpdates,
  installCatalogPlugin,
  installPlugin,
  searchPluginCatalog,
} from "./plugin-catalog-queries";

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function recordingFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = fetchReturning(body, status);
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return impl(input, init);
  };
  return { fetchImpl, calls };
}

const UPDATES_RESULTS = [
  {
    id: "current-plugin",
    outcome: "current",
    installed: { version: "1.0.0", display: "1.0.0" },
  },
  {
    id: "updatable-plugin",
    outcome: "update-available",
    installed: { version: "1.6.2", display: "1.6.2" },
    candidate: { version: "1.7.0", display: "1.7.0" },
  },
  {
    id: "blocked-plugin",
    outcome: "incompatible",
    devMode: true,
    installed: { version: "1.8.3", display: "1.8.3" },
    blocked: { version: "1.9.0", reasons: ["requires bb >= 0.15"] },
  },
];

describe("checkPluginUpdates", () => {
  it("returns the checked entries across outcome kinds", async () => {
    const entries = await checkPluginUpdates(
      fetchReturning({ results: UPDATES_RESULTS }),
      { id: "updatable-plugin" },
    );
    expect(entries.map((entry) => entry.outcome)).toEqual([
      "current",
      "update-available",
      "incompatible",
    ]);
    expect(entries[1]?.candidate?.version).toBe("1.7.0");
    expect(entries[2]?.blocked?.reasons).toEqual(["requires bb >= 0.15"]);
  });

  it("throws on a malformed 2xx body", async () => {
    await expect(
      checkPluginUpdates(fetchReturning({ checked: true })),
    ).rejects.toThrow();
  });
});

describe("applyPluginUpdate", () => {
  it("POSTs an empty body and parses the apply result", async () => {
    const { fetchImpl, calls } = recordingFetch({
      applied: true,
      from: { version: "1.6.2", display: "1.6.2" },
      to: { version: "1.7.0", display: "1.7.0" },
      outcome: "updated",
    });
    const result = await applyPluginUpdate(fetchImpl, "linear");
    expect(result).toEqual({
      applied: true,
      outcome: "updated",
      from: { version: "1.6.2", display: "1.6.2" },
      to: { version: "1.7.0", display: "1.7.0" },
      detail: null,
    });
    expect(calls[0]?.init?.body).toBe("{}");
  });

  it("throws on a malformed 2xx body instead of defaulting to success", async () => {
    await expect(
      applyPluginUpdate(fetchReturning({ status: "done" }), "linear"),
    ).rejects.toThrow();
  });
});

describe("plugin installs", () => {
  it("uses the direct install endpoint for source specs", async () => {
    const { fetchImpl, calls } = recordingFetch({ installed: true });
    await expect(installPlugin(fetchImpl, "./plugins/local")).rejects.toThrow();
    expect(calls[0]?.url).toBe("/api/v1/plugins/install");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      source: "./plugins/local",
    });
  });

  it("uses the singleton catalog endpoint for catalog entries", async () => {
    const { fetchImpl, calls } = recordingFetch({ installed: true });
    await expect(
      installCatalogPlugin(fetchImpl, { entryId: "linear" }),
    ).rejects.toThrow();
    expect(calls[0]?.url).toBe("/api/v1/plugin-catalog/install");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      entryId: "linear",
    });
  });
});

describe("plugin catalog queries", () => {
  it("preserves the catalog data and an absent category", async () => {
    const data = await searchPluginCatalog(
      fetchReturning({
        results: [
          {
            entryId: "todoist",
            pluginId: "todoist",
            displayName: "Todoist",
            description: "Personal task capture",
            icon: "CheckList",
            iconUrl: null,
            source: "npm:@bb-plugins/todoist",
            marketplace: "acme-plugins",
            marketplaceDisplayName: "Acme Plugins",
            publisherKey: "acme-plugins",
            publisherLabel: "Acme Plugins",
            official: false,
            author: { name: "Acme", url: "https://acme.dev" },
            overview: "# Todoist\n\nLong-form text.\n",
            installed: false,
            compatible: false,
            incompatibleReason: "requires bb >= 0.15",
          },
        ],
        collections: [
          {
            id: "new-and-notable",
            displayName: "New & notable",
            pluginIds: ["todoist"],
          },
        ],
      }),
      "todo",
    );
    expect(data).toEqual({
      entries: [
        {
          entryId: "todoist",
          pluginId: "todoist",
          displayName: "Todoist",
          description: "Personal task capture",
          icon: "CheckList",
          iconUrl: null,
          iconTinted: false,
          screenshots: [],
          overview: "# Todoist\n\nLong-form text.\n",
          collections: [],
          source: "npm:@bb-plugins/todoist",
          repositoryUrl: null,
          marketplace: "acme-plugins",
          marketplaceDisplayName: "Acme Plugins",
          publisherKey: "acme-plugins",
          publisherLabel: "Acme Plugins",
          official: false,
          author: {
            name: "Acme",
            github: null,
            url: "https://acme.dev",
          },
          installed: false,
          installs: null,
          compatible: false,
          incompatibleReason: "requires bb >= 0.15",
        },
      ],
      collections: [
        {
          id: "new-and-notable",
          displayName: "New & notable",
          pluginIds: ["todoist"],
        },
      ],
    });
  });

  it("throws instead of replacing cached search data with an empty result", async () => {
    await expect(
      searchPluginCatalog(
        fetchReturning({ error: "upstream unavailable" }, 503),
        "",
      ),
    ).rejects.toThrow("upstream unavailable");
  });
});
