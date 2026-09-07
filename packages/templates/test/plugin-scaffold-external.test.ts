import { readFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { PLUGIN_SDK_VERSION } from "@bb/domain";
import { scaffoldPlugin } from "../src/plugin-scaffold.js";

const execFileAsync = promisify(execFile);
const pluginSdkRoot = resolve(process.cwd(), "../plugin-sdk");
const dependencyRequire = createRequire(join(pluginSdkRoot, "package.json"));

const EXTERNAL_DEPENDENCIES = [
  "@hugeicons/core-free-icons",
  "@hugeicons/react",
  "@radix-ui/react-dialog",
  "@radix-ui/react-slot",
  "@testing-library/react",
  "@types/better-sqlite3",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "better-sqlite3",
  "class-variance-authority",
  "clsx",
  "cron-parser",
  "hono",
  "jsdom",
  "react",
  "react-dom",
  "tailwind-merge",
  "vaul",
  "vitest",
  "zod",
] as const;

const BACKEND_TEST = `
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

describe("scaffold backend", () => {
  it("loads, inspects, and atomically reloads through the packed harness", async () => {
    const host = createFakePluginHost({ pluginId: "external-backend" });
    await plugin(host.bb);
    await expect(host.harness.behavior.callRpc("todos_list")).resolves.toEqual({
      todos: [],
    });
    const added = await host.harness.behavior.callRpc("todos_add", {
      title: "Ship it",
    });
    expect(added).toMatchObject({ title: "Ship it", done: false });
    expect(host.harness.inspection.registrations.rpcMethods).toEqual([
      "todos_list",
      "todos_add",
      "todos_set_done",
      "todos_remove",
    ]);

    // The todo store lives in bb.storage.kv, so it survives a reload.
    const next = await host.harness.lifecycle.reload(plugin);
    await expect(next.harness.behavior.callRpc("todos_list")).resolves.toEqual({
      todos: [added],
    });
    await next.harness.lifecycle.dispose();
  });
});
`;

const FRONTEND_TEST = `
// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

describe("scaffold frontend", () => {
  it("loads and renders the Example todos page through the packed harness", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const createdAt = "2026-01-01T00:00:00.000Z";
    let todos = [{ id: "a1", title: "Ship it", done: false, createdAt }];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "proj_external", threadId: null },
        rpc: {
          todos_list: () => ({ todos }),
          todos_add: (input: unknown) => {
            const { title } = input as { title: string };
            const todo = { id: "b2", title, done: false, createdAt };
            todos = [...todos, todo];
            return todo;
          },
        },
      },
    );
    await slot.findByText("Ship it");

    fireEvent.change(slot.getByLabelText("New todo"), {
      target: { value: "Write docs" },
    });
    fireEvent.click(slot.getByText("Add"));
    await slot.findByText("Write docs");
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual([
      "todos_list",
      "todos_add",
      "todos_list",
    ]);

    // A server-side write (bb <id> remove …) reaches the page as a signal.
    todos = [];
    await slot.behavior.emitRealtime("todos-changed", { count: 0 });
    await slot.findByText(/Nothing to do/);
    slot.lifecycle.unmount();
  });
});
`;

const VITEST_CONFIG = `
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": resolve(process.cwd()) } },
});
`;

const REPRESENTATIVE_SERVER = `
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  projectName: {
    input: z.object({ projectId: z.string() }),
    output: z.object({ name: z.string() }),
  },
});

async function verifyFullSdk(bb: BbPluginApi) {
  const thread = await bb.sdk.threads.spawn({
    projectId: "proj_fixture",
    environment: { type: "project-default" },
    prompt: "Verify the portable SDK contract",
  });
  const threadId: string = thread.id;

  const file = await bb.sdk.files.read({ path: "/tmp/fixture.txt" });
  const sha256: string = file.sha256;

  const project = await bb.sdk.projects.get({ projectId: "proj_fixture" });
  const projectName: string = project.name;
  const sourceId: string | undefined = project.sources[0]?.id;
  const attachment = await bb.sdk.projects.attachments.upload({
    projectId: "proj_fixture",
    clientFile: new Uint8Array([0, 1, 255]),
    filename: "fixture.bin",
    mimeType: "application/octet-stream",
  });
  const attachmentPath: string = attachment.path;

  const environment = await bb.sdk.environments.status({
    environmentId: "env_fixture",
  });
  const outcome: "available" | "not_applicable" | "unavailable" =
    environment.outcome;

  return { attachmentPath, outcome, projectName, sha256, sourceId, threadId };
}

export default function plugin(bb: BbPluginApi) {
  void verifyFullSdk;
  bb.rpc.register(rpcContract, {
    async projectName({ projectId }) {
      const project = await bb.sdk.projects.get({ projectId });
      return { name: project.name };
    },
  });
  bb.log.info("portable SDK fixture loaded");
}
`;

const REPRESENTATIVE_APP = `
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

function Panel() {
  const rpc = useRpc<typeof rpcContract>();
  void rpc.call("projectName", { projectId: "proj_fixture" }).then((result) => {
    const exactName: string = result.name;
    void exactName;
  });
  return null;
}

export default definePluginApp((app) => {
  app.slots.homepageSection({ id: "fixture", title: "Fixture", component: Panel });
});
`;

function packageRoot(name: string): string {
  try {
    return dirname(dependencyRequire.resolve(`${name}/package.json`));
  } catch {
    let current = dirname(dependencyRequire.resolve(name));
    while (true) {
      try {
        const manifest = JSON.parse(
          readFileSync(join(current, "package.json"), "utf8"),
        ) as { name?: string };
        if (manifest.name === name) return current;
      } catch {}
      const parent = dirname(current);
      if (parent === current)
        throw new Error(`package root not found: ${name}`);
      current = parent;
    }
  }
}

async function linkExternalDependencies(targetDir: string): Promise<void> {
  for (const name of EXTERNAL_DEPENDENCIES) {
    const target = join(targetDir, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await symlink(packageRoot(name), target, "dir");
  }
}

async function packPluginSdk(packDir: string): Promise<string> {
  await mkdir(packDir, { recursive: true });
  await execFileAsync(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", packDir],
    {
      cwd: pluginSdkRoot,
    },
  );
  const tarballs = (await readdir(packDir)).filter((name) =>
    name.endsWith(".tgz"),
  );
  expect(tarballs).toHaveLength(1);
  return join(packDir, tarballs[0]!);
}

async function installPackedSdk(
  targetDir: string,
  tarball: string,
): Promise<void> {
  await execFileAsync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-package-lock",
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      tarball,
    ],
    { cwd: targetDir },
  );
}

