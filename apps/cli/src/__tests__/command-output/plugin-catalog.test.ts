import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  getHelpOutput,
  readlineMocks,
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerPluginCommands } from "../../commands/plugin.js";

const searchResult = {
  entryId: "linear",
  pluginId: "linear",
  displayName: "Linear",
  description: "Linear issue tools",
  icon: null,
  iconUrl: null,
  iconTinted: false,
  category: "Developer tools",
  screenshots: [],
  collections: [],
  source: "builtin:linear",
  repositoryUrl: null,
  marketplace: "bb-official",
  marketplaceDisplayName: "BB Official",
  publisherKey: "bb-official",
  publisherLabel: "BB Official",
  official: true,
  author: null,
  installed: false,
  installs: null,
  compatible: true,
  incompatibleReason: null,
};

const bundledPlan = {
  kind: "bundled",
  entryId: "linear",
  pluginId: "linear",
  displayName: "Linear",
  source: "builtin:linear",
  compatible: true,
  incompatibleReason: null,
};

const thirdPartyPlan = {
  kind: "marketplace",
  entryId: "notes",
  pluginId: "notes",
  displayName: "Acme Notes",
  marketplace: "acme-plugins",
  marketplaceDisplayName: "Acme Plugins",
  publisherKey: "acme-plugins",
  publisherLabel: "Acme Plugins",
  official: false,
  author: { name: "Acme", url: "https://github.com/acme" },
  source: "git:https://github.com/acme/plugins.git@semver:notes/:^1.0.0",
  resolvedSource: {
    kind: "git",
    url: "https://github.com/acme/plugins.git",
    subdir: "plugins/notes",
    range: "^1.0.0",
    tagPrefix: "notes/",
    resolvedTag: "notes/v1.2.0",
    resolvedCommit: "b".repeat(40),
  },
  compatible: true,
  incompatibleReason: null,
};

const installedPlugin = {
  id: "linear",
  source: "builtin:linear",
  rootDir: "/plugins/linear",
  version: "1.4.2",
  provenance: "catalog",
  isOrphanedBuiltin: false,
  catalogEntryId: "linear",
  publisherLabel: "BB Community",
  sourceDisplay: "builtin · linear",
  updateState: {},
  enabled: true,
  description: "Linear issue tools",
  name: "Linear",
  screenshots: [],
  collections: [],
  icon: null,
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
  providerIds: [],
  icons: {},
};

