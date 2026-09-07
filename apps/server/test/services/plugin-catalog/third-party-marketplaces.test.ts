import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createConnection,
  getInstalledPlugin,
  getPluginMarketplace,
  getPluginMarketplaceIcon,
  migrate,
  upsertInstalledPlugin,
  type DbConnection,
} from "@bb/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginCatalogService } from "../../../src/services/plugin-catalog/plugin-catalog-service.js";
import type { MarketplaceFetch } from "../../../src/services/plugin-catalog/marketplace-http.js";
import type { PluginService } from "../../../src/services/plugins/plugin-service.js";

const run = promisify(execFile);

const OFFICIAL_URL = "https://marketplace.test/marketplace/v1/marketplace.json";
const ACME_URL = "https://acme.test/marketplace.json";

const VALID_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>',
);
const OTHER_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>',
);

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "notes",
    displayName: "Acme Notes",
    description: "Notes beside a thread.",
    icon: "Zap",
    tags: ["git-tools"],
    author: { name: "Acme", github: "acme" },
    source: {
      git: { url: "https://github.com/acme/plugins.git", ref: "v1.0.0" },
    },
    ...overrides,
  };
}

function manifest(
  name: string,
  plugins: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    name,
    displayName: name === "acme-plugins" ? "Acme Plugins" : name,
    plugins,
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function svgResponse(bytes: Buffer) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/svg+xml" },
  });
}

