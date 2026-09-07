import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@bb/domain";
import { scaffoldPlugin } from "@bb/templates/plugin-scaffold";
import {
  buildPluginApp,
  resolvePluginBuildToolchain,
  type PluginBuildToolchain,
} from "@bb/plugin-build";
function testToolchain() {
  return resolvePluginBuildToolchain(join(tmpdir(), "bb-toolchain-unused"));
}

const TEST_BB_VERSION = "0.9.0-test";

async function failingTailwindToolchain(
  dir: string,
  message: string,
): Promise<PluginBuildToolchain> {
  const real = await testToolchain();
  const stub = join(dir, "tailwind-stub.mjs");
  await writeFile(
    stub,
    `export function compile() { throw new Error(${JSON.stringify(message)}); }\n` +
      `export function __unused() {}\n`,
  );
  return { ...real, tailwindNode: pathToFileURL(stub).href };
}

async function metafileRejectingToolchain(
  dir: string,
): Promise<PluginBuildToolchain> {
  const real = await testToolchain();
  const stub = join(dir, "esbuild-no-metafile.mjs");
  await writeFile(
    stub,
    `import * as esbuild from ${JSON.stringify(real.esbuild)};\n` +
      `export async function build(options) {\n` +
      `  if (options.metafile) throw new Error("unexpected esbuild metafile");\n` +
      `  return esbuild.build(options);\n` +
      `}\n`,
  );
  return { ...real, esbuild: pathToFileURL(stub).href };
}

const FIXTURE_PACKAGE_JSON = JSON.stringify(
  {
    name: "bb-plugin-fixture",
    version: "0.1.0",
    type: "module",
    bb: {
      name: "Build fixture",
      description: "Plugin app build fixture.",
      branding: { icon: "Zap" },
      server: "./server.ts",
      app: "./app.tsx",
    },
  },
  null,
  2,
);

const FIXTURE_APP_TSX = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

void createRoot;

function Card() {
  const [count] = useState(0);
  return (
    <div className="line-clamp-3 bg-background text-sm text-muted-foreground animate-in fade-in-0 rounded-lg">
      count: {count}
    </div>
  );
}

