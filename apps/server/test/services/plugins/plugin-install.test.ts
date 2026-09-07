import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnection,
  getInstalledPlugin,
  getInstalledPluginRegistration,
  listPluginArtifacts,
  migrate,
  type DbConnection,
} from "@bb/db";
import { ROOT_PLUGIN_SOURCE_SELECTION } from "@bb/server-contract";
import type { Logger } from "@bb/logger";
import { scaffoldPlugin } from "@bb/templates/plugin-scaffold";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@bb/domain";
import { validatePluginArtifactMeta } from "../../../src/services/plugins/app-bundle.js";
import {
  gitArtifactCacheDir,
  gitRangeSourceSpec,
  hashInstallDir,
  npmArtifactCacheDir,
  parsePluginSource,
  runInstallCommand,
} from "../../../src/services/plugins/install-sources.js";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;
const run = promisify(execFile);

async function linkScaffoldDependencies(targetDir: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(targetDir, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const testDir = dirname(fileURLToPath(import.meta.url));
  const appRequire = createRequire(
    join(testDir, "..", "..", "..", "..", "app", "package.json"),
  );
  for (const name of Object.keys(manifest.dependencies)) {
    let packageRoot = dirname(appRequire.resolve(name));
    while (true) {
      const candidate = join(packageRoot, "package.json");
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
        };
        if (parsed.name === name) break;
      }
      const parent = dirname(packageRoot);
      if (parent === packageRoot) {
        throw new Error(`could not find package root for ${name}`);
      }
      packageRoot = parent;
    }
    const linkPath = join(targetDir, "node_modules", name);
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(packageRoot, linkPath, "dir");
  }
}

async function hasBinary(command: string): Promise<boolean> {
  try {
    await run(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const [hasGit, hasNpm] = await Promise.all([
  hasBinary("git"),
  hasBinary("npm"),
]);

async function writePluginFixture(
  rootDir: string,
  options: {
    name: string;
    version?: string;
    engines?: string;
    pluginSdkRange?: string;
    appSource?: string;
    hostSource?: string;
    devDependencies?: Record<string, string>;
  },
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: options.version ?? "0.1.0",
      ...(options.devDependencies === undefined
        ? {}
        : { devDependencies: options.devDependencies }),
      ...(options.engines || options.pluginSdkRange
        ? {
            engines: {
              ...(options.engines ? { bb: options.engines } : {}),
              ...(options.pluginSdkRange
                ? { bbPluginSdk: options.pluginSdkRange }
                : {}),
            },
          }
        : {}),
      bb: {
        name: "Install fixture",
        description: "Plugin installation fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(options.appSource === undefined ? {} : { app: "./app.tsx" }),
        ...(options.hostSource === undefined ? {} : { host: "./host.ts" }),
      },
    }),
  );
  await writeFile(
    join(rootDir, "server.ts"),
    `export default function plugin(bb: any) { bb.log.info("loaded"); }`,
  );
  if (options.appSource !== undefined) {
    await writeFile(join(rootDir, "app.tsx"), options.appSource);
  }
  if (options.hostSource !== undefined) {
    await writeFile(join(rootDir, "host.ts"), options.hostSource);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

async function initGitRepo(repoDir: string): Promise<void> {
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["config", "user.email", "test@example.com"]);
  await git(repoDir, ["config", "user.name", "Test"]);
}

async function commitAll(repoDir: string, message: string): Promise<string> {
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-qm", message]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function artifactMeta(args: {
  artifactFormatVersion?: number;
  pluginId: string;
  pluginVersion?: string;
  sdkMajor?: number;
  sdkVersion?: string;
}): string {
  const sdkMajor = args.sdkMajor ?? PLUGIN_SDK_MAJOR;
  const sdkVersion = args.sdkVersion ?? PLUGIN_SDK_VERSION;
  return JSON.stringify({
    sdkMajor,
    sdkVersion,
    artifactFormatVersion: args.artifactFormatVersion ?? 1,
    pluginId: args.pluginId,
    pluginVersion: args.pluginVersion ?? "0.1.0",
    builtWith: {
      bbVersion: "0.9.0-test",
      pluginSdkVersion: sdkVersion,
    },
  });
}

