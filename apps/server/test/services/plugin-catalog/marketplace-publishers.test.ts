import { createConnection, migrate, upsertPluginMarketplace } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  marketplacePublisherLabel,
  marketplacePublisherLabels,
  pluginPublisherLabel,
} from "../../../src/services/plugin-catalog/marketplace-publishers.js";
import { BUNDLED_CURATED_MARKETPLACE } from "../../../src/services/plugin-catalog/curated-marketplace.js";

function connect() {
  const db = createConnection(":memory:");
  migrate(db);
  return db;
}

function register(
  db: ReturnType<typeof connect>,
  name: string,
  manifestJson: string,
) {
  upsertPluginMarketplace(db, {
    name,
    sourceKind: "https",
    manifestUrl: `https://${name}.test/marketplace.json`,
    sourceGitRef: null,
    sourceGitCommit: null,
    manifestJson,
    statsJson: null,
    etag: null,
    lastModified: null,
    lastSuccessfulRefreshAt: null,
    lastAttemptedRefreshAt: null,
    lastError: null,
  });
}

describe("marketplace publisher labels", () => {
  it("names each marketplace by its own display name", () => {
    const db = connect();
    register(
      db,
      "bb-community",
      JSON.stringify({
        schemaVersion: 1,
        name: "bb-community",
        displayName: "BB Community",
        plugins: [],
      }),
    );
    register(
      db,
      "acme",
      JSON.stringify({
        schemaVersion: 1,
        name: "acme",
        displayName: "Acme Plugins",
        plugins: [],
      }),
    );
    const labels = marketplacePublisherLabels(db);

    expect(
      pluginPublisherLabel({
        sourceKind: "git",
        provenance: "catalog",
        catalogMarketplaceName: "bb-community",
        labels,
      }),
    ).toBe("BB Community");
    expect(
      pluginPublisherLabel({
        sourceKind: "npm",
        provenance: "catalog",
        catalogMarketplaceName: "acme",
        labels,
      }),
    ).toBe("Acme Plugins");
  });

  it("refuses a reserved label to a marketplace that is not BB's", () => {
    const db = connect();
    register(
      db,
      "acme",
      JSON.stringify({
        schemaVersion: 1,
        name: "acme",
        displayName: "BB Official",
        plugins: [],
      }),
    );
    const labels = marketplacePublisherLabels(db);

    expect(
      pluginPublisherLabel({
        sourceKind: "git",
        provenance: "catalog",
        catalogMarketplaceName: "acme",
        labels,
      }),
    ).toBe("acme");
    expect(
      marketplacePublisherLabel({
        marketplaceName: "acme",
        displayName: "BB Community",
      }),
    ).toBe("acme");
    expect(
      marketplacePublisherLabel({
        marketplaceName: "bb-community",
        displayName: "BB Community",
      }),
    ).toBe("BB Community");
  });

  it("keeps a badge when the stored manifest no longer parses", () => {
    const db = connect();
    register(db, "acme", "{ not json");
    const labels = marketplacePublisherLabels(db);

    expect(
      pluginPublisherLabel({
        sourceKind: "git",
        provenance: "catalog",
        catalogMarketplaceName: "acme",
        labels,
      }),
    ).toBe("acme");
  });

  it("keeps a store-installed bundled plugin on BB Official", () => {
    const db = connect();
    register(
      db,
      "bb-community",
      JSON.stringify({
        schemaVersion: 1,
        name: "bb-community",
        displayName: "BB Community",
        plugins: [],
      }),
    );
    const labels = marketplacePublisherLabels(db);

    expect(
      pluginPublisherLabel({
        sourceKind: "builtin",
        provenance: "catalog",
        catalogMarketplaceName: "bb-community",
        labels,
      }),
    ).toBe("BB Official");
  });

  it("badges bundled plugins BB Official and user installs not at all", () => {
    const labels = marketplacePublisherLabels(connect());

    expect(
      pluginPublisherLabel({
        sourceKind: "builtin",
        provenance: "builtin",
        catalogMarketplaceName: null,
        labels,
      }),
    ).toBe("BB Official");
    expect(
      pluginPublisherLabel({
        sourceKind: "git",
        provenance: "direct",
        catalogMarketplaceName: null,
        labels,
      }),
    ).toBeNull();
  });

  it("does not reuse BB Official for the marketplace bb curates", () => {
    expect(BUNDLED_CURATED_MARKETPLACE.displayName).toBe("BB Community");
  });
});