export default definePluginApp(Card);
`;

describe("buildPluginApp", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-plugin-build-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFixture(): Promise<void> {
    await writeFile(join(root, "package.json"), FIXTURE_PACKAGE_JSON);
    await writeFile(join(root, "server.ts"), "export default () => {};\n");
    await writeFile(join(root, "app.tsx"), FIXTURE_APP_TSX);
  }

  it("builds an ESM bundle with runtime shims, plugin-scoped CSS, and the SDK meta sidecar", async () => {
    await writeFixture();
    const result = await buildPluginApp(
      root,
      TEST_BB_VERSION,
      await testToolchain(),
    );

    const js = await readFile(result.jsPath, "utf8");
    expect(js).toMatch(/export\s*\{/);
    expect(js).toContain("globalThis.__bbPluginRuntime");
    for (const slot of [
      "react",
      "reactDomClient",
      "jsxRuntime",
      "pluginSdkApp",
    ]) {
      expect(js).toContain(`.${slot}`);
    }
    expect(js).not.toMatch(/from\s*["']react/);
    expect(js).not.toContain("react.development");
    expect(js).not.toContain("__SECRET_INTERNALS");
    expect(js).not.toContain("__CLIENT_INTERNALS");

    const css = await readFile(result.cssPath, "utf8");
    expect(css).toContain(".line-clamp-3");
    expect(css).toMatch(/\.bg-background\s*\{[^}]*var\(--background\)/);
    expect(css).toMatch(
      /\.text-muted-foreground\s*\{[^}]*var\(--muted-foreground\)/,
    );
    expect(css).toMatch(/\.rounded-lg\s*\{[^}]*var\(--radius\)/);
    expect(css).toMatch(/\.text-sm\s*\{[^}]*var\(--text-sm/);
    expect(css).toContain("--text-sm:.8125rem");
    expect(css).toContain(".animate-in");
    expect(css).toContain(".fade-in-0");
    const scope =
      ":where([data-bb-plugin=fixture],[data-bb-plugin-root]:not([data-bb-plugin]))";
    expect(css).toContain(`${scope} .animate-in`);
    expect(css).toContain(`${scope}.animate-in`);
    expect(css).not.toContain("@scope");

    const meta = JSON.parse(await readFile(result.metaPath, "utf8"));
    expect(meta).toEqual({
      sdkMajor: PLUGIN_SDK_MAJOR,
      sdkVersion: PLUGIN_SDK_VERSION,
      artifactFormatVersion: 1,
      pluginId: "fixture",
      pluginVersion: "0.1.0",
      builtWith: {
        bbVersion: TEST_BB_VERSION,
        pluginSdkVersion: PLUGIN_SDK_VERSION,
      },
    });
  });

  it("preserves authored CSS unscoped for editor decorations", async () => {
    await writeFixture();
    await writeFile(
      join(root, "app.css"),
      ".fixture-highlight { background: hotpink; }\n" +
        "@keyframes fixture-pulse { to { opacity: 0.5; } }\n",
    );
    await writeFile(
      join(root, "app.tsx"),
      `import "./app.css";\n${FIXTURE_APP_TSX}`,
    );

    const { cssPath } = await buildPluginApp(
      root,
      TEST_BB_VERSION,
      await testToolchain(),
    );
    const css = await readFile(cssPath, "utf8");

    expect(css).toContain(".fixture-highlight{background:#ff69b4}");
    expect(css).toContain("@keyframes fixture-pulse");
    expect(css.indexOf(".fixture-highlight{")).toBeGreaterThan(
      css.lastIndexOf("@layer utilities{"),
    );
    const scope =
      ":where([data-bb-plugin=fixture],[data-bb-plugin-root]:not([data-bb-plugin]))";
    expect(css).not.toContain(`${scope} .fixture-highlight`);
    expect(css).not.toContain(`${scope}.fixture-highlight`);
  });

  it("throws at import time without the BB runtime and loads once slots are set", async () => {
    await writeFixture();
    const { jsPath } = await buildPluginApp(
      root,
      TEST_BB_VERSION,
      await testToolchain(),
    );
    const url = pathToFileURL(jsPath).href;

    await expect(import(/* @vite-ignore */ url)).rejects.toThrow(
      /must be loaded by the BB app/,
    );

    (globalThis as { __bbPluginRuntime?: unknown }).__bbPluginRuntime = {
      react: { useState: () => [0, () => {}] },
      reactDomClient: { createRoot: () => ({}) },
      jsxRuntime: { jsx: () => ({}), jsxs: () => ({}), Fragment: {} },
      pluginSdkApp: { definePluginApp: (value: unknown) => value },
    };
    try {
      const mod = await import(/* @vite-ignore */ `${url}?with-runtime`);
      expect(mod.default).toBeDefined();
    } finally {
      delete (globalThis as { __bbPluginRuntime?: unknown }).__bbPluginRuntime;
    }
  });

  it("shims the shared-singleton packages (portal radix, sonner, vaul, @pierre/diffs)", async () => {
    await writeFile(join(root, "package.json"), FIXTURE_PACKAGE_JSON);
    await writeFile(
      join(root, "app.tsx"),
      [
        `import * as Dialog from "@radix-ui/react-dialog";`,
        `import * as AlertDialog from "@radix-ui/react-alert-dialog";`,
        `import { toast } from "sonner";`,
        `import { Drawer } from "vaul";`,
        `import { parsePatchFiles } from "@pierre/diffs";`,
        `import { FileDiff } from "@pierre/diffs/react";`,
        `export default () => [Dialog, AlertDialog, toast, Drawer, parsePatchFiles, FileDiff];`,
      ].join("\n"),
    );
    const { jsPath } = await buildPluginApp(
      root,
      TEST_BB_VERSION,
      await testToolchain(),
    );
    const js = await readFile(jsPath, "utf8");
    for (const slot of [
      "radixDialog",
      "radixAlertDialog",
      "sonner",
      "vaul",
      "pierreDiffs",
      "pierreDiffsReact",
    ]) {
      expect(js).toContain(`.${slot}`);
    }
    expect(js).not.toMatch(/from\s*["']@radix-ui/);
    expect(js).not.toMatch(/from\s*["']sonner/);
    expect(js).not.toMatch(/from\s*["']vaul/);
    expect(js).not.toMatch(/from\s*["']@pierre/);
  });

  it("shims explicit react/jsx-dev-runtime imports (dev-mode transform output)", async () => {
    await writeFile(join(root, "package.json"), FIXTURE_PACKAGE_JSON);
    await writeFile(
      join(root, "app.tsx"),
      `import { jsxDEV } from "react/jsx-dev-runtime";\n` +
        `export default () => jsxDEV("div", { children: "x" }, undefined, false, undefined, undefined);\n`,
    );
    const { jsPath } = await buildPluginApp(
      root,
      TEST_BB_VERSION,
      await testToolchain(),
    );
    const js = await readFile(jsPath, "utf8");
    expect(js).toContain(".jsxDevRuntime");
    expect(js).not.toMatch(/from\s*["']react/);
  });

  it("keeps the previous dist artifacts intact when a rebuild fails after esbuild", async () => {
    await writeFixture();
    const first = await buildPluginApp(
      root,
      TEST_BB_VERSION,
      await testToolchain(),
    );
    const originalJs = await readFile(first.jsPath, "utf8");
    const originalCss = await readFile(first.cssPath, "utf8");
    const originalMeta = await readFile(first.metaPath, "utf8");

    await writeFile(
      join(root, "app.tsx"),
      FIXTURE_APP_TSX.replace("count:", "changed:"),
    );
    await expect(
      buildPluginApp(
        root,
        TEST_BB_VERSION,
        await failingTailwindToolchain(root, "tailwind exploded"),
      ),
    ).rejects.toThrow("tailwind exploded");

    expect(await readFile(first.jsPath, "utf8")).toBe(originalJs);
    expect(await readFile(first.cssPath, "utf8")).toBe(originalCss);
    expect(await readFile(first.metaPath, "utf8")).toBe(originalMeta);
    expect((await readdir(join(root, "dist"))).sort()).toEqual([
      "app.css",
      "app.js",
      "app.meta.json",
    ]);
  });

  it("errors clearly when the plugin has no bb.app entry", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-headless",
        version: "0.1.0",
        bb: {
          name: "Headless fixture",
          description: "Headless plugin build fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await expect(
      buildPluginApp(root, TEST_BB_VERSION, await testToolchain()),
    ).rejects.toThrow(/no frontend entry/);
  });

  it("errors when bb.app points at a missing file", async () => {
    await writeFile(join(root, "package.json"), FIXTURE_PACKAGE_JSON);
    await expect(
      buildPluginApp(root, TEST_BB_VERSION, await testToolchain()),
    ).rejects.toThrow(/missing file/);
  });

  it("validates a path-shaped branding.icon before building", async () => {
    await writeFixture();
    const packageJson = JSON.parse(FIXTURE_PACKAGE_JSON) as {
      bb: { branding: { icon: string } };
    };
    packageJson.bb.branding.icon = "./assets/icon.svg";
    await writeFile(
      join(root, "package.json"),
      JSON.stringify(packageJson, null, 2),
    );

    await expect(
      buildPluginApp(root, TEST_BB_VERSION, await testToolchain()),
    ).rejects.toThrow(/bb\.branding\.icon points at a missing file/);

    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "icon.svg"), "<svg/>");
    const result = await buildPluginApp(
      root,
      TEST_BB_VERSION,
      await testToolchain(),
    );
    expect(result.jsPath).toBe(join(root, "dist", "app.js"));
  });

  it("builds the `bb plugin new` scaffold end to end", async () => {
    const targetDir = join(root, "bb-plugin-scaffolded");
    await scaffoldPlugin({
      targetDir,
      packageName: "bb-plugin-scaffolded",
      bbVersion: "0.9.0",
    });
    await linkScaffoldDeps(targetDir, [
      "@radix-ui/react-checkbox",
      "@radix-ui/react-slot",
      "@hugeicons/react",
      "@hugeicons/core-free-icons",
    ]);
    const result = await buildPluginApp(
      targetDir,
      TEST_BB_VERSION,
      await metafileRejectingToolchain(root),
    );
    const js = await readFile(result.jsPath, "utf8");
    expect(js).toContain("globalThis.__bbPluginRuntime");
    const css = await readFile(result.cssPath, "utf8");
    expect(css).toContain(".rounded-md");

    (globalThis as { __bbPluginRuntime?: unknown }).__bbPluginRuntime = {
      react: {
        forwardRef: (render: unknown) => render,
        createContext: () => ({}),
      },
      reactDom: {},
      jsxRuntime: { jsx: () => ({}), jsxs: () => ({}), Fragment: {} },
      classVarianceAuthority: { cva: () => () => "" },
      clsx: { clsx: () => "" },
      tailwindMerge: { twMerge: (value: string) => value },
      pluginSdkApp: {
        definePluginApp: (setup: unknown) => ({
          __bbPluginApp: true,
          setup,
        }),
        useBbContext: () => ({ projectId: null, threadId: null }),
      },
    };
    try {
      const mod = (await import(
        /* @vite-ignore */ pathToFileURL(result.jsPath).href
      )) as { default?: { __bbPluginApp?: unknown; setup?: unknown } };
      expect(mod.default?.__bbPluginApp).toBe(true);
      expect(typeof mod.default?.setup).toBe("function");
    } finally {
      delete (globalThis as { __bbPluginRuntime?: unknown }).__bbPluginRuntime;
    }
  });
});

async function linkScaffoldDeps(
  targetDir: string,
  packageNames: string[],
): Promise<void> {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const appRequire = createRequire(
    join(testDir, "..", "..", "..", "app", "package.json"),
  );
  for (const name of packageNames) {
    const entry = appRequire.resolve(name);
    let packageRoot = dirname(entry);
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
