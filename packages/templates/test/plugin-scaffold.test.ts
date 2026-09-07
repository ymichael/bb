import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_SDK_VERSION } from "@bb/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolvePluginSdkLayout,
  scaffoldPlugin,
  syncPluginTypes,
} from "../src/plugin-scaffold.js";

describe("scaffoldPlugin SDK dependency", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bb-scaffold-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("pins @get-bb/plugin-sdk exactly and vendors no declarations", async () => {
    const targetDir = join(workDir, "bb-plugin-todo");
    await scaffoldPlugin({
      targetDir,
      packageName: "bb-plugin-todo",
      bbVersion: "0.9.0",
    });

    await expect(access(join(targetDir, "types"))).rejects.toThrow();

    const tsconfig = JSON.parse(
      await readFile(join(targetDir, "tsconfig.json"), "utf8"),
    );
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./*"] });
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(tsconfig.include).toEqual([
      "server.ts",
      "app.tsx",
      "components",
      "lib",
      "hooks",
    ]);

    const pkg = JSON.parse(
      await readFile(join(targetDir, "package.json"), "utf8"),
    );
    expect(pkg.devDependencies["@get-bb/plugin-sdk"]).toBe(PLUGIN_SDK_VERSION);
    expect(pkg.dependencies["@get-bb/plugin-sdk"]).toBeUndefined();
    expect(pkg.engines).toEqual({
      bb: ">=0.9",
      bbPluginSdk: `>=${PLUGIN_SDK_VERSION}`,
    });
    expect(pkg.bb).toMatchObject({
      name: "Todo",
      branding: { icon: "ListTodo" },
      server: "./server.ts",
      app: "./app.tsx",
    });
    expect(pkg.devDependencies["@types/react"]).toBeDefined();
    expect(pkg.dependencies.zod).toBeDefined();
    expect(pkg.devDependencies.zod).toBeUndefined();

    const readme = await readFile(join(targetDir, "README.md"), "utf8");
    expect(readme).toContain(
      "node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts",
    );
    expect(readme).toContain(
      "sync this plugin's SDK surface to the running BB",
    );
    expect(readme).not.toContain("rewrite types/");
    expect(readme).toContain("https://github.com/get-bb/bb");

    const components = JSON.parse(
      await readFile(join(targetDir, "components.json"), "utf8"),
    );
    expect(components.registries["@bb"]).toBe(
      "https://raw.githubusercontent.com/get-bb/bb/desktop-v0.9.0/packages/plugin-registry/r/{name}.json",
    );
    expect(pkg.dependencies["@radix-ui/react-checkbox"]).toBeDefined();
    await access(join(targetDir, "components", "ui", "checkbox.tsx"));
  });

  it("writes a store overview that follows the marketplace content rules", async () => {
    const targetDir = join(workDir, "bb-plugin-todo");
    await scaffoldPlugin({
      targetDir,
      packageName: "bb-plugin-todo",
      bbVersion: "0.9.0",
    });

    const overview = await readFile(
      join(targetDir, "PLUGIN_OVERVIEW.md"),
      "utf8",
    );
    expect(overview).toContain("bb todo list");
    expect(overview).toMatch(/^[^#]/u);
    expect([...overview].length).toBeGreaterThan(700);
    expect([...overview].length).toBeLessThanOrEqual(4000);
    const prose = overview
      .replace(/```[\s\S]*?```/gu, "")
      .replace(/`[^`]*`/gu, "");
    expect(prose).not.toMatch(/<[A-Za-z!/?]|!\[/u);

    const readme = await readFile(join(targetDir, "README.md"), "utf8");
    expect(readme).toContain("## Store listing");
    expect(readme).toContain("marketplace requires the file");
  });

  it("uses the canonical id in a scoped package scaffold", async () => {
    const targetDir = join(workDir, "bb-plugin-scoped");
    await scaffoldPlugin({
      targetDir,
      packageName: "@acme/bb-plugin-scoped",
      bbVersion: "0.9.0",
    });

    const pkg = JSON.parse(
      await readFile(join(targetDir, "package.json"), "utf8"),
    );
    expect(pkg.name).toBe("@acme/bb-plugin-scoped");
    expect(pkg.bb.name).toBe("Scoped");

    const readme = await readFile(join(targetDir, "README.md"), "utf8");
    expect(readme).toContain("bb plugin reload scoped");
    expect(readme).toContain("bb plugin config scoped");

    const server = await readFile(join(targetDir, "server.ts"), "utf8");
    expect(server).toContain("bb plugin config scoped");
    expect(server).not.toContain("bb plugin config @acme/");
    expect(server).toContain('name: "scoped"');
    expect(server).toContain("bb scoped list");
    const app = await readFile(join(targetDir, "app.tsx"), "utf8");
    expect(app).toContain("bb scoped add");
    const skill = await readFile(
      join(targetDir, "skills", "example-todos", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("bb scoped list");
    expect(skill).not.toContain("@acme/");
  });
});

describe("resolvePluginSdkLayout", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bb-layout-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reports the npm layout with its exact pin for a fresh scaffold", async () => {
    const targetDir = join(workDir, "bb-plugin-new-style");
    await scaffoldPlugin({
      targetDir,
      packageName: "bb-plugin-new-style",
      bbVersion: "0.9.0",
    });

    await expect(resolvePluginSdkLayout(targetDir)).resolves.toEqual({
      kind: "package",
      pin: PLUGIN_SDK_VERSION,
    });
  });

  it("reports the vendored layout for a legacy plugin, which still refreshes", async () => {
    const targetDir = join(workDir, "bb-plugin-legacy");
    await scaffoldPlugin({
      targetDir,
      packageName: "bb-plugin-legacy",
      bbVersion: "0.9.0",
    });
    const pkgPath = join(targetDir, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    delete pkg.devDependencies["@get-bb/plugin-sdk"];
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const tsconfigPath = join(targetDir, "tsconfig.json");
    const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8"));
    tsconfig.compilerOptions.paths = {
      "@get-bb/plugin-sdk": ["./types/bb-plugin-sdk.d.ts"],
    };
    await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);

    await expect(resolvePluginSdkLayout(targetDir)).resolves.toEqual({
      kind: "vendored",
      pin: null,
    });

    const files = await syncPluginTypes({ rootDir: targetDir, app: false });
    expect(files).toEqual([
      { path: "types/bb-plugin-sdk.d.ts", outcome: "written" },
    ]);
    const vendored = await readFile(
      join(targetDir, "types", "bb-plugin-sdk.d.ts"),
      "utf8",
    );
    expect(vendored).toContain("interface BbPluginApi");
  });

  it("stays vendored while declarations exist but the path map is gone", async () => {
    const targetDir = join(workDir, "bb-plugin-half-migrated");
    await scaffoldPlugin({
      targetDir,
      packageName: "bb-plugin-half-migrated",
      bbVersion: "0.9.0",
    });
    await syncPluginTypes({ rootDir: targetDir, app: false });

    const layout = await resolvePluginSdkLayout(targetDir);
    expect(layout.kind).toBe("vendored");
    expect(layout.pin).toBe(PLUGIN_SDK_VERSION);
  });
});