describe("plugin install sources", () => {
  it("parses git URLs, tracks HEAD by default, and rejects traversal", () => {
    expect(parsePluginSource("git:github.com/acme/bb-plugin-foo@v1")).toEqual({
      kind: "git",
      url: "https://github.com/acme/bb-plugin-foo",
      spec: "v1",
      selector: { kind: "ref", ref: "v1" },
      cachePath: "github.com/acme/bb-plugin-foo",
    });
    expect(
      parsePluginSource(
        "git:https://github.com/acme/bb-plugin-foo.git@abc1234",
      ),
    ).toMatchObject({
      kind: "git",
      url: "https://github.com/acme/bb-plugin-foo.git",
    });
    expect(parsePluginSource("https://github.com/acme/bb-plugin-foo")).toEqual({
      kind: "git",
      url: "https://github.com/acme/bb-plugin-foo",
      spec: "HEAD",
      selector: { kind: "ref", ref: "HEAD" },
      cachePath: "github.com/acme/bb-plugin-foo",
    });
    expect(
      parsePluginSource("https://github.com/acme/bb-plugin-foo/"),
    ).toMatchObject({
      kind: "git",
      spec: "HEAD",
      cachePath: "github.com/acme/bb-plugin-foo",
    });
    expect(parsePluginSource("git:github.com/acme/repo")).toMatchObject({
      kind: "git",
      spec: "HEAD",
    });
    expect(() => parsePluginSource("git:github.com/acme/repo@")).toThrowError(
      /empty ref/,
    );
    expect(() =>
      parsePluginSource("git:github.com/acme/../evil@v1"),
    ).toThrowError(/invalid git repository path/);
    expect(() => parsePluginSource("git:/tmp/../evil@v1")).toThrowError(
      /invalid git repository path/,
    );
    expect(() =>
      parsePluginSource("git:github.com/acme/repo@-evil"),
    ).toThrowError(/invalid git ref/);
  });

  it("reads git semver ranges, explicit selectors, and tag prefixes", () => {
    for (const spec of ["^1.2.0", "~1.2", "1.x", ">=1.0.0 <2.0.0", "*"]) {
      expect(
        parsePluginSource(`git:github.com/acme/repo@${spec}`),
      ).toMatchObject({
        selector: { kind: "ref-or-range", ref: spec, range: spec },
      });
    }
    for (const spec of ["v1", "v1.2", "1.2.3", "main", "release/next"]) {
      expect(
        parsePluginSource(`git:github.com/acme/repo@${spec}`),
      ).toMatchObject({ selector: { kind: "ref", ref: spec } });
    }
    expect(
      parsePluginSource("git:github.com/acme/repo@semver:^1.2.0"),
    ).toMatchObject({
      spec: "semver:^1.2.0",
      selector: { kind: "range", range: "^1.2.0", tagPrefix: "" },
    });
    expect(
      parsePluginSource("git:github.com/acme/repo@semver:notes/:^1.2.0"),
    ).toMatchObject({
      selector: { kind: "range", range: "^1.2.0", tagPrefix: "notes/" },
    });
    expect(parsePluginSource("git:github.com/acme/repo@ref:1.x")).toMatchObject(
      { selector: { kind: "ref", ref: "1.x" } },
    );
    expect(
      gitRangeSourceSpec({
        url: "https://github.com/acme/repo.git",
        range: "^1.2.0",
        tagPrefix: "notes/",
      }),
    ).toBe("git:https://github.com/acme/repo.git@semver:notes/:^1.2.0");
    for (const spec of [
      "semver:not a range",
      "semver:a:b:^1.0.0",
      "semver:../evil/:^1.0.0",
      "ref:",
      "weird:ref",
    ]) {
      expect(() =>
        parsePluginSource(`git:github.com/acme/repo@${spec}`),
      ).toThrow();
    }
  });

  it("classifies omitted, exact, range, and dist-tag npm specs", () => {
    expect(parsePluginSource("npm:bb-plugin-linear@0.3.0")).toEqual({
      kind: "npm",
      name: "bb-plugin-linear",
      spec: "0.3.0",
      specKind: "exact",
    });
    expect(parsePluginSource("npm:@acme/bb-plugin-x@1.2.3")).toEqual({
      kind: "npm",
      name: "@acme/bb-plugin-x",
      spec: "1.2.3",
      specKind: "exact",
    });
    expect(parsePluginSource("npm:bb-plugin-x@^1.0.0")).toMatchObject({
      spec: "^1.0.0",
      specKind: "range",
    });
    expect(parsePluginSource("npm:bb-plugin-x@next")).toMatchObject({
      spec: "next",
      specKind: "tag",
    });
    expect(parsePluginSource("npm:bb-plugin-x")).toMatchObject({
      spec: "",
      specKind: "default",
    });
    expect(parsePluginSource("npm:@acme/bb-plugin-x")).toMatchObject({
      name: "@acme/bb-plugin-x",
      spec: "",
      specKind: "default",
    });
    expect(() => parsePluginSource("npm:--registry@latest")).toThrow(
      /invalid npm package name/,
    );
  });

  it("treats bare non-URL strings and path: as local paths with no managed dir", () => {
    expect(parsePluginSource("/tmp/my-plugin")).toEqual({
      kind: "path",
      path: "/tmp/my-plugin",
    });
    expect(parsePluginSource("path:/tmp/my-plugin")).toEqual({
      kind: "path",
      path: "/tmp/my-plugin",
    });
  });

  it("enforces parsed command output limits in UTF-8 bytes", async () => {
    await expect(
      runInstallCommand(
        process.execPath,
        ["-e", "process.stdout.write('é'.repeat(3))"],
        { maxStdoutBytes: 5 },
      ),
    ).rejects.toThrow(/more than 5 bytes/);
  });

  it("keeps script-policy npm config out of git/npm children", async () => {
    const overrides: Record<string, string> = {
      npm_config_allow_scripts: "@github/keytar,node-pty",
      npm_config_ignore_scripts: "false",
      NPM_CONFIG_FOREGROUND_SCRIPTS: "true",
      npm_config_registry: "https://registry.example.invalid/",
    };
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(overrides)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      const seen = await runInstallCommand(process.execPath, [
        "-e",
        "process.stdout.write(['npm_config_allow_scripts', 'npm_config_ignore_scripts', 'NPM_CONFIG_FOREGROUND_SCRIPTS', 'npm_config_registry'].map((k) => process.env[k] ?? '-').concat(process.env.PATH === undefined ? 'no-path' : 'path').join('|'))",
      ]);
      expect(seen).toBe("-|-|-|https://registry.example.invalid/|path");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps scoped npm and nested git cache paths inside their roots", () => {
    expect(npmArtifactCacheDir("/data", "@acme/plugin", "1.2.3")).toBe(
      "/data/plugins/cache/npm/@acme/plugin/1.2.3",
    );
    expect(
      gitArtifactCacheDir(
        "/data",
        "github.com/acme/nested/plugin",
        "abcdef1234567",
      ),
    ).toBe(
      "/data/plugins/cache/git/github.com/acme/nested/plugin/abcdef1234567",
    );
    expect(() => npmArtifactCacheDir("/data", "../plugin", "1.2.3")).toThrow(
      /invalid npm package/,
    );
    expect(() =>
      gitArtifactCacheDir("/data", "github.com/acme/../evil", "abcdef1"),
    ).toThrow(/invalid git artifact/);
  });
});