function json(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("bb plugin catalog", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) =>
    registerPluginCommands(program, () => "http://server");

  it("renders catalog search without marketplace qualifiers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ results: [searchResult] }));

    await runCommand(["plugin", "search", "lin"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Linear issue tools");
    expect(output).toContain("Category");
    expect(output).toContain("Developer tools");
    expect(output).toContain("compatible");
    expect(output).not.toContain("Marketplace");
  });

  it("names the marketplace once a third-party listing appears", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({
        results: [
          searchResult,
          {
            ...searchResult,
            entryId: "notes",
            pluginId: "notes",
            displayName: "Acme Notes",
            marketplace: "acme-plugins",
            marketplaceDisplayName: "Acme Plugins",
            publisherKey: "acme-plugins",
            publisherLabel: "Acme Plugins",
            official: false,
            author: { name: "Acme", url: null },
          },
        ],
      }),
    );

    await runCommand(["plugin", "search", ""], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Marketplace");
    expect(output).toContain("Acme Plugins");
    expect(output).toContain("BB Official");
  });

  it("adds an Installs column only once a listing reports counts", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ results: [searchResult] }));
    await runCommand(["plugin", "search", "lin"], register);
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).not.toContain(
      "Installs",
    );

    vi.mocked(console.log).mockClear();
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ results: [{ ...searchResult, installs: 4210 }] }),
    );
    await runCommand(["plugin", "search", "lin"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Installs");
    expect(output).toContain("4,210");
  });

  it("outputs raw catalog search results as JSON", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ results: [searchResult] }));

    await runCommand(["plugin", "search", "lin", "--json"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify([searchResult], null, 2),
    ]);
  });

  it("treats path syntax as a path without catalog lookup", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: true, plugin: installedPlugin }),
    );

    await runCommand(["plugin", "install", "./linear", "--yes"], register);

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.source).toMatch(/^path:.*\/linear$/);
  });

  it("installs a pasted GitHub repository URL as a direct source", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: true, plugin: installedPlugin }),
    );
    const source = "https://github.com/acme/bb-plugin-linear";

    await runCommand(["plugin", "install", source, "--yes"], register);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "http://server/api/v1/plugins/install",
    );
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)),
    ).toEqual({ source });
  });

  it("sends --plugin and --subdirectory as the install selection", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      json({ ok: true, plugin: installedPlugin }),
    );
    const source = "git:github.com/acme/bb-plugins@main";

    await runCommand(
      ["plugin", "install", source, "--plugin", "linear", "--yes"],
      register,
    );
    await runCommand(
      [
        "plugin",
        "install",
        source,
        "--subdirectory",
        "plugins/linear",
        "--yes",
      ],
      register,
    );

    expect(
      vi
        .mocked(fetch)
        .mock.calls.map(
          (call) => JSON.parse(String(call[1]?.body)) as { selection: unknown },
        )
        .map((body) => body.selection),
    ).toEqual([
      { kind: "entry", name: "linear" },
      { kind: "subdirectory", path: "plugins/linear" },
    ]);
  });

  it("rewrites --tag-prefix into an explicit semver install spec", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      json({ ok: true, plugin: installedPlugin }),
    );

    await runCommand(
      [
        "plugin",
        "install",
        "git:github.com/acme/bb-plugins@^1.2.0",
        "--tag-prefix",
        "linear/",
        "--yes",
      ],
      register,
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map(
          (call) =>
            (JSON.parse(String(call[1]?.body)) as { source: string }).source,
        ),
    ).toEqual(["git:github.com/acme/bb-plugins@semver:linear/:^1.2.0"]);

    const errorSpy = vi.mocked(console.error);
    for (const args of [
      ["plugin", "install", "git:github.com/acme/bb-plugins", "--yes"],
      [
        "plugin",
        "install",
        "git:github.com/acme/bb-plugins@semver:^1.2.0",
        "--yes",
      ],
    ]) {
      await expect(
        runCommand([...args, "--tag-prefix", "linear/"], register),
      ).rejects.toThrowError("process.exit:1");
    }
    expect(
      errorSpy.mock.calls.map((call) => call.join(" ")).join("\n"),
    ).toMatch(/--tag-prefix applies to a git: source[\s\S]*not both/);
  });

  it("refuses --plugin together with --subdirectory", async () => {
    const errorSpy = vi.mocked(console.error);

    await expect(
      runCommand(
        [
          "plugin",
          "install",
          "git:github.com/acme/bb-plugins@main",
          "--plugin",
          "linear",
          "--subdirectory",
          "plugins/linear",
          "--yes",
        ],
        register,
      ),
    ).rejects.toThrowError("process.exit:1");
    expect(
      errorSpy.mock.calls.map((args) => args.join(" ")).join("\n"),
    ).toMatch(/not both/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps install --json free of human trust preamble output", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: true, plugin: installedPlugin }),
    );

    await runCommand(
      ["plugin", "install", "path:/linear", "--yes", "--json"],
      register,
    );

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify({ ok: true, plugin: installedPlugin }, null, 2),
    ]);
  });

  it("installs an exact bare catalog entry", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(json({ results: [searchResult] }))
      .mockResolvedValueOnce(json({ plan: bundledPlan }))
      .mockResolvedValueOnce(json({ ok: true, plugin: installedPlugin }));

    await runCommand(["plugin", "install", "linear", "--yes"], register);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://server/api/v1/plugin-catalog/search?q=linear",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://server/api/v1/plugin-catalog/install-plan?entryId=linear",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "http://server/api/v1/plugin-catalog/install",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      entryId: "linear",
    });
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      "bundled with BB",
    );
  });

  it("shows a third-party listing's true resolved source before installing", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(json({ plan: thirdPartyPlan }))
      .mockResolvedValueOnce(json({ ok: true, plugin: installedPlugin }));

    await runCommand(
      ["plugin", "install", "notes@acme-plugins", "--yes"],
      register,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://server/api/v1/plugin-catalog/install-plan?entryId=notes&marketplace=acme-plugins",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      entryId: "notes",
      marketplace: "acme-plugins",
      confirmedSource: thirdPartyPlan.resolvedSource,
    });
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Acme Plugins — a third-party marketplace");
    expect(output).toContain("author: Acme (https://github.com/acme)");
    expect(output).toContain(
      "git repository: https://github.com/acme/plugins.git",
    );
    expect(output).toContain("subdirectory: plugins/notes");
    expect(output).toContain("semver range: ^1.0.0 (tags notes/vX.Y.Z)");
    expect(output).toContain("resolves to tag: notes/v1.2.0");
    expect(output).toContain(`resolves to commit: ${"b".repeat(40)}`);
  });

  it("reports an npm listing by package and range", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        json({
          plan: {
            ...thirdPartyPlan,
            source: "npm:bb-plugin-notes@beta",
            resolvedSource: {
              kind: "npm",
              package: "bb-plugin-notes",
              tag: "beta",
              registry: "https://npm.acme.test",
            },
          },
        }),
      )
      .mockResolvedValueOnce(json({ ok: true, plugin: installedPlugin }));

    await runCommand(
      ["plugin", "install", "notes@acme-plugins", "--yes"],
      register,
    );

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("npm package: bb-plugin-notes@beta");
    expect(output).toContain("registry: https://npm.acme.test");
  });

  it("says so when a listed git source does not resolve right now", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        json({
          plan: {
            ...thirdPartyPlan,
            resolvedSource: {
              kind: "git",
              url: "https://github.com/acme/plugins.git",
              range: "^1.0.0",
              unresolvedReason: "no release tag matches ^1.0.0",
            },
          },
        }),
      )
      .mockResolvedValueOnce(json({ ok: true, plugin: installedPlugin }));

    await runCommand(
      ["plugin", "install", "notes@acme-plugins", "--yes"],
      register,
    );

    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      "not resolved right now: no release tag matches ^1.0.0",
    );
  });

  it("preserves full-trust confirmation for catalog installs", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(json({ results: [searchResult] }))
      .mockResolvedValueOnce(json({ plan: bundledPlan }))
      .mockResolvedValueOnce(json({ ok: true, plugin: installedPlugin }));
    readlineMocks.question.mockResolvedValue("yes");

    await runCommand(["plugin", "install", "linear"], register);

    expect(readlineMocks.question).toHaveBeenCalledWith("Install? [y/N] ");
  });

  it("routes entry@marketplace to that marketplace without a search", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(json({ plan: bundledPlan }))
      .mockResolvedValueOnce(json({ ok: true, plugin: installedPlugin }));

    await runCommand(
      ["plugin", "install", "linear@bb-official", "--yes"],
      register,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://server/api/v1/plugin-catalog/install-plan?entryId=linear&marketplace=bb-official",
    );
  });

  it("reports both interpretations and direct-source escape hatches", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ results: [] }));

    await expect(
      runCommand(["plugin", "install", "missing", "--yes"], register),
    ).rejects.toThrow("process.exit:1");

    const error = collectLogPayloads(vi.mocked(console.error)).join("\n");
    expect(error).toContain("either a catalog plugin or a path on disk");
    expect(error).toContain("path:<path>");
    expect(error).toContain("npm:<package>");
    expect(error).toContain("Git repository URL");
  });

  it("no longer advertises the remote catalog command group", async () => {
    const pluginHelp = await getHelpOutput(["plugin"], register);
    expect(pluginHelp).not.toMatch(/^\s+catalog/mu);
    expect(pluginHelp).not.toMatch(/^\s+marketplace/mu);
    expect(pluginHelp).not.toMatch(/^\s+submit\b/mu);
    expect(pluginHelp).toContain("search");

    const installHelp = await getHelpOutput(["plugin", "install"], register);
    expect(installHelp).not.toContain("--version");
  });
});
