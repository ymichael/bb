import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldPlugin } from "../src/plugin-scaffold.js";
import { PLUGIN_SHIMMED_TYPE_DEPENDENCIES } from "../src/generated/plugin-starter-files.generated.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const appRoot = join(repoRoot, "apps", "app");
const pluginSdkRoot = join(repoRoot, "packages", "plugin-sdk");

function workspacePackageRoot(name: string): string {
  for (const base of [appRoot, repoRoot, pluginSdkRoot]) {
    const candidate = join(base, "node_modules", name);
    try {
      readFileSync(join(candidate, "package.json"), "utf8");
      return candidate;
    } catch {}
  }
  throw new Error(`package not installed in the workspace: ${name}`);
}

async function installDeclaredDependencies(targetDir: string): Promise<void> {
  const manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"));
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  for (const name of names) {
    const target = join(targetDir, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    const source =
      name === "@get-bb/plugin-sdk"
        ? pluginSdkRoot
        : workspacePackageRoot(name);
    await symlink(source, target, "dir");
  }
}

async function runTsc(
  targetDir: string,
): Promise<{ ok: boolean; output: string }> {
  const tsc = join(workspacePackageRoot("typescript"), "lib", "tsc.js");
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsc, "--project", "tsconfig.json"],
      { cwd: targetDir },
    );
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
    };
  }
}

const SHIMMED_SPECIFIERS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  ...Object.keys(PLUGIN_SHIMMED_TYPE_DEPENDENCIES),
  "@pierre/diffs/react",
];

describe("scaffold typechecks the runtime-shimmed imports (#2072)", () => {
  let workDir: string;
  let targetDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bb-scaffold-shims-"));
    targetDir = join(workDir, "bb-plugin-toasty");
    await scaffoldPlugin({
      targetDir,
      packageName: "bb-plugin-toasty",
      bbVersion: "0.39.0",
    });
    await installDeclaredDependencies(targetDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('the documented `import { toast } from "sonner"` and every other shimmed specifier resolve', async () => {
    const appPath = join(targetDir, "app.tsx");
    const app = await readFile(appPath, "utf8");
    const firstImport = app.indexOf("\nimport ");
    expect(firstImport).toBeGreaterThan(-1);
    await writeFile(
      appPath,
      `${app.slice(0, firstImport + 1)}import { toast } from "sonner";\ntoast.success("hi");\n${app.slice(firstImport + 1)}`,
    );
    const lines = SHIMMED_SPECIFIERS.map(
      (specifier, i) => `import * as m${i} from "${specifier}";`,
    );
    lines.push(
      `export const all = [${SHIMMED_SPECIFIERS.map((_, i) => `m${i}`).join(", ")}];`,
    );
    await writeFile(
      join(targetDir, "components", "all-shims.ts"),
      `${lines.join("\n")}\n`,
    );

    const result = await runTsc(targetDir);

    const missing = [
      ...result.output.matchAll(/Cannot find module '([^']+)'/g),
    ].map((m) => m[1]);
    expect(missing, result.output).toEqual([]);
    expect(result.output).toBe("");
    expect(result.ok).toBe(true);
  }, 120_000);
});
