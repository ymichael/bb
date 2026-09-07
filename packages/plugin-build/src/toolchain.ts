import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { omitNpmScriptPolicyEnv } from "@bb/process-utils";

const run = promisify(execFile);

export const NODE_ESM_REQUIRE_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "var __filename = __fileURLToPath(import.meta.url);",
  "var __dirname = __pathDirname(__filename);",
].join("\n");

export const PLUGIN_TOOLCHAIN_PINS = {
  esbuild: "0.28.1",
  "@tailwindcss/node": "4.3.0",
  "@tailwindcss/oxide": "4.3.0",
  tailwindcss: "4.3.0",
} as const;

export interface PluginBuildToolchain {
  esbuild: string;
  tailwindNode: string;
  tailwindOxide: string;
  tailwindCssDir: string;
}

function pinKey(): string {
  return Object.entries(PLUGIN_TOOLCHAIN_PINS)
    .map(([name, version]) => `${name}@${version}`)
    .sort()
    .join(",");
}

export function toolchainCacheDir(baseDir: string): string {
  const key = Object.values(PLUGIN_TOOLCHAIN_PINS).join("-");
  return join(baseDir, `toolchain-${key}`);
}

function packageDir(require: NodeRequire, name: string): string | null {
  let dir: string;
  try {
    dir = dirname(require.resolve(name));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { name?: unknown }).name === name
        ) {
          return dir;
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readVersion(require: NodeRequire, name: string): string | null {
  const dir = packageDir(require, name);
  if (dir === null) return null;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function toolchainFrom(require: NodeRequire): PluginBuildToolchain | null {
  for (const [name, pinned] of Object.entries(PLUGIN_TOOLCHAIN_PINS)) {
    if (readVersion(require, name) !== pinned) return null;
  }
  try {
    const tailwindCssDir = packageDir(require, "tailwindcss");
    if (tailwindCssDir === null) return null;
    return {
      esbuild: pathToFileURL(require.resolve("esbuild")).href,
      tailwindNode: pathToFileURL(require.resolve("@tailwindcss/node")).href,
      tailwindOxide: pathToFileURL(require.resolve("@tailwindcss/oxide")).href,
      tailwindCssDir,
    };
  } catch {
    return null;
  }
}

function resolveLocalToolchain(): PluginBuildToolchain | null {
  return toolchainFrom(createRequire(import.meta.url));
}

async function isInstalled(dir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(dir, ".bb-toolchain.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { pins?: unknown }).pins !== pinKey()
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return toolchainFrom(createRequire(join(dir, "noop.js"))) !== null;
}

export async function resolvePluginBuildToolchain(
  baseDir: string,
  options?: {
    onFetchStart?: () => void;
    onFetchDone?: (elapsedMs: number) => void;
    ignoreLocal?: boolean;
  },
): Promise<PluginBuildToolchain> {
  if (options?.ignoreLocal !== true) {
    const local = resolveLocalToolchain();
    if (local !== null) return local;
  }

  const dir = toolchainCacheDir(baseDir);
  if (await isInstalled(dir)) {
    const cached = toolchainFrom(createRequire(join(dir, "noop.js")));
    if (cached !== null) return cached;
  }

  options?.onFetchStart?.();
  const startedAt = Date.now();
  const staging = `${dir}.staging-${randomUUID()}`;
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify({ name: "bb-plugin-toolchain", private: true, version: "0.0.0" }, null, 2)}\n`,
    );
    await run(
      "npm",
      [
        "install",
        "--prefix",
        staging,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        ...Object.entries(PLUGIN_TOOLCHAIN_PINS).map(
          ([name, version]) => `${name}@${version}`,
        ),
      ],
      {
        maxBuffer: 1024 * 1024 * 16,
        env: omitNpmScriptPolicyEnv(process.env),
      },
    );
    const staged = toolchainFrom(createRequire(join(staging, "noop.js")));
    if (staged === null) {
      throw new Error(
        "the downloaded plugin build toolchain is incomplete or misversioned",
      );
    }
    await writeFile(
      join(staging, ".bb-toolchain.json"),
      `${JSON.stringify({ pins: pinKey() }, null, 2)}\n`,
    );
    await mkdir(dirname(dir), { recursive: true });
    try {
      await rename(staging, dir);
    } catch {
      if (!(await isInstalled(dir))) throw new Error(errorPromoting(dir));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const promoted = toolchainFrom(createRequire(join(dir, "noop.js")));
  if (promoted === null) throw new Error(errorPromoting(dir));
  options?.onFetchDone?.(Date.now() - startedAt);
  return promoted;
}

function errorPromoting(dir: string): string {
  return `could not install the plugin build toolchain into ${dir}`;
}