describe("plugin install flows", () => {
  let db: DbConnection;
  let workDir: string;
  let dataDir: string;
  let service: PluginService;
  let afterArtifactPromoted:
    | ((args: {
        pluginId: string;
        artifactId: string;
        path: string;
      }) => Promise<void>)
    | undefined;
  let materializationCount: number;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-install-"));
    dataDir = join(workDir, "data");
    afterArtifactPromoted = undefined;
    materializationCount = 0;
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir,
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
      afterArtifactPromoted: async (args) => afterArtifactPromoted?.(args),
      onArtifactMaterialize: () => {
        materializationCount += 1;
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  describe.skipIf(!hasGit)("git sources", { timeout: 30_000 }, () => {
    it("installs and tracks the default branch when the ref is omitted", async () => {
      const repoDir = join(workDir, "repo-default-branch");
      await writePluginFixture(repoDir, { name: "bb-plugin-default-branch" });
      await initGitRepo(repoDir);
      const commit = await commitAll(repoDir, "init");

      const source = `git:${repoDir}`;
      const entry = await service.install(source, { kind: "root" });

      expect(entry).toMatchObject({
        id: "default-branch",
        source,
        status: "running",
      });
      expect(
        getInstalledPluginRegistration(db, "default-branch"),
      ).toMatchObject({
        sourceKind: "git",
        sourceGitUrl: repoDir,
        sourceGitRequestedRef: "HEAD",
        sourceGitRefKind: "branch",
        gitResolvedCommit: commit,
      });
    });

    it("stamps catalog provenance for a git official catalog entry", async () => {
      const repoDir = join(workDir, "repo-catalog");
      await writePluginFixture(repoDir, { name: "bb-plugin-catalog-git" });
      await initGitRepo(repoDir);
      const commit = await commitAll(repoDir, "init");
      await git(repoDir, ["branch", "plugin/catalog-git"]);

      const source = `git:${repoDir}@plugin/catalog-git`;
      const entry = await service.installCatalogPlugin({
        marketplace: "bb-community",
        entryId: "catalog-git-entry",
        pluginId: "catalog-git",
        source,
        selection: ROOT_PLUGIN_SOURCE_SELECTION,
      });

      expect(entry).toMatchObject({
        id: "catalog-git",
        source,
        provenance: "catalog",
        catalogEntryId: "catalog-git-entry",
        catalogMarketplaceName: "bb-community",
        status: "running",
      });
      expect(getInstalledPluginRegistration(db, "catalog-git")).toMatchObject({
        provenance: "catalog",
        catalogEntryId: "catalog-git-entry",
        catalogMarketplaceName: "bb-community",
        sourceKind: "git",
        sourceGitUrl: repoDir,
        sourceGitRequestedRef: "plugin/catalog-git",
        sourceGitRefKind: "branch",
        gitResolvedCommit: commit,
      });
    });

    it("refuses a git commit that changed after marketplace confirmation", async () => {
      const repoDir = join(workDir, "repo-catalog-confirmed");
      await writePluginFixture(repoDir, { name: "bb-plugin-confirmed" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "initial");

      await expect(
        service.installCatalogPlugin({
          marketplace: "acme-plugins",
          entryId: "confirmed",
          pluginId: "confirmed",
          source: `git:${repoDir}@main`,
          selection: { kind: "root" },
          expectedGitCommit: "f".repeat(40),
        }),
      ).rejects.toThrow(/git source changed after confirmation/u);
      expect(getInstalledPlugin(db, "confirmed")).toBeUndefined();
    });

    it("refuses a catalog entry whose plugin requires another plugin SDK", async () => {
      const repoDir = join(workDir, "repo-catalog-sdk-too-new");
      await writePluginFixture(repoDir, {
        name: "bb-plugin-sdk-listed",
        pluginSdkRange: ">=99.0.0",
      });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");
      await git(repoDir, ["branch", "plugin/listed"]);

      await expect(
        service.installCatalogPlugin({
          marketplace: "bb-community",
          entryId: "sdk-listed",
          pluginId: "sdk-listed",
          source: `git:${repoDir}@plugin/listed`,
          selection: ROOT_PLUGIN_SOURCE_SELECTION,
        }),
      ).rejects.toThrow(
        new RegExp(
          `install refused.*requires bb plugin SDK >=99\\.0\\.0, running SDK is ${PLUGIN_SDK_VERSION.replaceAll(".", "\\.")}`,
          "u",
        ),
      );
      expect(getInstalledPluginRegistration(db, "sdk-listed")).toBeUndefined();
    });

    it("refuses a listed npm registry that is not a public https host", async () => {
      for (const registry of [
        "https://127.0.0.1/registry",
        "https://localhost/registry",
        "https://registry.acme.test:8443/",
        "https://user:secret@registry.acme.test/",
      ]) {
        await expect(
          service.installCatalogPlugin({
            marketplace: "bb-community",
            entryId: "catalog-npm-entry",
            pluginId: "registry",
            source: "npm:bb-plugin-registry@^1.0.0",
            selection: ROOT_PLUGIN_SOURCE_SELECTION,
            npmRegistry: registry,
          }),
        ).rejects.toThrow(/marketplace/);
      }
      expect(getInstalledPluginRegistration(db, "registry")).toBeUndefined();
    });

    it("guards a listed npm registry while it resolves an install plan", async () => {
      await expect(
        service.resolveCatalogNpmSource({
          packageName: "bb-plugin-registry",
          registry: "https://localhost/registry",
          requestedSpec: "latest",
          specKind: "tag",
        }),
      ).rejects.toThrow(/not public/u);
    });

    it("refuses a git catalog install whose manifest id differs from the entry", async () => {
      const repoDir = join(workDir, "repo-catalog-mismatch");
      await writePluginFixture(repoDir, { name: "bb-plugin-imposter" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");
      await git(repoDir, ["branch", "plugin/imposter"]);

      await expect(
        service.installCatalogPlugin({
          marketplace: "bb-community",
          entryId: "catalog-git-entry",
          pluginId: "expected-id",
          source: `git:${repoDir}@plugin/imposter`,
          selection: ROOT_PLUGIN_SOURCE_SELECTION,
        }),
      ).rejects.toThrow(/expects "expected-id"/);
    });

    it("clones a pinned tag into its exact immutable cache dir and loads it", async () => {
      const repoDir = join(workDir, "repo");
      await writePluginFixture(repoDir, { name: "bb-plugin-gitty" });
      await initGitRepo(repoDir);
      const commit = await commitAll(repoDir, "init");
      await git(repoDir, ["tag", "v1"]);

      const source = `git:${repoDir}@v1`;
      const entry = await service.install(source, { kind: "root" });
      expect(entry.id).toBe("gitty");
      expect(entry.status).toBe("running");
      expect(entry.source).toBe(source);
      expect(entry.rootDir).toBe(
        join(
          dataDir,
          "plugins",
          "cache",
          "git",
          "local",
          ...repoDir.replace(/^\/+/, "").split("/"),
          commit,
        ),
      );
      await stat(join(entry.rootDir, "package.json"));
      expect(getInstalledPluginRegistration(db, "gitty")).toMatchObject({
        provenance: "direct",
        sourceKind: "git",
        sourceGitUrl: repoDir,
        sourceGitRequestedRef: "v1",
        gitResolvedCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
        activeArtifactId: expect.any(String),
      });
    });

    it("resolves a semver range over release tags and tracks compatible", async () => {
      const repoDir = join(workDir, "repo-range");
      await writePluginFixture(repoDir, { name: "bb-plugin-ranger" });
      await initGitRepo(repoDir);
      const first = await commitAll(repoDir, "init");
      await git(repoDir, ["tag", "v1.0.0"]);
      await writeFile(join(repoDir, "note.txt"), "1.1.0");
      const second = await commitAll(repoDir, "1.1.0");
      await git(repoDir, ["tag", "-a", "v1.1.0", "-m", "1.1.0"]);
      await writeFile(join(repoDir, "note.txt"), "2.0.0");
      await commitAll(repoDir, "2.0.0");
      await git(repoDir, ["tag", "v2.0.0"]);
      await writeFile(join(repoDir, "note.txt"), "1.2.0-beta.1");
      await commitAll(repoDir, "1.2.0-beta.1");
      await git(repoDir, ["tag", "v1.2.0-beta.1"]);

      const source = `git:${repoDir}@^1.0.0`;
      const entry = await service.install(source, { kind: "root" });

      expect(entry).toMatchObject({ id: "ranger", status: "running" });
      expect(entry.sourceDisplay).toContain("tracks compatible");
      expect(getInstalledPluginRegistration(db, "ranger")).toMatchObject({
        sourceKind: "git",
        sourceGitUrl: repoDir,
        sourceGitRange: "^1.0.0",
        sourceGitTagPrefix: "",
        sourceGitResolvedTag: "v1.1.0",
        sourceGitRequestedRef: null,
        sourceGitRefKind: null,
        gitResolvedCommit: second,
      });
      expect(second).not.toBe(first);
      const view = await service.getSource("ranger");
      expect(view).toMatchObject({ range: "^1.0.0", resolvedTag: "v1.1.0" });
    });

    it("refuses a range spec that is also a ref, and honors the explicit forms", async () => {
      const repoDir = join(workDir, "repo-ambiguous");
      await writePluginFixture(repoDir, { name: "bb-plugin-ambiguous" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");
      await git(repoDir, ["tag", "v1.0.0"]);
      await git(repoDir, ["branch", "1.x"]);

      await expect(
        service.install(`git:${repoDir}@1.x`, { kind: "root" }),
      ).rejects.toThrow(/both a semver range and a branch/);
      expect(getInstalledPluginRegistration(db, "ambiguous")).toBeUndefined();

      await service.install(`git:${repoDir}@semver:1.x`, { kind: "root" });
      expect(getInstalledPluginRegistration(db, "ambiguous")).toMatchObject({
        sourceGitRange: "1.x",
        sourceGitResolvedTag: "v1.0.0",
      });
      expect(await service.remove("ambiguous")).toBe(true);

      await service.install(`git:${repoDir}@ref:1.x`, { kind: "root" });
      expect(getInstalledPluginRegistration(db, "ambiguous")).toMatchObject({
        sourceGitRange: null,
        sourceGitRequestedRef: "1.x",
        sourceGitRefKind: "branch",
      });
    });

    it("resolves a prefixed range and reports one with no matching tag", async () => {
      const repoDir = join(workDir, "repo-prefixed");
      await writePluginFixture(repoDir, { name: "bb-plugin-prefixed" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");
      await git(repoDir, ["tag", "v9.0.0"]);
      await writeFile(join(repoDir, "note.txt"), "prefixed");
      const tagged = await commitAll(repoDir, "prefixed release");
      await git(repoDir, ["tag", "prefixed/v1.4.2"]);

      await expect(
        service.install(`git:${repoDir}@semver:missing/:^1.0.0`, {
          kind: "root",
        }),
      ).rejects.toThrow(/no tag of .* matches \^1\.0\.0/);

      await service.install(`git:${repoDir}@semver:prefixed/:^1.0.0`, {
        kind: "root",
      });
      expect(getInstalledPluginRegistration(db, "prefixed")).toMatchObject({
        sourceGitRange: "^1.0.0",
        sourceGitTagPrefix: "prefixed/",
        sourceGitResolvedTag: "prefixed/v1.4.2",
        gitResolvedCommit: tagged,
      });
    });

    it("installs a catalog entry that lists a semver range", async () => {
      const repoDir = join(workDir, "repo-catalog-range");
      await writePluginFixture(repoDir, { name: "bb-plugin-catalog-range" });
      await initGitRepo(repoDir);
      const commit = await commitAll(repoDir, "init");
      await git(repoDir, ["tag", "v1.3.0"]);

      const entry = await service.installCatalogPlugin({
        marketplace: "bb-community",
        entryId: "catalog-range",
        pluginId: "catalog-range",
        source: `git:${repoDir}@semver:^1.0.0`,
        selection: ROOT_PLUGIN_SOURCE_SELECTION,
      });

      expect(entry).toMatchObject({
        id: "catalog-range",
        provenance: "catalog",
        status: "running",
      });
      expect(getInstalledPluginRegistration(db, "catalog-range")).toMatchObject(
        {
          catalogEntryId: "catalog-range",
          sourceGitRange: "^1.0.0",
          sourceGitResolvedTag: "v1.3.0",
          gitResolvedCommit: commit,
        },
      );
    });

    it("refuses a git plugin that shadows a builtin after materialization", async () => {
      const repoDir = join(workDir, "repo-connect");
      await writePluginFixture(repoDir, { name: "bb-plugin-connect" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");

      await expect(
        service.install(`git:${repoDir}@main`, { kind: "root" }),
      ).rejects.toThrowError(/reserved by the bundled plugin.*builtin:connect/);
      expect(getInstalledPluginRegistration(db, "connect")).toBeUndefined();
    });

    it("installs a pinned commit sha via clone + checkout", async () => {
      const repoDir = join(workDir, "repo-sha");
      await writePluginFixture(repoDir, { name: "bb-plugin-shaman" });
      await initGitRepo(repoDir);
      const sha = await commitAll(repoDir, "init");
      await writePluginFixture(repoDir, {
        name: "bb-plugin-shaman",
        version: "9.9.9",
      });
      await commitAll(repoDir, "later");

      const entry = await service.install(`git:${repoDir}@${sha}`, {
        kind: "root",
      });
      expect(entry.status).toBe("running");
      expect(entry.version).toBe("0.1.0");
    });

    it("never reuses an exact-resolution artifact owned by another plugin", async () => {
      const repoDir = join(workDir, "repo-owner");
      await writePluginFixture(repoDir, { name: "bb-plugin-owner" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");
      await git(repoDir, ["tag", "v1"]);
      const source = `git:${repoDir}@v1`;
      await service.install(source, { kind: "root" });
      const original = listPluginArtifacts(db, "owner")[0];
      if (original === undefined) throw new Error("missing owner artifact");
      await service.remove("owner");
      db.$client
        .prepare("UPDATE plugin_artifacts SET plugin_id = ? WHERE id = ?")
        .run("different-plugin", original.id);

      const reinstalled = await service.install(source, { kind: "root" });
      const activeId = getInstalledPluginRegistration(
        db,
        "owner",
      )?.activeArtifactId;
      expect(activeId).not.toBe(original.id);
      expect(reinstalled.status).toBe("running");
      expect(listPluginArtifacts(db, "owner")).toMatchObject([
        { id: activeId, pluginId: "owner", validationResult: "valid" },
      ]);
    });

    it("serializes concurrent installs of the same exact resolution", async () => {
      const repoDir = join(workDir, "repo-concurrent");
      await writePluginFixture(repoDir, { name: "bb-plugin-concurrent" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");
      await git(repoDir, ["tag", "v1"]);
      const source = `git:${repoDir}@v1`;

      const results = await Promise.allSettled([
        service.install(source, { kind: "root" }),
        service.install(source, { kind: "root" }),
      ]);
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "fulfilled" }),
          expect.objectContaining({
            status: "rejected",
            reason: expect.objectContaining({
              message: expect.stringContaining("bb plugin update concurrent"),
            }),
          }),
        ]),
      );
      expect(materializationCount).toBe(1);
      expect(listPluginArtifacts(db, "concurrent")).toHaveLength(1);
    });

    it("refuses a managed reinstall and points to the update command", async () => {
      const repoDir = join(workDir, "repo-refresh");
      await writePluginFixture(repoDir, { name: "bb-plugin-fresh" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "v0.1.0");
      const source = `git:${repoDir}@main`;
      const first = await service.install(source, { kind: "root" });
      expect(first.version).toBe("0.1.0");

      await writePluginFixture(repoDir, {
        name: "bb-plugin-fresh",
        version: "0.2.0",
      });
      await commitAll(repoDir, "v0.2.0");
      await expect(service.install(source, { kind: "root" })).rejects.toThrow(
        "bb plugin update fresh",
      );
      expect(
        service.list().find((plugin) => plugin.id === "fresh"),
      ).toMatchObject({ version: "0.1.0", status: "running" });
    });

    it("refuses a managed frontend reinstall before validating a broken new tip or creating an artifact", async () => {
      const repoDir = join(workDir, "repo-managed-frontend");
      await writePluginFixture(repoDir, {
        name: "bb-plugin-managed-frontend",
        appSource:
          'export default function App() { return <div className="line-clamp-2">working</div>; }\n',
      });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "working frontend");
      const source = `git:${repoDir}@main`;
      const first = await service.install(source, { kind: "root" });
      expect(first).toMatchObject({
        id: "managed-frontend",
        version: "0.1.0",
        status: "running",
      });
      const registrationBefore = getInstalledPluginRegistration(
        db,
        "managed-frontend",
      );
      const artifactsBefore = listPluginArtifacts(db, "managed-frontend");
      expect(artifactsBefore).toHaveLength(1);

      await writePluginFixture(repoDir, {
        name: "bb-plugin-managed-frontend",
        version: "0.2.0",
        appSource: "export default function App( {\n",
      });
      await commitAll(repoDir, "broken frontend");

      await expect(service.install(source, { kind: "root" })).rejects.toThrow(
        "bb plugin update managed-frontend",
      );
      expect(getInstalledPluginRegistration(db, "managed-frontend")).toEqual(
        registrationBefore,
      );
      expect(listPluginArtifacts(db, "managed-frontend")).toEqual(
        artifactsBefore,
      );
      expect(
        service.list().find((plugin) => plugin.id === "managed-frontend"),
      ).toMatchObject({ version: "0.1.0", status: "running" });
    }, 120_000);

    it("keeps the previous install intact when a reinstall fails validation", async () => {
      const repoDir = join(workDir, "repo-sturdy");
      await writePluginFixture(repoDir, { name: "bb-plugin-sturdy" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "v1");
      const source = `git:${repoDir}@main`;
      const first = await service.install(source, { kind: "root" });
      expect(first.status).toBe("running");

      await writeFile(join(repoDir, "package.json"), "{ not json");
      await commitAll(repoDir, "broken manifest");
      await expect(
        service.install(source, { kind: "root" }),
      ).rejects.toThrowError();

      await stat(join(first.rootDir, "package.json"));
      await service.reload("sturdy");
      const entry = service.list().find((p) => p.id === "sturdy");
      expect(entry?.status).toBe("running");
      expect(entry?.version).toBe("0.1.0");
    });

    it("rebuilds a git plugin's server bundle over any committed dist", async () => {
      const identityRepo = join(workDir, "repo-artifact-identity");
      await writePluginFixture(identityRepo, {
        name: "bb-plugin-artifact-identity",
      });
      await mkdir(join(identityRepo, "dist"), { recursive: true });
      await writeFile(
        join(identityRepo, "dist", "server.meta.json"),
        artifactMeta({ pluginId: "wrong-plugin-id" }),
      );
      await initGitRepo(identityRepo);
      await commitAll(identityRepo, "mismatched artifact identity");

      const entry = await service.install(`git:${identityRepo}@main`, {
        kind: "root",
      });
      expect(entry.status).toBe("running");
      const meta: unknown = JSON.parse(
        await readFile(join(entry.rootDir, "dist", "server.meta.json"), "utf8"),
      );
      expect(meta).toMatchObject({
        pluginId: "artifact-identity",
        sdkVersion: PLUGIN_SDK_VERSION,
        artifactFormatVersion: 1,
      });
    });

    it("hard-fails install on an engines.bb mismatch and cleans up the clone", async () => {
      const repoDir = join(workDir, "repo-too-new");
      await writePluginFixture(repoDir, {
        name: "bb-plugin-too-new",
        engines: ">=99.0.0",
      });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");

      const source = `git:${repoDir}@main`;
      await expect(
        service.install(source, { kind: "root" }),
      ).rejects.toThrowError(/install refused.*requires bb >=99\.0\.0/);
      expect(service.list()).toHaveLength(0);
      const managed = join(
        dataDir,
        "plugins",
        "git",
        "local",
        ...repoDir.replace(/^\/+/, "").split("/"),
      );
      await expect(stat(`${managed}@main`)).rejects.toThrowError();
    });

    it("hard-fails managed install on an engines.bbPluginSdk mismatch", async () => {
      const repoDir = join(workDir, "repo-sdk-too-new");
      await writePluginFixture(repoDir, {
        name: "bb-plugin-sdk-too-new",
        pluginSdkRange: ">=99.0.0",
      });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");

      await expect(
        service.install(`git:${repoDir}@main`, { kind: "root" }),
      ).rejects.toThrowError(
        new RegExp(
          `install refused.*requires bb plugin SDK >=99\\.0\\.0, running SDK is ${PLUGIN_SDK_VERSION.replaceAll(".", "\\.")}`,
        ),
      );
    });

    it("remove retains immutable git artifacts and never touches a path source", async () => {
      const repoDir = join(workDir, "repo-rm");
      await writePluginFixture(repoDir, { name: "bb-plugin-managed" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");
      const managedEntry = await service.install(`git:${repoDir}@main`, {
        kind: "root",
      });

      const pathDir = join(workDir, "local-plugin");
      await writePluginFixture(pathDir, { name: "bb-plugin-localdir" });
      await service.install(pathDir, { kind: "root" });

      expect(await service.remove("managed")).toBe(true);
      await stat(managedEntry.rootDir);
      await stat(join(repoDir, "package.json"));

      expect(await service.remove("localdir")).toBe(true);
      await stat(join(pathDir, "package.json"));
    });

    it("refuses a cached artifact whose engine range no longer matches", async () => {
      const repoDir = join(workDir, "repo-cached-engine");
      await writePluginFixture(repoDir, {
        name: "bb-plugin-cached-engine",
        engines: ">=0.9.0",
      });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");
      const source = `git:${repoDir}@main`;

      await service.install(source, { kind: "root" });
      expect(await service.remove("cached-engine")).toBe(true);
      const clonesBefore = materializationCount;
      await service.stop();

      service = createPluginService({
        aiServices: createAiServiceRegistry(),
        telemetry: createNoopTelemetryService(),
        db,
        hub: {
          getDaemonSessionIdForHost: () => null,
          notifyPluginSignal: () => 0,
          notifySystem: () => {},
        },
        logger,
        dataDir,
        appVersion: "0.5.0",
        loadTimeoutMs: 2000,
        onArtifactMaterialize: () => {
          materializationCount += 1;
        },
      });

      await expect(
        service.install(source, { kind: "root" }),
      ).rejects.toThrowError(/install refused.*requires bb >=0\.9\.0/u);
      expect(materializationCount).toBe(clonesBefore);
      expect(
        getInstalledPluginRegistration(db, "cached-engine"),
      ).toBeUndefined();
    });

    it("refuses a git url without the git binary being asked to run arbitrary flags", async () => {
      await expect(
        service.install("git:@main", { kind: "root" }),
      ).rejects.toThrowError();
    });

    it("builds both bundles for a git plugin", async () => {
      const repoDir = join(workDir, "repo-selfcontained");
      await writePluginFixture(repoDir, { name: "bb-plugin-selfcontained" });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");

      const entry = await service.install(`git:${repoDir}@main`, {
        kind: "root",
      });
      expect(entry.status).toBe("running");
      await stat(join(entry.rootDir, "dist", "server.js"));
      await stat(join(entry.rootDir, "dist", "server.meta.json"));
    });

    it.runIf(hasNpm)(
      "builds a Git host entry without installing the SDK at runtime",
      async () => {
        const repoDir = join(workDir, "repo-host-with-dev-sdk-omitted");
        await writePluginFixture(repoDir, {
          name: "bb-plugin-host-with-dev-sdk-omitted",
          devDependencies: {
            "@get-bb/plugin-sdk": "file:./sdk-type-fixture",
          },
          hostSource: `
            import { defineRpcContract } from "@get-bb/plugin-sdk";
            import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
            const schema = { "~standard": { validate(value) { return { value }; } } };
            const contract = defineRpcContract({ echo: { input: schema, output: schema } });
            export default experimental_defineHostEntry({
              contract,
              handlers: { echo: (input) => input },
            });
          `,
        });
        await mkdir(join(repoDir, "sdk-type-fixture"), { recursive: true });
        await writeFile(
          join(repoDir, "sdk-type-fixture", "package.json"),
          JSON.stringify({
            name: "@get-bb/plugin-sdk",
            version: "0.0.0-test",
            private: true,
          }),
        );
        await initGitRepo(repoDir);
        await commitAll(repoDir, "init");

        const entry = await service.install(`git:${repoDir}@main`, {
          kind: "root",
        });

        expect(entry.status).toBe("running");
        const bundle = await readFile(
          join(entry.rootDir, "dist", "host.js"),
          "utf8",
        );
        expect(bundle).not.toMatch(/from\s+["']@get-bb\/plugin-sdk/u);
        await stat(join(entry.rootDir, "dist", "host.meta.json"));
        await expect(
          stat(join(entry.rootDir, "node_modules", "@get-bb", "plugin-sdk")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it("restores a target moved aside by an interrupted promotion", async () => {
      const repoDir = join(workDir, "repo-interrupted-promotion");
      await writePluginFixture(repoDir, {
        name: "bb-plugin-interrupted-promotion",
      });
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");
      const entry = await service.install(`git:${repoDir}@main`, {
        kind: "root",
      });
      const artifact = listPluginArtifacts(db, entry.id)[0];
      if (artifact === undefined) throw new Error("missing plugin artifact");

      await service.stop();
      db.$client
        .prepare(
          "UPDATE plugin_artifacts SET validation_result = 'pending', validated_at = NULL WHERE id = ?",
        )
        .run(artifact.id);
      await rename(entry.rootDir, `${entry.rootDir}.corrupt`);
      await mkdir(`${entry.rootDir}.promoting`, { recursive: true });
      await writeFile(join(`${entry.rootDir}.promoting`, "partial"), "copy");
      service = createPluginService({
        aiServices: createAiServiceRegistry(),
        telemetry: createNoopTelemetryService(),
        db,
        hub: {
          getDaemonSessionIdForHost: () => null,
          notifyPluginSignal: () => 0,
          notifySystem: () => {},
        },
        logger,
        dataDir,
        appVersion: "0.9.0",
        loadTimeoutMs: 2000,
      });

      await service.start();

      await stat(join(entry.rootDir, "dist", "server.js"));
      await expect(stat(`${entry.rootDir}.corrupt`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(`${entry.rootDir}.promoting`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        service.list().find((plugin) => plugin.id === "interrupted-promotion"),
      ).toMatchObject({ id: "interrupted-promotion", status: "running" });
    }, 60_000);

    it("ignores a repository .npmrc when installing dependencies", async () => {
      const repoDir = join(workDir, "repo-npmrc");
      await writePluginFixture(repoDir, { name: "bb-plugin-npmrc" });
      await writeFile(
        join(repoDir, ".npmrc"),
        "registry=http://127.0.0.1:1/evil\nstrict-ssl=false\n",
      );
      await initGitRepo(repoDir);
      await commitAll(repoDir, "init");

      const entry = await service.install(`git:${repoDir}@main`, {
        kind: "root",
      });

      expect(entry.status).toBe("running");
      await expect(stat(join(entry.rootDir, ".npmrc"))).rejects.toThrowError();
    });

    it.runIf(hasNpm)(
      "inlines a git plugin's third-party dependency into its bundles",
      async () => {
        const depDir = join(workDir, "dep-package");
        await mkdir(depDir, { recursive: true });
        await writeFile(
          join(depDir, "package.json"),
          JSON.stringify({
            name: "bb-test-greeter",
            version: "1.0.0",
            main: "index.js",
          }),
        );
        await writeFile(
          join(depDir, "index.js"),
          "module.exports.greet = () => 'hello from the dependency';",
        );

        const repoDir = join(workDir, "repo-with-deps");
        await writePluginFixture(repoDir, { name: "bb-plugin-withdeps" });
        const manifestPath = join(repoDir, "package.json");
        const manifest: unknown = JSON.parse(
          await readFile(manifestPath, "utf8"),
        );
        await writeFile(
          manifestPath,
          JSON.stringify({
            ...(manifest as Record<string, unknown>),
            dependencies: { "bb-test-greeter": `file:${depDir}` },
          }),
        );
        await writeFile(
          join(repoDir, "server.ts"),
          `import { greet } from "bb-test-greeter";\n` +
            `export default function plugin(bb: any) { bb.log.info(greet()); }`,
        );
        await initGitRepo(repoDir);
        await commitAll(repoDir, "init");

        const entry = await service.install(`git:${repoDir}@main`, {
          kind: "root",
        });
        expect(entry.status).toBe("running");
        const bundle = await readFile(
          join(entry.rootDir, "dist", "server.js"),
          "utf8",
        );
        expect(bundle).toContain("hello from the dependency");
        await stat(join(entry.rootDir, "node_modules"));
      },
    );
  });

  describe.skipIf(!hasGit)(
    "multi-plugin repositories",
    { timeout: 60_000 },
    () => {
      async function writeCollectionRepo(repoDir: string): Promise<string> {
        await writePluginFixture(join(repoDir, "plugins", "alpha"), {
          name: "bb-plugin-collection-alpha",
        });
        await writePluginFixture(join(repoDir, "plugins", "beta"), {
          name: "bb-plugin-collection-beta",
        });
        await mkdir(join(repoDir, ".bb"), { recursive: true });
        await writeFile(
          join(repoDir, ".bb", "plugins.json"),
          JSON.stringify({
            schemaVersion: 1,
            name: "collection",
            plugins: [
              { name: "alpha", source: "./plugins/alpha" },
              { name: "beta", source: "./plugins/beta" },
            ],
          }),
        );
        await initGitRepo(repoDir);
        return commitAll(repoDir, "init");
      }

      it("installs two plugins of one repository into one shared checkout", async () => {
        const repoDir = join(workDir, "repo-collection");
        const commit = await writeCollectionRepo(repoDir);

        const alpha = await service.install(`git:${repoDir}@main`, {
          kind: "entry",
          name: "alpha",
        });
        const alphaBundle = await readFile(
          join(alpha.rootDir, "dist", "server.js"),
          "utf8",
        );
        const beta = await service.install(`git:${repoDir}@main`, {
          kind: "subdirectory",
          path: "./plugins/beta",
        });

        expect(alpha.status).toBe("running");
        expect(beta.status).toBe("running");
        const checkout = gitArtifactCacheDir(
          dataDir,
          `local${repoDir}`,
          commit,
        );
        expect(alpha.rootDir).toBe(join(checkout, "plugins", "alpha"));
        expect(beta.rootDir).toBe(join(checkout, "plugins", "beta"));
        expect(
          getInstalledPluginRegistration(db, "collection-alpha"),
        ).toMatchObject({
          sourceKind: "git",
          sourceGitUrl: repoDir,
          sourceGitSubdirectory: "plugins/alpha",
          gitResolvedCommit: commit,
        });
        expect(
          getInstalledPluginRegistration(db, "collection-beta"),
        ).toMatchObject({ sourceGitSubdirectory: "plugins/beta" });
        expect(
          await readFile(join(alpha.rootDir, "dist", "server.js"), "utf8"),
        ).toBe(alphaBundle);
        expect(listPluginArtifacts(db, "collection-alpha")).toHaveLength(1);
      });

      it("promotes an in-repository symlinked plugin after a sibling", async () => {
        const repoDir = join(workDir, "repo-collection-symlinked-entry");
        await writePluginFixture(join(repoDir, "plugins", "actual"), {
          name: "bb-plugin-collection-linked",
        });
        await writePluginFixture(join(repoDir, "plugins", "sibling"), {
          name: "bb-plugin-collection-sibling",
        });
        await symlink("actual", join(repoDir, "plugins", "linked"));
        await mkdir(join(repoDir, ".bb"), { recursive: true });
        await writeFile(
          join(repoDir, ".bb", "plugins.json"),
          JSON.stringify({
            schemaVersion: 1,
            name: "collection",
            plugins: [
              { name: "linked", source: "./plugins/linked" },
              { name: "sibling", source: "./plugins/sibling" },
            ],
          }),
        );
        await initGitRepo(repoDir);
        await commitAll(repoDir, "init");

        await service.install(`git:${repoDir}@main`, {
          kind: "entry",
          name: "sibling",
        });
        const linked = await service.install(`git:${repoDir}@main`, {
          kind: "entry",
          name: "linked",
        });

        expect(linked.status).toBe("running");
        await stat(join(linked.rootDir, "dist", "server.js"));
      });

      it("keeps a nested sibling intact when the repository root installs too", async () => {
        const repoDir = join(workDir, "repo-collection-root");
        await writePluginFixture(join(repoDir, "plugins", "alpha"), {
          name: "bb-plugin-collection-alpha",
        });
        await writePluginFixture(repoDir, { name: "bb-plugin-collection-top" });
        await initGitRepo(repoDir);
        await commitAll(repoDir, "init");

        const alpha = await service.install(`git:${repoDir}@main`, {
          kind: "subdirectory",
          path: "./plugins/alpha",
        });
        const alphaBundle = await readFile(
          join(alpha.rootDir, "dist", "server.js"),
          "utf8",
        );
        const top = await service.install(`git:${repoDir}@main`, {
          kind: "root",
        });

        expect(top.status).toBe("running");
        expect(
          await readFile(join(alpha.rootDir, "dist", "server.js"), "utf8"),
        ).toBe(alphaBundle);
        await stat(join(top.rootDir, "dist", "server.js"));
        expect(
          service
            .list()
            .filter((plugin) => plugin.id.startsWith("collection-"))
            .map((plugin) => plugin.status),
        ).toEqual(["running", "running"]);
      });

      it("refreshes a root artifact hash after a nested install", async () => {
        const repoDir = join(workDir, "repo-collection-root-first");
        await writePluginFixture(join(repoDir, "plugins", "alpha"), {
          name: "bb-plugin-collection-root-first-alpha",
        });
        await writePluginFixture(repoDir, {
          name: "bb-plugin-collection-root-first-top",
        });
        await initGitRepo(repoDir);
        await commitAll(repoDir, "init");

        const top = await service.install(`git:${repoDir}@main`, {
          kind: "root",
        });
        await service.install(`git:${repoDir}@main`, {
          kind: "subdirectory",
          path: "plugins/alpha",
        });

        expect(listPluginArtifacts(db, top.id)).toMatchObject([
          { contentHash: await hashInstallDir(top.rootDir) },
        ]);
      });

      it("keeps a symlinked nested plugin when the repository root installs", async () => {
        const repoDir = join(workDir, "repo-collection-root-symlink");
        await writePluginFixture(join(repoDir, "plugins", "actual"), {
          name: "bb-plugin-collection-linked-root",
        });
        await symlink("actual", join(repoDir, "plugins", "linked"));
        await writePluginFixture(repoDir, {
          name: "bb-plugin-collection-top-linked",
        });
        await initGitRepo(repoDir);
        await commitAll(repoDir, "init");

        const linked = await service.install(`git:${repoDir}@main`, {
          kind: "subdirectory",
          path: "plugins/linked",
        });
        await stat(join(linked.rootDir, "dist", "server.js"));
        const top = await service.install(`git:${repoDir}@main`, {
          kind: "root",
        });

        expect(top.status).toBe("running");
        await stat(join(linked.rootDir, "dist", "server.js"));
        expect(
          service
            .list()
            .filter((plugin) => plugin.id.includes("collection-"))
            .map((plugin) => plugin.status),
        ).toEqual(["running", "running"]);
      });

      it("reinstalls a nested plugin whose directory was collected", async () => {
        const repoDir = join(workDir, "repo-collection-recollected");
        const commit = await writeCollectionRepo(repoDir);
        const alpha = await service.install(`git:${repoDir}@main`, {
          kind: "entry",
          name: "alpha",
        });
        expect(await service.remove("collection-alpha")).toBe(true);
        const checkout = gitArtifactCacheDir(
          dataDir,
          `local${repoDir}`,
          commit,
        );
        await rm(join(checkout, "plugins"), { recursive: true, force: true });

        const again = await service.install(`git:${repoDir}@main`, {
          kind: "entry",
          name: "alpha",
        });
        expect(again.status).toBe("running");
        expect(again.rootDir).toBe(alpha.rootDir);
        await stat(join(again.rootDir, "dist", "server.js"));
      });

      it("lists the collection entries when no plugin is selected", async () => {
        const repoDir = join(workDir, "repo-collection-unselected");
        await writeCollectionRepo(repoDir);

        await expect(
          service.install(`git:${repoDir}@main`, { kind: "root" }),
        ).rejects.toThrowError(/--plugin <name> \(alpha, beta\)/);
      });

      it("refuses an unknown entry name and an escaping subdirectory", async () => {
        const repoDir = join(workDir, "repo-collection-bad-selection");
        await writeCollectionRepo(repoDir);

        await expect(
          service.install(`git:${repoDir}@main`, {
            kind: "entry",
            name: "gamma",
          }),
        ).rejects.toThrowError(/no plugin "gamma" — available: alpha, beta/);
        await expect(
          service.install(`git:${repoDir}@main`, {
            kind: "subdirectory",
            path: "../../etc",
          }),
        ).rejects.toThrowError(/invalid plugin subdirectory/);
      });

      it("installs a collection entry from a local path repository", async () => {
        const repoDir = join(workDir, "repo-collection-path");
        await writeCollectionRepo(repoDir);

        const entry = await service.install(`path:${repoDir}`, {
          kind: "entry",
          name: "beta",
        });

        const betaRoot = await realpath(join(repoDir, "plugins", "beta"));
        expect(entry.rootDir).toBe(betaRoot);
        expect(
          getInstalledPluginRegistration(db, "collection-beta"),
        ).toMatchObject({
          sourceKind: "path",
          sourcePath: betaRoot,
        });
      });

      it("refuses a collection entry whose directory leaves the repository", async () => {
        const outsideDir = join(workDir, "outside-plugin");
        await writePluginFixture(outsideDir, { name: "bb-plugin-outside" });
        const repoDir = join(workDir, "repo-collection-symlink");
        await mkdir(join(repoDir, "plugins"), { recursive: true });
        await mkdir(join(repoDir, ".bb"), { recursive: true });
        await writeFile(
          join(repoDir, ".bb", "plugins.json"),
          JSON.stringify({
            schemaVersion: 1,
            name: "collection",
            plugins: [{ name: "escape", source: "./plugins/escape" }],
          }),
        );
        await symlink(outsideDir, join(repoDir, "plugins", "escape"));

        await expect(
          service.install(`path:${repoDir}`, { kind: "entry", name: "escape" }),
        ).rejects.toThrowError(/resolves outside its root/);
      });

      it("refuses a collection entry symlinked to the repository root", async () => {
        const repoDir = join(workDir, "repo-collection-root-link");
        await writePluginFixture(repoDir, {
          name: "bb-plugin-collection-root-link",
        });
        await mkdir(join(repoDir, "plugins"), { recursive: true });
        await mkdir(join(repoDir, ".bb"), { recursive: true });
        await writeFile(
          join(repoDir, ".bb", "plugins.json"),
          JSON.stringify({
            schemaVersion: 1,
            name: "collection",
            plugins: [{ name: "root-link", source: "./plugins/root-link" }],
          }),
        );
        await symlink("..", join(repoDir, "plugins", "root-link"));

        await expect(
          service.install(`path:${repoDir}`, {
            kind: "entry",
            name: "root-link",
          }),
        ).rejects.toThrowError(/resolves to its root/);
      });
    },
  );

  describe("plugin artifact metadata validation", () => {
    it("rejects an artifact whose pluginId does not match the manifest", () => {
      expect(
        validatePluginArtifactMeta({
          artifact: "server",
          raw: artifactMeta({ pluginId: "wrong-plugin-id" }),
          pluginId: "artifact-identity",
          pluginVersion: "0.1.0",
        }),
      ).toMatch(
        /server artifact pluginId "wrong-plugin-id" does not match manifest pluginId "artifact-identity"/,
      );
    });

    it("rejects an unknown artifactFormatVersion", () => {
      expect(
        validatePluginArtifactMeta({
          artifact: "server",
          raw: artifactMeta({
            artifactFormatVersion: 2,
            pluginId: "artifact-format",
          }),
          pluginId: "artifact-format",
          pluginVersion: "0.1.0",
        }),
      ).toMatch(/unknown artifactFormatVersion 2.*supported value is 1/);
    });

    it("accepts metadata that matches the manifest and this SDK", () => {
      expect(
        validatePluginArtifactMeta({
          artifact: "server",
          raw: artifactMeta({ pluginId: "artifact-ok" }),
          pluginId: "artifact-ok",
          pluginVersion: "0.1.0",
        }),
      ).toBeNull();
    });
  });

  it("keeps path installs developer-friendly while surfacing SDK incompatibility", async () => {
    const rootDir = join(workDir, "local-sdk-mismatch");
    await writePluginFixture(rootDir, {
      name: "bb-plugin-local-sdk-mismatch",
      pluginSdkRange: ">=99.0.0",
    });

    const entry = await service.installPath(rootDir);
    expect(entry.status).toBe("incompatible");
    expect(entry.statusDetail).toContain(
      `requires bb plugin SDK >=99.0.0, running SDK is ${PLUGIN_SDK_VERSION}`,
    );
  });

  it("registers a path install with stale backend artifact metadata", async () => {
    const rootDir = join(workDir, "local-stale-server-meta");
    const incompatibleMajor = PLUGIN_SDK_MAJOR + 1;
    await writePluginFixture(rootDir, {
      name: "bb-plugin-local-stale-server-meta",
    });
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(
      join(rootDir, "dist", "server.meta.json"),
      artifactMeta({
        pluginId: "local-stale-server-meta",
        sdkMajor: incompatibleMajor,
        sdkVersion: `${incompatibleMajor}.0.0`,
      }),
    );

    const entry = await service.installPath(rootDir);
    expect(entry).toMatchObject({
      id: "local-stale-server-meta",
      status: "running",
      statusDetail: null,
    });
  });

  describe.skipIf(!hasNpm)("npm sources", () => {
    it(
      "installs a scoped package into the immutable cache and retains it on removal",
      { timeout: 120_000 },
      async () => {
        const name = "@acme/bb-plugin-npmhero";
        const version = "0.1.0";
        const fixtureDir = join(workDir, "npm-fixture");
        await writePluginFixture(fixtureDir, { name, version });
        const packDir = join(workDir, "npm-pack");
        await mkdir(packDir, { recursive: true });
        await run("npm", ["pack", "--pack-destination", packDir], {
          cwd: fixtureDir,
        });
        const [tarballName] = await readdir(packDir);
        if (tarballName === undefined)
          throw new Error("npm pack produced no tarball");
        const tarball = await readFile(join(packDir, tarballName));
        let tarballRequests = 0;

        const registry = await new Promise<Server>((resolvePromise) => {
          const server = createServer((request, response) => {
            const url = request.url ?? "";
            if (url === "/package.tgz") {
              tarballRequests += 1;
              response.writeHead(200, {
                "content-type": "application/octet-stream",
              });
              response.end(tarball);
              return;
            }
            if (decodeURIComponent(url) === `/${name}`) {
              const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  name,
                  "dist-tags": { latest: version },
                  versions: {
                    [version]: {
                      name,
                      version,
                      dist: {
                        tarball: `${origin}/package.tgz`,
                        shasum: createHash("sha1")
                          .update(tarball)
                          .digest("hex"),
                        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
                      },
                    },
                  },
                }),
              );
              return;
            }
            response.writeHead(404);
            response.end();
          });
          server.listen(0, "127.0.0.1", () => resolvePromise(server));
        });
        const port = (registry.address() as AddressInfo).port;
        const previousCache = process.env.npm_config_cache;
        const previousPackageLock = process.env.npm_config_package_lock;
        const previousUserConfig = process.env.NPM_CONFIG_USERCONFIG;
        const userConfig = join(workDir, "npmrc");
        await writeFile(
          userConfig,
          `@acme:registry=http://127.0.0.1:${port}\nregistry=https://registry.npmjs.org\n`,
        );
        process.env.NPM_CONFIG_USERCONFIG = userConfig;
        process.env.npm_config_cache = join(workDir, "npm-cache");
        process.env.npm_config_package_lock = "false";
        try {
          const source = `npm:${name}@${version}`;
          const entry = await service.install(source, { kind: "root" });
          expect(tarballRequests).toBe(1);
          expect(entry.id).toBe("npmhero");
          expect(entry.status).toBe("running");
          expect(entry.source).toBe(source);
          const prefix = join(
            dataDir,
            "plugins",
            "cache",
            "npm",
            ...name.split("/"),
            version,
          );
          expect(entry.rootDir).toBe(join(prefix, "node_modules", name));
          await expect(
            stat(join(prefix, "package-lock.json")),
          ).rejects.toThrow();
          expect(getInstalledPluginRegistration(db, "npmhero")).toMatchObject({
            provenance: "direct",
            sourceKind: "npm",
            sourceNpmPackage: name,
            sourceNpmRegistry: `http://127.0.0.1:${port}`,
            sourceNpmRequestedSpec: version,
            sourceNpmSpecKind: "exact",
            npmResolvedVersion: version,
            npmIntegrity: expect.stringMatching(/^sha512-/),
            activeArtifactId: expect.any(String),
          });

          await expect(service.applyUpdate("npmhero")).resolves.toMatchObject({
            ok: false,
            error: expect.stringContaining("pinned by its source intent"),
          });
          expect(tarballRequests).toBe(1);
          expect(getInstalledPluginRegistration(db, "npmhero")).toMatchObject({
            source,
            sourceNpmRequestedSpec: version,
            sourceNpmSpecKind: "exact",
            rootDir: join(prefix, "node_modules", name),
          });
          await stat(prefix);

          expect(await service.remove("npmhero")).toBe(true);
          await stat(prefix);
          expect(listPluginArtifacts(db, "npmhero")).toHaveLength(1);
        } finally {
          if (previousCache === undefined) {
            delete process.env.npm_config_cache;
          } else {
            process.env.npm_config_cache = previousCache;
          }
          if (previousPackageLock === undefined) {
            delete process.env.npm_config_package_lock;
          } else {
            process.env.npm_config_package_lock = previousPackageLock;
          }
          if (previousUserConfig === undefined) {
            delete process.env.NPM_CONFIG_USERCONFIG;
          } else {
            process.env.NPM_CONFIG_USERCONFIG = previousUserConfig;
          }
          await new Promise<void>((resolvePromise) =>
            registry.close(() => resolvePromise()),
          );
        }
      },
    );
  });

  it("refuses an npm package whose derived id shadows a builtin before install", async () => {
    await expect(
      service.install("npm:bb-plugin-connect@1.2.3", { kind: "root" }),
    ).rejects.toThrowError(/reserved by the bundled plugin.*builtin:connect/);
    expect(getInstalledPluginRegistration(db, "connect")).toBeUndefined();
  });

  it("refuses a path plugin whose manifest id shadows a builtin", async () => {
    const rootDir = join(workDir, "bb-plugin-connect");
    await writePluginFixture(rootDir, { name: "bb-plugin-connect" });
    await expect(service.installPath(rootDir)).rejects.toThrowError(
      /reserved by the bundled plugin.*builtin:connect/,
    );
    expect(getInstalledPluginRegistration(db, "connect")).toBeUndefined();
  });

  it("the bb plugin new scaffold installs and loads through the plugin service", async () => {
    const targetDir = join(workDir, "bb-plugin-scaffolded");
    await scaffoldPlugin({
      targetDir,
      packageName: "bb-plugin-scaffolded",
      bbVersion: "0.9.0",
    });
    await stat(join(targetDir, "skills", "example-todos", "SKILL.md"));
    await stat(join(targetDir, ".gitignore"));
    await stat(join(targetDir, "README.md"));
    await linkScaffoldDependencies(targetDir);

    const entry = await service.install(`path:${targetDir}`, { kind: "root" });
    expect(entry.id).toBe("scaffolded");
    expect(entry.status).toBe("running");
    expect(entry.statusDetail).toBeNull();

    await expect(
      scaffoldPlugin({
        targetDir,
        packageName: "bb-plugin-scaffolded",
        bbVersion: "0.9.0",
      }),
    ).rejects.toThrowError(/already exists/);
  });
});
