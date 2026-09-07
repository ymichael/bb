import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBbAppArtifactService,
  resolveBbAppPackage,
  type BbAppArtifactCommandRunner,
} from "../../src/services/install/bb-app-artifact.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const ARTIFACT_LIFECYCLE_TIMEOUT_MS = 15_000;
const MODES = ["repo-src", "repo-dist", "packaged"] as const;
const packageJson = {
  name: "bb-app",
  version: "1.2.3-test",
  type: "module",
  os: ["darwin", "linux"],
  engines: { node: ">=22.19.0" },
  dependencies: {
    "@parcel/watcher": "2.5.6",
    "node-pty": "1.2.0-beta.15",
    pino: "9.6.0",
    "pino-pretty": "13.0.0",
    "pino-roll": "4.0.0",
  },
  bin: {
    bb: "dist/bb.js",
    "bb-app": "dist/bb-app.js",
    "bb-host-daemon": "dist/bb-host-daemon.js",
  },
  files: ["dist", "host-daemon", "README.md"],
};

type Mode = (typeof MODES)[number];

function isRepoMode(mode: Mode): boolean {
  return mode !== "packaged";
}

async function writeHostPackage(root: string, readme: string): Promise<void> {
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "host-daemon/dist/bb-chunks"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson));
  await writeFile(join(root, "dist/bb-app.js"), "#!/usr/bin/env node\n");
  await writeFile(
    join(root, "dist/bb-host-daemon.js"),
    "#!/usr/bin/env node\n",
  );
  await writeFile(join(root, "dist/bb.js"), "#!/usr/bin/env node\n");
  await writeFile(join(root, "README.md"), readme);
  for (const fileName of [
    "bb",
    "bb-parcel-watcher-child.mjs",
    "bb-plugin-host-worker.mjs",
    "bb-provider-bridge-worker.mjs",
    "daemon-bundle.mjs",
  ]) {
    await writeFile(join(root, "host-daemon/dist", fileName), fileName);
  }
  await writeFile(
    join(root, "host-daemon/dist/bb-chunks/chunk-TEST.js"),
    "export {};\n",
  );
}