async function scaffoldSdkPin(targetDir: string): Promise<string | undefined> {
  const manifest = JSON.parse(
    await readFile(join(targetDir, "package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  return manifest.devDependencies?.["@get-bb/plugin-sdk"];
}

async function includeTestsInTypecheck(targetDir: string): Promise<void> {
  const tsconfigPath = join(targetDir, "tsconfig.json");
  const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8")) as {
    include: string[];
  };
  tsconfig.include.push("*.test.ts", "*.test.tsx");
  await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
}

async function runTypecheck(targetDir: string): Promise<void> {
  const typescriptRoot = packageRoot("typescript");
  try {
    await execFileAsync(
      process.execPath,
      [join(typescriptRoot, "lib", "tsc.js"), "--project", "tsconfig.json"],
      { cwd: targetDir },
    );
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string };
    throw new Error(
      `external scaffold typecheck failed:\n${failed.stdout ?? ""}${failed.stderr ?? ""}`,
    );
  }
}

async function runVitest(targetDir: string): Promise<void> {
  const vitestRoot = packageRoot("vitest");
  try {
    await execFileAsync(
      process.execPath,
      [join(vitestRoot, "vitest.mjs"), "run", "--passWithNoTests=false"],
      { cwd: targetDir },
    );
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string };
    throw new Error(
      `external scaffold tests failed:\n${failed.stdout ?? ""}${failed.stderr ?? ""}`,
    );
  }
}

