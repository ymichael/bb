import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import parcelWatcher from "@parcel/watcher";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchWorkspaceStatus } from "../src/watch-status.js";
import type { WorkspaceStatusChangeEvent } from "../src/watch-status-types.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const realParcelSubscribe = parcelWatcher.subscribe.bind(parcelWatcher);

const NESTED_REPOS = 4;
const PACKAGES_PER_NESTED_REPO = 300;
const EVENT_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 60_000;
const MAX_EXPECTED_WATCHES = 20;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "BB Tests");
  await git(dir, "config", "user.email", "bb@example.com");
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-q", "-m", "init");
}

async function buildUmbrellaRoot(args: {
  gitRoot: boolean;
  nestedRepos?: number;
  packagesPerNestedRepo?: number;
}): Promise<{
  root: string;
  nestedDirCount: number;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-1779-umbrella-"));
  tempDirs.push(root);
  if (args.gitRoot) {
    await initRepo(root);
  }
  const nestedRepos = args.nestedRepos ?? NESTED_REPOS;
  const packagesPerNestedRepo =
    args.packagesPerNestedRepo ?? PACKAGES_PER_NESTED_REPO;
  let nestedDirCount = 0;
  for (let i = 0; i < nestedRepos; i += 1) {
    const child = path.join(root, "apps", `child-${i}`);
    await initRepo(child);
    await fs.writeFile(path.join(child, ".gitignore"), "node_modules/\n");
    await git(child, "add", ".gitignore");
    await git(child, "commit", "-q", "-m", "ignore node_modules");
    await Promise.all(
      Array.from({ length: packagesPerNestedRepo }, async (_unused, p) => {
        const pkgLib = path.join(child, "node_modules", `pkg-${p}`, "lib");
        await fs.mkdir(pkgLib, { recursive: true });
        await fs.writeFile(
          path.join(pkgLib, "index.js"),
          "module.exports={}\n",
        );
      }),
    );
    nestedDirCount += packagesPerNestedRepo * 2;
  }
  return { root, nestedDirCount };
}

function countInotifyWatches(): number {
  const fdinfoDir = "/proc/self/fdinfo";
  let count = 0;
  for (const fd of fsSync.readdirSync(fdinfoDir)) {
    try {
      const info = fsSync.readFileSync(path.join(fdinfoDir, fd), "utf8");
      count += info
        .split("\n")
        .filter((line) => line.startsWith("inotify wd:")).length;
    } catch {}
  }
  return count;
}

async function measureWorkspaceRootWatch(root: string): Promise<{
  ignore: string[] | undefined;
  watches: number;
}> {
  const seenOptions: Array<{ dir: string; ignore: string[] | undefined }> = [];
  vi.spyOn(parcelWatcher, "subscribe").mockImplementation(
    async (dir, cb, opts) => {
      seenOptions.push({ dir, ignore: opts?.ignore });
      return realParcelSubscribe(dir, cb, opts);
    },
  );
  const baselineWatches = countInotifyWatches();
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const stop = watchWorkspaceStatus(root, {
    onChange: () => undefined,
    onReady: () => ready(),
    onWatchError: () => undefined,
  });
  try {
    await readyPromise;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const realRoot = fsSync.realpathSync(root);
    const workspaceRootSubscribe = seenOptions.find(
      (o) => o.dir === root || o.dir === realRoot,
    );
    return {
      ignore: workspaceRootSubscribe?.ignore,
      watches: countInotifyWatches() - baselineWatches,
    };
  } finally {
    await stop();
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for workspace change events");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform !== "linux")(
  "workspace root watch ignores nested heavy directories (#1779)",
  () => {
    it(
      "does not watch nested node_modules or .git under a git umbrella root",
      async () => {
        const { root, nestedDirCount } = await buildUmbrellaRoot({
          gitRoot: true,
        });
        const { ignore, watches } = await measureWorkspaceRootWatch(root);
        expect(nestedDirCount).toBeGreaterThan(MAX_EXPECTED_WATCHES);
        expect(ignore).toContain(".git");
        expect(ignore).toContain("**/node_modules/**");
        expect(watches).toBeLessThan(MAX_EXPECTED_WATCHES);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "does not watch nested node_modules or .git under a non-git root",
      async () => {
        const { root, nestedDirCount } = await buildUmbrellaRoot({
          gitRoot: false,
        });
        const { ignore, watches } = await measureWorkspaceRootWatch(root);
        expect(nestedDirCount).toBeGreaterThan(MAX_EXPECTED_WATCHES);
        expect(ignore).not.toContain(".git");
        expect(ignore).toContain("**/node_modules/**");
        expect(watches).toBeLessThan(MAX_EXPECTED_WATCHES);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

describe("workspace root watch events inside nested heavy directories (#1779)", () => {
  it(
    "does not report changes inside nested node_modules or nested .git",
    async () => {
      const { root } = await buildUmbrellaRoot({
        gitRoot: true,
        nestedRepos: 1,
        packagesPerNestedRepo: 1,
      });
      const realRoot = fsSync.realpathSync(root);
      const nestedPackageFile = path.join(
        realRoot,
        "apps",
        "child-0",
        "node_modules",
        "pkg-0",
        "lib",
        "index.js",
      );
      const nestedGitFile = path.join(
        realRoot,
        "apps",
        "child-0",
        ".git",
        "bb-marker",
      );
      const visibleFile = path.join(realRoot, "apps", "child-0", "visible.txt");
      const events: WorkspaceStatusChangeEvent[] = [];
      let ready!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const stop = watchWorkspaceStatus(root, {
        onChange: (event) => {
          events.push(event);
        },
        onReady: () => ready(),
        onWatchError: () => undefined,
      });
      try {
        await readyPromise;
        await new Promise((resolve) => setTimeout(resolve, 300));

        await fs.writeFile(
          nestedPackageFile,
          "module.exports={changed:true}\n",
        );
        await fs.writeFile(nestedGitFile, "marker\n");
        await fs.writeFile(visibleFile, "visible\n");
        await waitFor(
          () =>
            events.some((event) => event.changedPaths.includes(visibleFile)),
          EVENT_TIMEOUT_MS,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));

        const changedPaths = events.flatMap((event) => event.changedPaths);
        expect(changedPaths).toContain(visibleFile);
        expect(changedPaths).not.toContain(nestedPackageFile);
        expect(changedPaths).not.toContain(nestedGitFile);
        expect(
          changedPaths.filter(
            (changedPath) =>
              changedPath.includes(`${path.sep}node_modules${path.sep}`) ||
              changedPath.includes(`${path.sep}.git${path.sep}`),
          ),
        ).toEqual([]);
      } finally {
        await stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