async function fixture(mode: Mode) {
  const root = await mkdtemp(join(tmpdir(), `bb-artifact-${mode}-`));
  roots.push(root);
  const packageRoot = isRepoMode(mode) ? join(root, "packages/bb-app") : root;
  const serverEntry =
    mode === "repo-src"
      ? join(root, "apps/server/src/server.ts")
      : mode === "repo-dist"
        ? join(root, "apps/server/dist/server.js")
        : join(root, "server/dist/server.js");
  await mkdir(dirname(serverEntry), { recursive: true });
  await writeFile(serverEntry, "");
  await writeHostPackage(packageRoot, "fixture\n");
  await writeFile(join(packageRoot, "private.txt"), "must not ship\n");

  const refreshHostPackage = async (): Promise<void> => {
    if (!isRepoMode(mode)) return;
    await writeHostPackage(
      join(packageRoot, "host-package"),
      await readFile(join(packageRoot, "README.md"), "utf8"),
    );
  };
  await refreshHostPackage();
  return { packageRoot, refreshHostPackage, root, serverEntry };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("bb-app artifact service (desktop packaging)", () => {
  it(
    "packs the runtime when Electron Builder omits the README",
    async () => {
      const test = await fixture("packaged");
      await rm(join(test.packageRoot, "README.md"));
      const service = createBbAppArtifactService({
        dataDir: join(test.root, "data"),
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
      });

      await expect(service.getVersion()).resolves.toBe("1.2.3-test");
      const artifact = await service.getArtifact();
      const listing = (
        await execFileAsync("tar", ["-tzf", artifact.path])
      ).stdout.split("\n");
      expect(listing).toEqual(
        expect.arrayContaining([
          "package/package.json",
          "package/dist/bb-app.js",
          "package/dist/bb-host-daemon.js",
          "package/dist/bb.js",
          "package/host-daemon/dist/bb",
          "package/host-daemon/dist/bb-chunks/chunk-TEST.js",
          "package/host-daemon/dist/bb-parcel-watcher-child.mjs",
          "package/host-daemon/dist/bb-plugin-host-worker.mjs",
          "package/host-daemon/dist/bb-provider-bridge-worker.mjs",
          "package/host-daemon/dist/daemon-bundle.mjs",
        ]),
      );
      expect(listing).not.toContain("package/README.md");
      expect(listing).not.toContain("package/private.txt");
      expect(artifact.size).toBeGreaterThan(0);
      await expect(service.getArtifact()).resolves.toEqual(artifact);
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it("rejects missing runtime files even when the README is absent", async () => {
    const test = await fixture("packaged");
    const runtimePath = join(
      test.packageRoot,
      "host-daemon/dist/daemon-bundle.mjs",
    );
    await rm(join(test.packageRoot, "README.md"));
    await rm(runtimePath);
    const service = createBbAppArtifactService({
      dataDir: join(test.root, "data"),
      serverEntryUrl: pathToFileURL(test.serverEntry).href,
    });

    await expect(service.getArtifact()).rejects.toMatchObject({
      code: "ENOENT",
      path: runtimePath,
    });
  });

  it("propagates README copy failures other than a missing file", async () => {
    const test = await fixture("packaged");
    const readmePath = join(test.packageRoot, "README.md");
    await rm(readmePath);
    await mkdir(readmePath);
    const service = createBbAppArtifactService({
      dataDir: join(test.root, "data"),
      serverEntryUrl: pathToFileURL(test.serverEntry).href,
    });

    await expect(service.getArtifact()).rejects.toMatchObject({
      code: "EISDIR",
      path: readmePath,
    });
  });
});

describe.each(MODES)("bb-app artifact service (%s)", (mode) => {
  it(
    "packs only the enrolled host runtime as an exact-version npm package",
    async () => {
      const test = await fixture(mode);
      const calls: Array<{
        command: string;
        args: readonly string[];
        cwd: string;
      }> = [];
      const runner: BbAppArtifactCommandRunner = async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        if (command === "pnpm") {
          await test.refreshHostPackage();
          return "built";
        }
        return (await execFileAsync(command, [...args], { cwd })).stdout;
      };
      const resolved = await resolveBbAppPackage(
        pathToFileURL(test.serverEntry).href,
      );
      expect(resolved.root).toBe(test.packageRoot);
      expect(resolved.layout).toBe(isRepoMode(mode) ? "repo" : "packaged");
      const service = createBbAppArtifactService({
        dataDir: join(test.root, "data"),
        commandRunner: runner,
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
      });

      const artifact = await service.getArtifact();
      await expect(service.getVersion()).resolves.toBe("1.2.3-test");
      const listing = (
        await execFileAsync("tar", ["-tzf", artifact.path])
      ).stdout.split("\n");
      expect(listing).toContain("package/package.json");
      expect(listing).toContain("package/dist/bb-app.js");
      expect(listing).toContain("package/dist/bb.js");
      expect(listing).toContain("package/host-daemon/dist/daemon-bundle.mjs");
      expect(listing).toContain("package/host-daemon/dist/bb");
      expect(listing).not.toContain("package/private.txt");
      expect(listing.some((entry) => entry.startsWith("package/app/"))).toBe(
        false,
      );
      expect(listing.some((entry) => entry.startsWith("package/server/"))).toBe(
        false,
      );
      const packedPackageJson = JSON.parse(
        (
          await execFileAsync("tar", [
            "-xOzf",
            artifact.path,
            "package/package.json",
          ])
        ).stdout,
      );
      expect(packedPackageJson).toMatchObject({
        name: "bb-app",
        version: "1.2.3-test",
        bin: {
          bb: "dist/bb.js",
          "bb-app": "dist/bb-app.js",
          "bb-host-daemon": "dist/bb-host-daemon.js",
        },
      });
      expect(Object.keys(packedPackageJson.dependencies).sort()).toEqual([
        "@parcel/watcher",
        "node-pty",
        "pino",
        "pino-pretty",
        "pino-roll",
      ]);
      expect(artifact.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(artifact.path).toContain(artifact.digest);
      expect(artifact.size).toBeGreaterThan(0);
      expect(calls.filter((call) => call.command === "pnpm")).toHaveLength(
        isRepoMode(mode) ? 1 : 0,
      );
      await expect(service.getArtifact()).resolves.toEqual(artifact);
      expect(calls.filter((call) => call.command === "npm")).toHaveLength(1);
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "content-addresses rebuilds when package contents change",
    async () => {
      const test = await fixture(mode);
      const calls: Array<{ command: string }> = [];
      const runner: BbAppArtifactCommandRunner = async (command, args, cwd) => {
        calls.push({ command });
        if (command === "pnpm") {
          await test.refreshHostPackage();
          return "built";
        }
        return (await execFileAsync(command, [...args], { cwd })).stdout;
      };
      const options = {
        dataDir: join(test.root, "data"),
        commandRunner: runner,
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
        protocolVersion: 51,
      };

      const first = await createBbAppArtifactService(options).getArtifact();
      await writeFile(join(test.packageRoot, "README.md"), "updated\n");
      const second = await createBbAppArtifactService(options).getArtifact();

      expect(second.path).not.toBe(first.path);
      expect(second.digest).not.toBe(first.digest);
      expect(
        (
          await execFileAsync("tar", [
            "-xOzf",
            second.path,
            "package/README.md",
          ])
        ).stdout,
      ).toBe("updated\n");
      expect(calls.filter((call) => call.command === "npm")).toHaveLength(2);
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "separates protocol cache keys without changing identical content digests",
    async () => {
      const test = await fixture(mode);
      const runner: BbAppArtifactCommandRunner = async (command, args, cwd) => {
        if (command === "pnpm") {
          await test.refreshHostPackage();
          return "built";
        }
        return (await execFileAsync(command, [...args], { cwd })).stdout;
      };
      const baseOptions = {
        dataDir: join(test.root, "data"),
        commandRunner: runner,
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
      };

      const first = await createBbAppArtifactService({
        ...baseOptions,
        protocolVersion: 51,
      }).getArtifact();
      const second = await createBbAppArtifactService({
        ...baseOptions,
        protocolVersion: 52,
      }).getArtifact();

      expect(second.path).not.toBe(first.path);
      expect(second.digest).toBe(first.digest);
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "keeps the previous content-addressed artifact when a rebuild fails",
    async () => {
      const test = await fixture(mode);
      let failNextPack = false;
      const runner: BbAppArtifactCommandRunner = async (command, args, cwd) => {
        if (command === "pnpm") {
          await test.refreshHostPackage();
          return "built";
        }
        if (failNextPack) throw new Error("npm pack exploded");
        return (await execFileAsync(command, [...args], { cwd })).stdout;
      };
      const options = {
        dataDir: join(test.root, "data"),
        commandRunner: runner,
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
        protocolVersion: 51,
      };

      const first = await createBbAppArtifactService(options).getArtifact();
      failNextPack = true;
      await writeFile(join(test.packageRoot, "README.md"), "updated\n");
      const service = createBbAppArtifactService(options);
      await expect(service.getArtifact()).rejects.toThrow("npm pack exploded");
      expect(
        (await execFileAsync("tar", ["-xOzf", first.path, "package/README.md"]))
          .stdout,
      ).toBe("fixture\n");

      failNextPack = false;
      const second = await service.getArtifact();
      expect(second.path).not.toBe(first.path);
      expect(
        (
          await execFileAsync("tar", [
            "-xOzf",
            second.path,
            "package/README.md",
          ])
        ).stdout,
      ).toBe("updated\n");
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );
});
