import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readBbAppVersion } from "./bb-app-version.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(testDir, "..", "..");
const workspaceRoot = resolve(cliRoot, "..", "..");

describe("packaged CLI plugin build", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("includes a newly generated SDK app export when the facade package is not resolvable", async () => {
    const tempRoot = await mkdtemp(join(cliRoot, ".packaged-plugin-build-"));
    tempDirs.push(tempRoot);
    const cliEntry = join(tempRoot, "cli.js");
    const pluginRoot = join(tempRoot, "plugin");
    await execFileAsync(
      process.execPath,
      [
        resolve(workspaceRoot, "scripts", "build-node-entry.mjs"),
        "src/index.ts",
        cliEntry,
        "--split",
        "--external",
        "esbuild",
        "--external",
        "@tailwindcss/node",
        "--external",
        "@tailwindcss/oxide",
      ],
      { cwd: cliRoot },
    );

    await mkdir(pluginRoot, { recursive: true });
    await writeFile(
      join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "bb-plugin-packaged-shim-fixture",
        version: "0.1.0",
        type: "module",
        bb: {
          name: "Packaged shim fixture",
          description: "Exercises the packaged CLI SDK shim fallback.",
          branding: { icon: "Zap" },
          server: "./server.ts",
          app: "./app.ts",
        },
      }),
    );
    await writeFile(
      join(pluginRoot, "server.ts"),
      "export default () => {};\n",
    );
    await writeFile(
      join(pluginRoot, "app.ts"),
      [
        'import { definePluginApp, useComposerView } from "@get-bb/plugin-sdk/app";',
        "function ComposerProbe() {",
        "  return useComposerView().layout;",
        "}",
        "export default definePluginApp((app) => {",
        "  app.slots.homepageSection({",
        '    id: "composer-probe",',
        '    title: "Composer probe",',
        "    component: ComposerProbe,",
        "  });",
        "});",
        "",
      ].join("\n"),
    );

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BB_CLI_REEXEC: "1",
    };
    delete childEnv.BB_CLI;
    delete childEnv.BB_APP_VERSION;

    expect(await readdir(join(tempRoot, "cli-chunks"))).not.toHaveLength(0);
    const { stdout: versionOutput } = await execFileAsync(
      process.execPath,
      [cliEntry, "--version"],
      { cwd: workspaceRoot, env: childEnv },
    );
    expect(versionOutput.trim()).toBe(await readBbAppVersion());

    await execFileAsync(
      process.execPath,
      [cliEntry, "plugin", "build", pluginRoot],
      { cwd: workspaceRoot, env: childEnv },
    );

    const appBundle = await readFile(
      join(pluginRoot, "dist", "app.js"),
      "utf8",
    );
    expect(appBundle).toContain("useComposerView");
    expect(appBundle).toContain("homepageSection");
  }, 30_000);
});
