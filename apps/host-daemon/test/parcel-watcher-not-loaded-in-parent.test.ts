import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "..", "..", "..");
const hostWatcherEntry = resolve(
  workspaceRoot,
  "packages",
  "host-watcher",
  "src",
  "index.ts",
);

const packageTmpDir = resolve(here, "..", ".tmp");
await mkdir(packageTmpDir, { recursive: true });
const outDir = await mkdtemp(join(packageTmpDir, "bb-1873-bundle-"));
const outfile = join(outDir, "host-watcher-bundle.mjs");

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function bundleHostWatcherLikeTheDaemon(): Promise<string> {
  await build({
    bundle: true,
    conditions: ["source"],
    entryPoints: [hostWatcherEntry],
    external: [
      "@parcel/watcher",
      "@parcel/watcher/*",
      "node-pty",
      "node-pty/*",
    ],
    format: "esm",
    legalComments: "none",
    minify: false,
    outfile,
    platform: "node",
    sourcemap: false,
    target: "node22",
  });
  return readFile(outfile, "utf8");
}

describe("daemon bundle keeps @parcel/watcher out of the parent process", () => {
  it("does not hoist a static import of @parcel/watcher", async () => {
    const bundle = await bundleHostWatcherLikeTheDaemon();
    const staticImports = bundle.match(
      /^import\s+[^;]*?\s+from\s*["']@parcel\/watcher["'];?$/gmu,
    );
    expect(
      staticImports,
      `static top-level import(s) of @parcel/watcher found in the bundle; ` +
        `watcher.node would load at daemon startup:\n${(staticImports ?? []).join("\n")}`,
    ).toBeNull();
    expect(bundle).toMatch(/import\(\s*["']@parcel\/watcher["']\s*\)/u);
  });

  it("does not dlopen a @parcel/watcher addon when the bundle is imported", async () => {
    await bundleHostWatcherLikeTheDaemon();
    const preload = join(outDir, "log-dlopen.cjs");
    await writeFile(
      preload,
      [
        "const orig = process.dlopen;",
        "process.dlopen = function (module, filename, flags) {",
        "  console.log(`[dlopen] ${filename}`);",
        "  return flags === undefined",
        "    ? orig.call(this, module, filename)",
        "    : orig.call(this, module, filename, flags);",
        "};",
        "",
      ].join("\n"),
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--require",
        preload,
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(outfile)}); console.log("[imported]");`,
      ],
      { cwd: workspaceRoot, env: { ...process.env, NODE_PATH: "" } },
    );
    expect(stdout).toContain("[imported]");
    const loadedAddons = stdout
      .split("\n")
      .filter((line) => line.startsWith("[dlopen] "));
    expect(
      loadedAddons.filter((line) => /@parcel[/+]watcher/u.test(line)),
      `@parcel/watcher addon loaded on import:\n${loadedAddons.join("\n")}`,
    ).toEqual([]);
  });
});