describe("external plugin scaffold types", () => {
  let workDir: string;
  let packRoot: string;
  let tarball: string;
  let installedNodeModules: string;

  async function useInstalledNodeModules(targetDir: string): Promise<void> {
    await symlink(installedNodeModules, join(targetDir, "node_modules"), "dir");
  }

  beforeAll(async () => {
    packRoot = await mkdtemp(join(tmpdir(), "bb-external-pack-"));
    tarball = await packPluginSdk(join(packRoot, "pack"));
    const templateDir = join(packRoot, "template");
    await scaffoldPlugin({
      targetDir: templateDir,
      packageName: "bb-plugin-external-template",
      bbVersion: "0.9.0",
    });
    await installPackedSdk(templateDir, tarball);
    await linkExternalDependencies(templateDir);
    installedNodeModules = join(templateDir, "node_modules");
  }, 180_000);

  afterAll(async () => {
    await rm(packRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bb-external-scaffold-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("typechecks full SDK results against the installed package, with library checks enabled", async () => {
    const targetDir = join(workDir, "bb-plugin-external");
    await scaffoldPlugin({
      targetDir,
      packageName: "bb-plugin-external",
      bbVersion: "0.9.0",
    });
    await writeFile(join(targetDir, "server.ts"), REPRESENTATIVE_SERVER);
    await writeFile(join(targetDir, "app.tsx"), REPRESENTATIVE_APP);
    expect(await scaffoldSdkPin(targetDir)).toBe(PLUGIN_SDK_VERSION);
    await useInstalledNodeModules(targetDir);

    const tsconfig = JSON.parse(
      await readFile(join(targetDir, "tsconfig.json"), "utf8"),
    ) as {
      compilerOptions: {
        skipLibCheck: boolean;
        paths?: Record<string, string[]>;
      };
    };
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(Object.keys(tsconfig.compilerOptions.paths ?? {})).toEqual(["@/*"]);
    await expect(
      access(join(targetDir, "types", "bb-plugin-sdk.d.ts")),
    ).rejects.toThrow();
    await expect(
      access(
        join(
          targetDir,
          "node_modules",
          "@get-bb",
          "plugin-sdk",
          "bundled-types",
          "bb-plugin-sdk.d.ts",
        ),
      ),
    ).resolves.toBeUndefined();

    await runTypecheck(targetDir);
  }, 300_000);

  it("installs the packed testing runtimes and executes scaffold backend and frontend tests", async () => {
    const packedListing = (
      await execFileAsync("tar", ["-tzf", tarball])
    ).stdout.split("\n");
    expect(packedListing).toContain("package/dist/testing/index.js");
    expect(packedListing).toContain("package/dist/testing/app.js");
    expect(packedListing).toContain(
      "package/bundled-types/bb-plugin-sdk-testing.d.ts",
    );
    expect(packedListing).toContain(
      "package/bundled-types/bb-plugin-sdk-testing-app.d.ts",
    );
    expect(
      packedListing.some((entry) => entry.startsWith("package/src/")),
    ).toBe(false);
    expect(
      packedListing.some((entry) => entry.startsWith("package/scripts/")),
    ).toBe(false);

    const backendDir = join(workDir, "bb-plugin-external-backend");
    await scaffoldPlugin({
      targetDir: backendDir,
      packageName: "bb-plugin-external-backend",
      bbVersion: "0.9.0",
    });
    await useInstalledNodeModules(backendDir);
    await writeFile(join(backendDir, "server.test.ts"), BACKEND_TEST);
    await includeTestsInTypecheck(backendDir);

    expect(await readdir(join(backendDir, "node_modules", "@get-bb"))).toEqual([
      "plugin-sdk",
    ]);
    const installedSdk = join(
      backendDir,
      "node_modules",
      "@get-bb",
      "plugin-sdk",
    );
    const installedManifest = JSON.parse(
      await readFile(join(installedSdk, "package.json"), "utf8"),
    ) as {
      version: string;
      private?: boolean;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      exports: Record<string, { import: string; types: string }>;
    };
    expect(installedManifest.version).toBe(PLUGIN_SDK_VERSION);
    expect(installedManifest.private).not.toBe(true);
    expect(JSON.stringify(installedManifest.dependencies ?? {})).not.toContain(
      "workspace:",
    );
    expect(
      JSON.stringify(installedManifest.optionalDependencies ?? {}),
    ).not.toContain("workspace:");
    expect(
      JSON.stringify(installedManifest.peerDependencies ?? {}),
    ).not.toContain("workspace:");
    for (const subpath of ["./testing", "./testing/app"] as const) {
      const entry = installedManifest.exports[subpath];
      await expect(
        access(join(installedSdk, entry.import.replace(/^\.\//u, ""))),
      ).resolves.toBeUndefined();
      const declarations = await readFile(
        join(installedSdk, entry.types.replace(/^\.\//u, "")),
        "utf8",
      );
      const bbImports = [
        ...declarations.matchAll(/from ['"](@(?:get-)?bb\/[^'"]+)['"]/gu),
      ].map((match) => match[1]);
      expect(new Set(bbImports)).toEqual(new Set(["@get-bb/plugin-sdk"]));
      expect(declarations).not.toContain("@bb/sdk");
      expect(declarations).not.toContain("@bb/server-contract");
    }
    for (const runtimePath of [
      "dist/testing/index.js",
      "dist/testing/app.js",
    ]) {
      const runtime = await readFile(join(installedSdk, runtimePath), "utf8");
      expect(runtime).not.toMatch(/from ['"]@bb\//u);
    }
    await expect(access(join(installedSdk, "src"))).rejects.toThrow();
    const backendTsconfig = JSON.parse(
      await readFile(join(backendDir, "tsconfig.json"), "utf8"),
    ) as {
      compilerOptions: {
        skipLibCheck: boolean;
        paths?: Record<string, string[]>;
      };
    };
    expect(backendTsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(backendTsconfig.compilerOptions.paths).toEqual({ "@/*": ["./*"] });

    const frontendDir = join(workDir, "bb-plugin-external-frontend");
    await scaffoldPlugin({
      targetDir: frontendDir,
      packageName: "bb-plugin-external-frontend",
      bbVersion: "0.9.0",
    });
    await useInstalledNodeModules(frontendDir);
    await writeFile(join(frontendDir, "app.test.tsx"), FRONTEND_TEST);
    await writeFile(join(frontendDir, "vitest.config.ts"), VITEST_CONFIG);
    await includeTestsInTypecheck(frontendDir);

    await Promise.all(
      [backendDir, frontendDir].map(async (dir) => {
        await runTypecheck(dir);
        await runVitest(dir);
      }),
    );
  }, 300_000);
});