describe("third-party marketplaces", () => {
  let db: DbConnection;
  let dataDir: string;
  let installedCatalogEntries: unknown[];
  const cleanup: string[] = [];
  const restoreEnv: (() => void)[] = [];

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    installedCatalogEntries = [];
    dataDir = await mkdtemp(join(tmpdir(), "bb-marketplace-data-"));
    cleanup.push(dataDir);
  });

  afterEach(async () => {
    db.$client.close();
    for (const restore of restoreEnv.splice(0)) restore();
    await Promise.all(
      cleanup
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  function service(options?: {
    fetch?: MarketplaceFetch;
    warn?: (message: string) => void;
    resolveNpm?: PluginService["resolveCatalogNpmSource"];
  }) {
    return createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      marketplaceUrl: OFFICIAL_URL,
      dataDir,
      bundledPlugins: [],
      plugins: {
        installOfficialPlugin: async () => {
          throw new Error("unexpected bundled install");
        },
        installCatalogPlugin: async (args: unknown) => {
          installedCatalogEntries.push(args);
          throw new Error("catalog installation stopped by test");
        },
        resolveCatalogNpmSource:
          options?.resolveNpm ??
          (async () => ({
            outcome: "resolved" as const,
            version: "1.4.2",
            integrity: "sha512-listed",
          })),
      },
      ...(options?.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options?.warn === undefined ? {} : { warn: options.warn }),
    });
  }

  function marketplaceFetch(
    documents: Record<string, unknown>,
    icons: Record<string, Buffer> = {},
  ): MarketplaceFetch {
    return async (url) => {
      const document = documents[url];
      if (document !== undefined) return jsonResponse(document);
      const icon = icons[url];
      if (icon !== undefined) return svgResponse(icon);
      return new Response("not found", { status: 404 });
    };
  }

  async function useGitUrlRewrite(url: string, repo: string): Promise<void> {
    const configFile = join(dataDir, "gitconfig");
    await writeFile(
      configFile,
      `[url "${repo}"]\n\tinsteadOf = ${url}\n`,
      "utf8",
    );
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = configFile;
    restoreEnv.push(() => {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    });
  }

  async function gitMarketplace(args: {
    name: string;
    plugins: unknown[];
    icon?: Buffer;
  }): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "bb-marketplace-repo-"));
    cleanup.push(repo);
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    await run("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(
      join(repo, "marketplace.json"),
      JSON.stringify(manifest(args.name, args.plugins)),
    );
    if (args.icon !== undefined) {
      await mkdir(join(repo, "icons"), { recursive: true });
      await writeFile(join(repo, "icons", "notes.svg"), args.icon);
    }
    await run("git", ["-c", "core.excludesFile=/dev/null", "add", "."], {
      cwd: repo,
    });
    await run("git", ["commit", "-qm", "catalog"], { cwd: repo });
    return repo;
  }

  it("adds, refreshes, and removes a git marketplace read from a real checkout", async () => {
    const repo = await gitMarketplace({
      name: "acme-plugins",
      plugins: [entry({ icon: { url: "./icons/notes.svg" } })],
      icon: VALID_SVG,
    });
    const catalog = service({ fetch: marketplaceFetch({}) });

    const added = await catalog.addMarketplace(`git:${repo}@main`);
    expect(added).toMatchObject({
      name: "acme-plugins",
      displayName: "Acme Plugins",
      official: false,
      sourceKind: "git",
      source: `git:${repo}@main`,
      entryCount: 1,
    });
    expect(added.resolvedCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(installedCatalogEntries).toEqual([]);
    expect(
      getPluginMarketplaceIcon(db, "acme-plugins", "notes")?.contentType,
    ).toBe("image/svg+xml");
    expect(
      await rm(join(dataDir, "marketplaces", "staging"), {
        recursive: true,
        force: true,
      }).then(() => true),
    ).toBe(true);

    await writeFile(
      join(repo, "marketplace.json"),
      JSON.stringify(
        manifest("acme-plugins", [
          entry({ icon: { url: "./icons/notes.svg" } }),
          entry({ id: "status", displayName: "Acme Status", icon: "Zap" }),
        ]),
      ),
    );
    await run("git", ["commit", "-qam", "second"], { cwd: repo });
    const [refreshed] = await catalog.refreshMarketplaces({
      name: "acme-plugins",
    });
    expect(refreshed).toMatchObject({ name: "acme-plugins", ok: true });
    expect(refreshed?.marketplace.entryCount).toBe(2);
    expect(refreshed?.marketplace.resolvedCommit).not.toBe(
      added.resolvedCommit,
    );

    const removed = await catalog.removeMarketplace("acme-plugins");
    expect(removed.convertedPluginIds).toEqual([]);
    expect(getPluginMarketplace(db, "acme-plugins")).toBeUndefined();
    expect(
      getPluginMarketplaceIcon(db, "acme-plugins", "notes"),
    ).toBeUndefined();
    expect(catalog.listMarketplaces().map((row) => row.name)).toEqual([
      "bb-official",
      "bb-community",
    ]);

    const readded = await catalog.addMarketplace(`git:${repo}@main`);
    expect(readded).toMatchObject({
      name: "acme-plugins",
      entryCount: 2,
      resolvedCommit: refreshed?.marketplace.resolvedCommit,
    });
    expect(
      getPluginMarketplaceIcon(db, "acme-plugins", "notes")?.contentType,
    ).toBe("image/svg+xml");
  });

  it("removes a checkout left by a prior process crash", async () => {
    const repo = await gitMarketplace({
      name: "acme-plugins",
      plugins: [entry()],
    });
    const staleCheckout = join(
      dataDir,
      "marketplaces",
      "staging",
      "stale-checkout",
    );
    await mkdir(staleCheckout, { recursive: true });
    await writeFile(join(staleCheckout, "marketplace.json"), "stale");

    const catalog = service({ fetch: marketplaceFetch({}) });
    await catalog.addMarketplace(`git:${repo}@main`);

    expect(await stat(staleCheckout).catch(() => null)).toBeNull();
  });

  it("reads a path marketplace and its icons in place", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-marketplace-dir-"));
    cleanup.push(directory);
    await mkdir(join(directory, "icons"), { recursive: true });
    await writeFile(join(directory, "icons", "notes.svg"), VALID_SVG);
    await writeFile(
      join(directory, "marketplace.json"),
      JSON.stringify(
        manifest("acme-plugins", [
          entry({ icon: { url: "./icons/notes.svg" } }),
        ]),
      ),
    );
    const catalog = service({ fetch: marketplaceFetch({}) });

    const added = await catalog.addMarketplace(`path:${directory}`);
    expect(added).toMatchObject({
      name: "acme-plugins",
      sourceKind: "path",
      source: `path:${directory}`,
      resolvedCommit: null,
      entryCount: 1,
    });
    expect(getPluginMarketplaceIcon(db, "acme-plugins", "notes")).toBeDefined();
  });

  it("rejects a bundled source from a fetched marketplace", async () => {
    const bundledUrl = "https://acme.test/bundled-marketplace.json";
    const catalog = service({
      fetch: marketplaceFetch({
        [bundledUrl]: {
          schemaVersion: 2,
          name: "acme-bundled",
          displayName: "Acme Bundled",
          plugins: [entry({ source: { bundled: { plugin: "docs" } } })],
        },
      }),
    });

    await expect(catalog.addMarketplace(bundledUrl)).rejects.toThrow(
      /not allowed in fetched or third-party documents/u,
    );
  });

  it("refuses name collisions and reserved marketplace names", async () => {
    const catalog = service({
      fetch: marketplaceFetch({
        [ACME_URL]: manifest("acme-plugins", [entry()]),
        "https://impostor.test/marketplace.json": manifest("bb-community", [
          entry(),
        ]),
        "https://official-impostor.test/marketplace.json": manifest(
          "bb-official",
          [entry()],
        ),
        "https://other.test/marketplace.json": manifest("acme-plugins", [
          entry({ id: "other" }),
        ]),
      }),
    });

    await catalog.addMarketplace(ACME_URL);
    await expect(
      catalog.addMarketplace("https://other.test/marketplace.json"),
    ).rejects.toThrow('marketplace "acme-plugins" is already added');
    await expect(
      catalog.addMarketplace("https://impostor.test/marketplace.json"),
    ).rejects.toThrow(/"bb-community" is reserved/);
    await expect(
      catalog.addMarketplace("https://official-impostor.test/marketplace.json"),
    ).rejects.toThrow(/"bb-official" is reserved/);
    await expect(catalog.removeMarketplace("bb-community")).rejects.toThrow(
      /cannot be removed/,
    );
    await expect(catalog.removeMarketplace("bb-official")).rejects.toThrow(
      /cannot be removed/,
    );
    expect(catalog.listMarketplaces().map((row) => row.name)).toEqual([
      "bb-official",
      "bb-community",
      "acme-plugins",
    ]);
  });

  it("refuses an ambiguous bare install and installs the qualified one", async () => {
    const catalog = service({
      fetch: marketplaceFetch({
        [OFFICIAL_URL]: manifest("bb-community", [
          entry({
            id: "notes",
            displayName: "Official Notes",
            source: { npm: { package: "bb-plugin-notes" } },
          }),
        ]),
        [ACME_URL]: manifest("acme-plugins", [
          entry({ source: { npm: { package: "bb-plugin-notes" } } }),
        ]),
      }),
    });
    await catalog.refresh(1_000);
    await catalog.addMarketplace(ACME_URL);

    await expect(catalog.install({ entryId: "notes" })).rejects.toThrow(
      "notes@bb-community, notes@acme-plugins",
    );
    expect(installedCatalogEntries).toEqual([]);

    await expect(
      catalog.install({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: {
          kind: "npm",
          package: "bb-plugin-notes",
          resolvedVersion: "1.4.2",
          resolvedIntegrity: "sha512-listed",
        },
      }),
    ).rejects.toThrow("catalog installation stopped by test");
    expect(installedCatalogEntries).toEqual([
      {
        marketplace: "acme-plugins",
        entryId: "notes",
        pluginId: "notes",
        source: "npm:bb-plugin-notes",
        selection: { kind: "root" },
        expectedNpmVersion: "1.4.2",
        expectedNpmIntegrity: "sha512-listed",
      },
    ]);
  });

  it("names a bundled official plugin with <id>@bb-official", async () => {
    const catalog = createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      marketplaceUrl: OFFICIAL_URL,
      dataDir,
      plugins: {
        installOfficialPlugin: async (name: string) => {
          installedCatalogEntries.push({ bundled: name });
          throw new Error("bundled installation stopped by test");
        },
        installCatalogPlugin: async () => {
          throw new Error("unexpected catalog install");
        },
        resolveCatalogNpmSource: async () => ({
          outcome: "unavailable" as const,
          detail: "no registry in this test",
        }),
      },
      fetch: marketplaceFetch({ [OFFICIAL_URL]: manifest("bb-community", []) }),
    });

    await expect(
      catalog.install({ entryId: "docs", marketplace: "bb-official" }),
    ).rejects.toThrow(/bundled installation stopped by test/u);
    await expect(
      catalog.install({ entryId: "docs", marketplace: "acme-plugins" }),
    ).rejects.toThrow('unknown marketplace "acme-plugins"');
  });

  it("installs a single marketplace match from a bare entry id", async () => {
    const catalog = service({
      fetch: marketplaceFetch({
        [OFFICIAL_URL]: manifest("bb-community", []),
        [ACME_URL]: manifest("acme-plugins", [
          entry({ source: { npm: { package: "bb-plugin-notes" } } }),
        ]),
      }),
    });
    await catalog.refresh(1_000);
    await catalog.addMarketplace(ACME_URL);

    await expect(
      catalog.install({
        entryId: "notes",
        confirmedSource: {
          kind: "npm",
          package: "bb-plugin-notes",
          resolvedVersion: "1.4.2",
          resolvedIntegrity: "sha512-listed",
        },
      }),
    ).rejects.toThrow("catalog installation stopped by test");
    expect(installedCatalogEntries).toHaveLength(1);
    await expect(catalog.install({ entryId: "missing" })).rejects.toThrow(
      'unknown plugin catalog entry "missing"',
    );
  });

  it("refuses a third-party source that changed after confirmation", async () => {
    let packageName = "bb-plugin-notes";
    const catalog = service({
      fetch: async (url) =>
        url === ACME_URL
          ? jsonResponse(
              manifest("acme-plugins", [
                entry({ source: { npm: { package: packageName } } }),
              ]),
            )
          : new Response("not found", { status: 404 }),
    });
    await catalog.addMarketplace(ACME_URL);
    const plan = await catalog.installPlan({
      entryId: "notes",
      marketplace: "acme-plugins",
    });
    if (plan.kind !== "marketplace") throw new Error("expected a listing");

    packageName = "bb-plugin-notes-impostor";
    await catalog.refreshMarketplaces({ name: "acme-plugins" });

    await expect(
      catalog.install({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: plan.resolvedSource,
      }),
    ).rejects.toThrow(/source changed after confirmation/u);
    expect(installedCatalogEntries).toEqual([]);
  });

  it("keeps installed plugins updatable after their marketplace is removed", async () => {
    const catalog = service({
      fetch: marketplaceFetch({
        [ACME_URL]: manifest("acme-plugins", [entry()]),
      }),
    });
    await catalog.addMarketplace(ACME_URL);
    upsertInstalledPlugin(db, {
      id: "notes",
      source: "git:https://github.com/acme/plugins.git@semver:^1.0.0",
      provenance: {
        kind: "catalog",
        marketplace: "acme-plugins",
        entryId: "notes",
      },
      sourceIntent: {
        kind: "git",
        url: "https://github.com/acme/plugins.git",
        subdirectory: "plugins/notes",
        selector: {
          kind: "range",
          range: "^1.0.0",
          tagPrefix: "notes/",
          resolvedTag: "notes/v1.0.0",
        },
      },
      exactResolution: { kind: "git", commit: "a".repeat(40) },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/plugins/notes",
      version: "1.0.0",
      enabled: true,
    });

    const removed = await catalog.removeMarketplace("acme-plugins");
    expect(removed.convertedPluginIds).toEqual(["notes"]);

    const row = getInstalledPlugin(db, "notes");
    expect(row).toMatchObject({
      provenance: "direct",
      catalogEntryId: null,
      catalogMarketplaceName: null,
      sourceKind: "git",
      sourceGitUrl: "https://github.com/acme/plugins.git",
      sourceGitSubdirectory: "plugins/notes",
      sourceGitRange: "^1.0.0",
      sourceGitTagPrefix: "notes/",
      sourceGitResolvedTag: "notes/v1.0.0",
      gitResolvedCommit: "a".repeat(40),
      enabled: true,
      removedAt: null,
    });
  });

  it("keeps icons and catalogs isolated between marketplaces", async () => {
    const catalog = service({
      fetch: marketplaceFetch(
        {
          [OFFICIAL_URL]: manifest("bb-community", [
            entry({
              id: "official-notes",
              icon: { url: "https://marketplace.test/marketplace/v1/a.svg" },
            }),
          ]),
          [ACME_URL]: manifest("acme-plugins", [
            entry({ icon: { url: "https://acme.test/b.svg" } }),
          ]),
        },
        {
          "https://marketplace.test/marketplace/v1/a.svg": VALID_SVG,
          "https://acme.test/b.svg": OTHER_SVG,
        },
      ),
    });
    await catalog.refresh(1_000);
    await catalog.addMarketplace(ACME_URL);

    const official = getPluginMarketplaceIcon(
      db,
      "bb-community",
      "official-notes",
    );
    const acme = getPluginMarketplaceIcon(db, "acme-plugins", "notes");
    expect(official?.contentHash).not.toBe(acme?.contentHash);
    expect(
      getPluginMarketplaceIcon(db, "bb-community", "notes"),
    ).toBeUndefined();
    expect(
      getPluginMarketplaceIcon(db, "acme-plugins", "official-notes"),
    ).toBeUndefined();

    await catalog.removeMarketplace("acme-plugins");
    expect(
      getPluginMarketplaceIcon(db, "bb-community", "official-notes"),
    ).toBeDefined();
    expect(
      getPluginMarketplaceIcon(db, "acme-plugins", "notes"),
    ).toBeUndefined();
  });

  it("leaves bb-community serving when a third-party refresh fails", async () => {
    const warnings: string[] = [];
    let acmeFails = false;
    const catalog = service({
      warn: (message) => warnings.push(message),
      fetch: async (url) => {
        if (url === OFFICIAL_URL) {
          return jsonResponse(
            manifest("bb-community", [entry({ id: "official-notes" })]),
          );
        }
        if (url === ACME_URL) {
          if (acmeFails) return new Response("boom", { status: 503 });
          return jsonResponse(manifest("acme-plugins", [entry()]));
        }
        return new Response("not found", { status: 404 });
      },
    });
    await catalog.refresh(1_000);
    await catalog.addMarketplace(ACME_URL);
    acmeFails = true;

    const results = await catalog.refreshMarketplaces({ attemptedAt: 2_000 });
    expect(results).toMatchObject([
      { name: "bb-official", ok: true },
      { name: "bb-community", ok: true },
      { name: "acme-plugins", ok: false },
    ]);
    expect(results[2]?.error).toContain("503");

    const marketplaces = catalog.listMarketplaces();
    expect(marketplaces[0]).toMatchObject({
      name: "bb-official",
      lastRefreshAt: 2_000,
      lastError: null,
    });
    expect(marketplaces[1]).toMatchObject({
      name: "bb-community",
      lastRefreshAt: 2_000,
      lastError: null,
    });
    expect(marketplaces[2]).toMatchObject({
      name: "acme-plugins",
      entryCount: 1,
      lastAttemptAt: 2_000,
    });
    const searched = await catalog.search("");
    expect(searched.map((result) => result.entryId)).toEqual([
      "official-notes",
      "notes",
    ]);
  });

  it("groups search results by marketplace with the official one first", async () => {
    const catalog = service({
      fetch: marketplaceFetch({
        [OFFICIAL_URL]: manifest("bb-community", [
          entry({ id: "official-notes", tags: ["interface"] }),
        ]),
        [ACME_URL]: manifest("acme-plugins", [
          entry({ tags: ["git-tools"] }),
          entry({ id: "zebra", displayName: "Zebra", tags: ["git-tools"] }),
        ]),
      }),
    });
    await catalog.refresh(1_000);
    await catalog.addMarketplace(ACME_URL);

    const results = await catalog.search("");
    expect(
      results.map((result) => [
        result.marketplace,
        result.category,
        result.entryId,
      ]),
    ).toEqual([
      ["bb-community", "Interface", "official-notes"],
      ["acme-plugins", "Git Tools", "notes"],
      ["acme-plugins", "Git Tools", "zebra"],
    ]);
    expect(results[1]).toMatchObject({
      official: false,
      marketplaceDisplayName: "Acme Plugins",
      author: { name: "Acme", url: "https://github.com/acme" },
    });
    expect(results[0]?.official).toBe(true);
  });

  describe("install plans", () => {
    it("resolves a third-party git range to its current tag and commit", async () => {
      const repo = await mkdtemp(join(tmpdir(), "bb-plugin-repo-"));
      cleanup.push(repo);
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await run("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      });
      await run("git", ["config", "user.name", "Test"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "one");
      await run("git", ["add", "."], { cwd: repo });
      await run("git", ["commit", "-qm", "one"], { cwd: repo });
      await run("git", ["tag", "notes/v1.0.0"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "two");
      await run("git", ["commit", "-qam", "two"], { cwd: repo });
      await run("git", ["tag", "notes/v1.2.0"], { cwd: repo });
      await run("git", ["tag", "notes/v2.0.0"], { cwd: repo });
      const expected = (
        await run("git", ["rev-parse", "notes/v1.2.0"], { cwd: repo })
      ).stdout.trim();
      const listedUrl = "https://acme.test/bb-plugins.git";
      await useGitUrlRewrite(listedUrl, repo);

      const catalog = service({
        fetch: marketplaceFetch({
          [ACME_URL]: manifest("acme-plugins", [
            entry({
              source: {
                git: {
                  url: listedUrl,
                  subdir: "plugins/notes",
                  range: "^1.0.0",
                  tagPrefix: "notes/",
                },
              },
            }),
          ]),
        }),
      });
      await catalog.addMarketplace(ACME_URL);

      const plan = await catalog.installPlan({
        entryId: "notes",
        marketplace: "acme-plugins",
      });
      expect(plan).toMatchObject({
        kind: "marketplace",
        entryId: "notes",
        marketplace: "acme-plugins",
        official: false,
        author: { name: "Acme", url: "https://github.com/acme" },
        source: `git:${listedUrl}@semver:notes/:^1.0.0`,
        resolvedSource: {
          kind: "git",
          url: listedUrl,
          subdir: "plugins/notes",
          range: "^1.0.0",
          tagPrefix: "notes/",
          resolvedTag: "notes/v1.2.0",
          resolvedCommit: expected,
        },
        compatible: true,
      });
    });

    it("reports an unresolvable git source instead of failing the plan", async () => {
      const catalog = service({
        fetch: marketplaceFetch({
          [ACME_URL]: manifest("acme-plugins", [
            entry({
              source: {
                git: {
                  url: "https://acme.invalid/missing.git",
                  ref: "v9.9.9",
                },
              },
            }),
          ]),
        }),
      });
      await catalog.addMarketplace(ACME_URL);

      const plan = await catalog.installPlan({
        entryId: "notes",
        marketplace: "acme-plugins",
      });
      expect(plan).toMatchObject({ kind: "marketplace" });
      if (plan.kind !== "marketplace") throw new Error("expected a listing");
      expect(plan.resolvedSource).toMatchObject({
        kind: "git",
        ref: "v9.9.9",
      });
      expect(
        plan.resolvedSource.kind === "git"
          ? plan.resolvedSource.unresolvedReason
          : undefined,
      ).toBeDefined();
    });

    it("describes an npm listing by package, range, and registry", async () => {
      const catalog = service({
        fetch: marketplaceFetch({
          [ACME_URL]: manifest("acme-plugins", [
            entry({
              source: {
                npm: {
                  package: "bb-plugin-notes",
                  tag: "beta",
                  registry: "https://npm.acme.test",
                },
              },
            }),
          ]),
        }),
      });
      await catalog.addMarketplace(ACME_URL);

      const plan = await catalog.installPlan({
        entryId: "notes",
        marketplace: "acme-plugins",
      });
      expect(plan).toMatchObject({
        kind: "marketplace",
        source: "npm:bb-plugin-notes@beta",
        resolvedSource: {
          kind: "npm",
          package: "bb-plugin-notes",
          tag: "beta",
          registry: "https://npm.acme.test",
        },
      });
    });

    it("names the official catalog without a network round trip", async () => {
      const catalog = service({
        fetch: marketplaceFetch({
          [OFFICIAL_URL]: manifest("bb-community", [
            entry({
              id: "official-notes",
              source: {
                git: {
                  url: "https://github.invalid/bb/plugins.git",
                  range: "^1.0.0",
                },
              },
            }),
          ]),
        }),
      });
      await catalog.refresh(1_000);

      const plan = await catalog.installPlan({ entryId: "official-notes" });
      expect(plan).toMatchObject({
        kind: "marketplace",
        marketplace: "bb-community",
        official: true,
        resolvedSource: {
          kind: "git",
          url: "https://github.invalid/bb/plugins.git",
          range: "^1.0.0",
        },
      });
      if (plan.kind !== "marketplace") throw new Error("expected a listing");
      expect(
        plan.resolvedSource.kind === "git"
          ? plan.resolvedSource.unresolvedReason
          : undefined,
      ).toBeUndefined();
    });
  });

  it("refuses an oversize local manifest before reading it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-marketplace-big-"));
    cleanup.push(directory);
    const padded = manifest("acme-plugins", [
      entry({ description: "x".repeat(1_100_000) }),
    ]);
    await writeFile(
      join(directory, "marketplace.json"),
      JSON.stringify(padded),
    );
    const catalog = service({ fetch: marketplaceFetch({}) });

    await expect(catalog.addMarketplace(`path:${directory}`)).rejects.toThrow(
      /marketplace manifest exceeds/u,
    );
    expect(getPluginMarketplace(db, "acme-plugins")).toBeUndefined();
  });

  it("binds an npm install to the exact version it confirmed", async () => {
    const npmEntry = entry({
      source: { npm: { package: "bb-plugin-notes", range: "^1.0.0" } },
    });
    let resolvedVersion = "1.4.2";
    const catalog = service({
      fetch: marketplaceFetch({
        [OFFICIAL_URL]: manifest("bb-community", []),
        [ACME_URL]: manifest("acme-plugins", [npmEntry]),
      }),
      resolveNpm: async () => ({
        outcome: "resolved" as const,
        version: resolvedVersion,
        integrity: `sha512-${resolvedVersion}`,
      }),
    });
    await catalog.addMarketplace(ACME_URL);

    const plan = await catalog.installPlan({
      entryId: "notes",
      marketplace: "acme-plugins",
    });
    expect(plan).toMatchObject({
      kind: "marketplace",
      resolvedSource: {
        kind: "npm",
        package: "bb-plugin-notes",
        range: "^1.0.0",
        resolvedVersion: "1.4.2",
        resolvedIntegrity: "sha512-1.4.2",
      },
    });
    if (plan.kind !== "marketplace") throw new Error("expected a marketplace");

    resolvedVersion = "1.5.0";
    await expect(
      catalog.install({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: plan.resolvedSource,
      }),
    ).rejects.toThrow(/source changed after confirmation/u);
    expect(installedCatalogEntries).toEqual([]);

    const current = await catalog.installPlan({
      entryId: "notes",
      marketplace: "acme-plugins",
    });
    if (current.kind !== "marketplace") {
      throw new Error("expected a marketplace");
    }
    await expect(
      catalog.install({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: current.resolvedSource,
      }),
    ).rejects.toThrow("catalog installation stopped by test");
    expect(installedCatalogEntries).toEqual([
      expect.objectContaining({
        expectedNpmVersion: "1.5.0",
        expectedNpmIntegrity: "sha512-1.5.0",
      }),
    ]);
  });

  it("refuses an npm install whose version cannot be resolved", async () => {
    const npmEntry = entry({
      source: { npm: { package: "bb-plugin-notes", tag: "beta" } },
    });
    const catalog = service({
      fetch: marketplaceFetch({
        [OFFICIAL_URL]: manifest("bb-community", []),
        [ACME_URL]: manifest("acme-plugins", [npmEntry]),
      }),
      resolveNpm: async () => ({
        outcome: "unavailable" as const,
        detail: "registry is unreachable",
      }),
    });
    await catalog.addMarketplace(ACME_URL);

    const plan = await catalog.installPlan({
      entryId: "notes",
      marketplace: "acme-plugins",
    });
    if (plan.kind !== "marketplace") throw new Error("expected a marketplace");
    await expect(
      catalog.install({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: plan.resolvedSource,
      }),
    ).rejects.toThrow(/npm source could not be resolved/u);
    expect(installedCatalogEntries).toEqual([]);
  });

  it("holds the marketplace lock across an install", async () => {
    const order: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resolveCalls = 0;
    const catalog = service({
      fetch: marketplaceFetch({
        [OFFICIAL_URL]: manifest("bb-community", []),
        [ACME_URL]: manifest("acme-plugins", [
          entry({
            source: { npm: { package: "bb-plugin-notes", range: "^1.0.0" } },
          }),
        ]),
      }),
      resolveNpm: async () => {
        resolveCalls += 1;
        if (resolveCalls > 1) await gate;
        return {
          outcome: "resolved" as const,
          version: "1.4.2",
          integrity: "sha512-listed",
        };
      },
    });
    await catalog.addMarketplace(ACME_URL);
    const plan = await catalog.installPlan({
      entryId: "notes",
      marketplace: "acme-plugins",
    });
    if (plan.kind !== "marketplace") throw new Error("expected a marketplace");

    const install = catalog
      .install({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: plan.resolvedSource,
      })
      .catch((error: unknown) => {
        order.push("install");
        throw error;
      });
    const removal = catalog.removeMarketplace("acme-plugins").then((result) => {
      order.push("removal");
      return result;
    });
    release();

    await expect(install).rejects.toThrow(
      "catalog installation stopped by test",
    );
    await expect(removal).resolves.toMatchObject({ convertedPluginIds: [] });
    expect(order).toEqual(["install", "removal"]);
    expect(installedCatalogEntries).toEqual([
      expect.objectContaining({ marketplace: "acme-plugins" }),
    ]);
    expect(getPluginMarketplace(db, "acme-plugins")).toBeUndefined();
  });

  it("refuses a manifest name that later routes cannot address", async () => {
    const catalog = service({
      fetch: marketplaceFetch({
        [OFFICIAL_URL]: manifest("bb-community", []),
        [ACME_URL]: manifest("a".repeat(65), [entry()]),
      }),
    });

    await expect(catalog.addMarketplace(ACME_URL)).rejects.toThrow(
      /invalid marketplace manifest/u,
    );
    expect(getPluginMarketplace(db, "a".repeat(65))).toBeUndefined();
  });

  it("refuses a marketplace source bb cannot interpret", async () => {
    const catalog = service({ fetch: marketplaceFetch({}) });
    await expect(catalog.addMarketplace("acme/marketplace")).rejects.toThrow(
      /expected "https:/u,
    );
    await expect(
      catalog.addMarketplace("http://acme.test/marketplace.json"),
    ).rejects.toThrow(/plain http is refused/u);
    await expect(
      catalog.addMarketplace("git:https://acme.test/repo.git@^1.0.0"),
    ).rejects.toThrow(/names one branch, tag, or commit/u);
  });
});
