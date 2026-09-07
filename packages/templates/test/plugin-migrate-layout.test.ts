import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migratePluginToPackageLayout,
  resolvePluginSdkLayout,
  setPluginSdkPin,
} from "../src/plugin-scaffold.js";
import { PLUGIN_SHIMMED_TYPE_DEPENDENCIES } from "../src/generated/plugin-starter-files.generated.js";

const SDK_VERSION = "0.4.3";

async function writeVendoredPlugin(
  rootDir: string,
  overrides: {
    manifest?: Record<string, unknown>;
    tsconfig?: Record<string, unknown>;
    declarations?: string[];
  } = {},
): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    `${JSON.stringify(
      overrides.manifest ?? {
        name: "bb-plugin-legacy",
        version: "0.1.0",
        engines: { bb: ">=0.9", bbPluginSdk: ">=0.2.0" },
        bb: { server: "./server.ts" },
        dependencies: { zod: "^4.3.6" },
        devDependencies: { "@types/node": "^22.0.0", typescript: "^5.7.0" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(rootDir, "tsconfig.json"),
    `${JSON.stringify(
      overrides.tsconfig ?? {
        compilerOptions: {
          strict: true,
          paths: {
            "@get-bb/plugin-sdk": ["./types/bb-plugin-sdk.d.ts"],
            "@get-bb/plugin-sdk/app": ["./types/bb-plugin-sdk-app.d.ts"],
            "@/*": ["./*"],
          },
        },
        include: ["server.ts", "app.tsx", "types"],
      },
      null,
      2,
    )}\n`,
  );
  const declarations = overrides.declarations ?? [
    "bb-plugin-sdk.d.ts",
    "bb-plugin-sdk-app.d.ts",
  ];
  if (declarations.length > 0) {
    await mkdir(join(rootDir, "types"), { recursive: true });
    for (const name of declarations) {
      await writeFile(join(rootDir, "types", name), "// vendored\n");
    }
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return parsed as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

describe("migratePluginToPackageLayout", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "bb-plugin-migrate-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("converts a vendored plugin and leaves the author's own config alone", async () => {
    await writeVendoredPlugin(rootDir);

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(result.changed).toBe(true);
    expect(result.pin).toEqual({ from: null, to: SDK_VERSION });
    expect(result.deletedFiles).toEqual([
      "types/bb-plugin-sdk.d.ts",
      "types/bb-plugin-sdk-app.d.ts",
    ]);
    expect(result.removedTypesDir).toBe(true);

    const manifest = await readJson(join(rootDir, "package.json"));
    const devDependencies = manifest.devDependencies as Record<string, string>;
    expect(devDependencies["@get-bb/plugin-sdk"]).toBe(SDK_VERSION);
    expect(devDependencies.typescript).toBe("^5.7.0");
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });

    const tsconfig = await readJson(join(rootDir, "tsconfig.json"));
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions.paths).toEqual({ "@/*": ["./*"] });
    expect(compilerOptions.strict).toBe(true);
    expect(tsconfig.include).toEqual(["server.ts", "app.tsx"]);

    expect(await exists(join(rootDir, "types"))).toBe(false);
    expect((await resolvePluginSdkLayout(rootDir)).kind).toBe("package");
  });

  it("raises an older engines floor but never lowers a newer one", async () => {
    await writeVendoredPlugin(rootDir);
    const raised = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });
    expect(raised.enginesFloor).toEqual({ from: ">=0.2.0", to: ">=0.4.3" });
    expect(
      (
        (await readJson(join(rootDir, "package.json"))).engines as
          | Record<string, string>
          | undefined
      )?.bbPluginSdk,
    ).toBe(">=0.4.3");

    const newer = await mkdtemp(join(tmpdir(), "bb-plugin-migrate-newer-"));
    try {
      await writeVendoredPlugin(newer, {
        manifest: {
          name: "bb-plugin-newer",
          engines: { bbPluginSdk: ">=9.1.0" },
          bb: { server: "./server.ts" },
        },
      });
      const result = await migratePluginToPackageLayout({
        rootDir: newer,
        sdkVersion: SDK_VERSION,
      });
      expect(result.enginesFloor).toBeNull();
      expect(
        (
          (await readJson(join(newer, "package.json"))).engines as Record<
            string,
            string
          >
        ).bbPluginSdk,
      ).toBe(">=9.1.0");
    } finally {
      await rm(newer, { recursive: true, force: true });
    }
  });

  it("is a no-op the second time", async () => {
    await writeVendoredPlugin(rootDir);
    await migratePluginToPackageLayout({ rootDir, sdkVersion: SDK_VERSION });
    const manifestAfterFirst = await readFile(
      join(rootDir, "package.json"),
      "utf8",
    );
    const tsconfigAfterFirst = await readFile(
      join(rootDir, "tsconfig.json"),
      "utf8",
    );

    const second = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(second).toEqual({
      changed: false,
      pin: null,
      movedFromDependencies: false,
      enginesFloor: null,
      removedPathMaps: [],
      removedIncludes: [],
      deletedFiles: [],
      removedTypesDir: false,
      rewrittenImports: [],
    });
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(
      manifestAfterFirst,
    );
    expect(await readFile(join(rootDir, "tsconfig.json"), "utf8")).toBe(
      tsconfigAfterFirst,
    );
  });

  it("converges a half-migrated plugin instead of rejecting it", async () => {
    await writeVendoredPlugin(rootDir, {
      manifest: {
        name: "bb-plugin-half",
        engines: { bbPluginSdk: `>=${SDK_VERSION}` },
        bb: { server: "./server.ts" },
        devDependencies: { "@get-bb/plugin-sdk": SDK_VERSION },
      },
    });

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(result.changed).toBe(true);
    expect(result.pin).toBeNull();
    expect(result.enginesFloor).toBeNull();
    expect(result.removedPathMaps).toEqual([
      "@get-bb/plugin-sdk",
      "@get-bb/plugin-sdk/app",
    ]);
    expect(await exists(join(rootDir, "types"))).toBe(false);
    expect((await resolvePluginSdkLayout(rootDir)).kind).toBe("package");
  });

  it("keeps a types/ directory that still holds the author's own files", async () => {
    await writeVendoredPlugin(rootDir);
    await writeFile(join(rootDir, "types", "custom.d.ts"), "// mine\n");

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(result.removedTypesDir).toBe(false);
    expect(await exists(join(rootDir, "types", "custom.d.ts"))).toBe(true);
    expect(await exists(join(rootDir, "types", "bb-plugin-sdk.d.ts"))).toBe(
      false,
    );
    expect(result.removedIncludes).toEqual([]);
    const tsconfig = await readJson(join(rootDir, "tsconfig.json"));
    expect(tsconfig.include).toEqual(["server.ts", "app.tsx", "types"]);
  });

  it("removes the pre-rename @bb/plugin-sdk path maps too", async () => {
    await writeVendoredPlugin(rootDir, {
      tsconfig: {
        compilerOptions: {
          paths: {
            "@bb/plugin-sdk": ["./types/bb-plugin-sdk.d.ts"],
            "@bb/plugin-sdk/app": ["./types/bb-plugin-sdk-app.d.ts"],
            "@/*": ["./*"],
          },
        },
        include: ["server.ts", "types"],
      },
    });

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(result.removedPathMaps).toEqual([
      "@bb/plugin-sdk",
      "@bb/plugin-sdk/app",
    ]);
    const tsconfig = await readJson(join(rootDir, "tsconfig.json"));
    expect((tsconfig.compilerOptions as Record<string, unknown>).paths).toEqual(
      { "@/*": ["./*"] },
    );
    expect((await resolvePluginSdkLayout(rootDir)).kind).toBe("package");
  });

  it("moves an exact pin out of dependencies and collapses a duplicate", async () => {
    await writeVendoredPlugin(rootDir, {
      declarations: [],
      manifest: {
        name: "bb-plugin-runtime-pin",
        engines: { bbPluginSdk: `>=${SDK_VERSION}` },
        bb: { server: "./server.ts" },
        dependencies: { "@get-bb/plugin-sdk": SDK_VERSION, zod: "^4.3.6" },
        devDependencies: { "@get-bb/plugin-sdk": "0.2.0" },
      },
      tsconfig: { compilerOptions: { strict: true }, include: ["server.ts"] },
    });

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(result.changed).toBe(true);
    expect(result.movedFromDependencies).toBe(true);
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });
    expect(manifest.devDependencies).toEqual({
      "@get-bb/plugin-sdk": SDK_VERSION,
    });
  });

  it("adds the pin and floor to a plugin with no vendored artifacts left", async () => {
    await writeVendoredPlugin(rootDir, {
      declarations: [],
      manifest: {
        name: "bb-plugin-pinless",
        bb: { server: "./server.ts" },
        devDependencies: { typescript: "^5.7.0" },
      },
      tsconfig: { compilerOptions: { strict: true }, include: ["server.ts"] },
    });

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(result.changed).toBe(true);
    expect(result.pin).toEqual({ from: null, to: SDK_VERSION });
    expect(result.enginesFloor).toEqual({ from: null, to: `>=${SDK_VERSION}` });
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(
      (manifest.devDependencies as Record<string, string>)[
        "@get-bb/plugin-sdk"
      ],
    ).toBe(SDK_VERSION);
  });

  it("rewrites pre-rename SDK imports across the plugin's sources", async () => {
    await writeVendoredPlugin(rootDir);
    await writeFile(
      join(rootDir, "server.ts"),
      [
        'import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";',
        "import type { Something } from '@bb/plugin-sdk/testing';",
        'import { helper } from "@bb/plugin-sdk-extras";',
        "// The @bb/plugin-sdk types are unquoted prose and stay as written.",
        "export const contract = defineRpcContract({});",
      ].join("\n") + "\n",
    );
    await writeFile(
      join(rootDir, "app.tsx"),
      'import { definePluginApp } from "@bb/plugin-sdk/app";\n',
    );
    await mkdir(join(rootDir, "lib"), { recursive: true });
    await writeFile(
      join(rootDir, "lib", "rpc.ts"),
      'export type { RpcContract } from "@bb/plugin-sdk";\n',
    );
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(
      join(rootDir, "dist", "server.ts"),
      'import "@bb/plugin-sdk";\n',
    );
    await mkdir(join(rootDir, "node_modules", "dep"), { recursive: true });
    await writeFile(
      join(rootDir, "node_modules", "dep", "index.ts"),
      'import "@bb/plugin-sdk";\n',
    );

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(result.rewrittenImports).toEqual([
      { path: "app.tsx", imports: 1 },
      { path: "lib/rpc.ts", imports: 1 },
      { path: "server.ts", imports: 2 },
    ]);
    const server = await readFile(join(rootDir, "server.ts"), "utf8");
    expect(server).toContain(
      'import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";',
    );
    expect(server).toContain("from '@get-bb/plugin-sdk/testing';");
    expect(server).toContain('from "@bb/plugin-sdk-extras";');
    expect(server).toContain("// The @bb/plugin-sdk types are unquoted prose");
    expect(await readFile(join(rootDir, "app.tsx"), "utf8")).toBe(
      'import { definePluginApp } from "@get-bb/plugin-sdk/app";\n',
    );
    expect(await readFile(join(rootDir, "lib", "rpc.ts"), "utf8")).toBe(
      'export type { RpcContract } from "@get-bb/plugin-sdk";\n',
    );
    expect(await readFile(join(rootDir, "dist", "server.ts"), "utf8")).toBe(
      'import "@bb/plugin-sdk";\n',
    );
    expect(
      await readFile(join(rootDir, "node_modules", "dep", "index.ts"), "utf8"),
    ).toBe('import "@bb/plugin-sdk";\n');

    const second = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });
    expect(second.rewrittenImports).toEqual([]);
    expect(second.changed).toBe(false);
  });

  it("reports the import rewrites in a dry run without writing them", async () => {
    await writeVendoredPlugin(rootDir);
    const source = 'import type { BbPluginApi } from "@bb/plugin-sdk";\n';
    await writeFile(join(rootDir, "server.ts"), source);

    const plan = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
      dryRun: true,
    });

    expect(plan.rewrittenImports).toEqual([{ path: "server.ts", imports: 1 }]);
    expect(await readFile(join(rootDir, "server.ts"), "utf8")).toBe(source);
  });

  it("migrates a plugin whose only legacy artifact is its imports", async () => {
    await writeVendoredPlugin(rootDir, {
      declarations: [],
      manifest: {
        name: "bb-plugin-imports-only",
        engines: { bbPluginSdk: `>=${SDK_VERSION}` },
        bb: { server: "./server.ts" },
        devDependencies: { "@get-bb/plugin-sdk": SDK_VERSION },
      },
      tsconfig: { compilerOptions: { strict: true }, include: ["server.ts"] },
    });
    await writeFile(join(rootDir, "server.ts"), 'import "@bb/plugin-sdk";\n');

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(result.changed).toBe(true);
    expect(result.rewrittenImports).toEqual([
      { path: "server.ts", imports: 1 },
    ]);
    expect(await readFile(join(rootDir, "server.ts"), "utf8")).toBe(
      'import "@get-bb/plugin-sdk";\n',
    );
  });

  it("dry runs report the plan and touch nothing", async () => {
    await writeVendoredPlugin(rootDir);
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    const plan = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
      dryRun: true,
    });

    expect(plan.changed).toBe(true);
    expect(plan.deletedFiles.length).toBe(2);
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(await exists(join(rootDir, "types", "bb-plugin-sdk.d.ts"))).toBe(
      true,
    );
  });

  it("refuses a symlinked types/ and changes nothing at all", async () => {
    await writeVendoredPlugin(rootDir, { declarations: [] });
    const outside = await mkdtemp(join(tmpdir(), "bb-plugin-outside-"));
    try {
      await writeFile(join(outside, "bb-plugin-sdk.d.ts"), "PRECIOUS\n");
      await symlink(outside, join(rootDir, "types"));
      const manifestBefore = await readFile(
        join(rootDir, "package.json"),
        "utf8",
      );

      await expect(
        migratePluginToPackageLayout({ rootDir, sdkVersion: SDK_VERSION }),
      ).rejects.toThrow(/symbolic link/);

      expect(await readFile(join(outside, "bb-plugin-sdk.d.ts"), "utf8")).toBe(
        "PRECIOUS\n",
      );
      expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(
        manifestBefore,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a tsconfig it cannot parse rather than rewriting it", async () => {
    await writeVendoredPlugin(rootDir);
    await writeFile(
      join(rootDir, "tsconfig.json"),
      '{\n  // paths\n  "compilerOptions": { "paths": {} }\n}\n',
    );
    const manifestBefore = await readFile(
      join(rootDir, "package.json"),
      "utf8",
    );

    await expect(
      migratePluginToPackageLayout({ rootDir, sdkVersion: SDK_VERSION }),
    ).rejects.toThrow(/tsconfig\.json is not valid JSON/);

    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(
      manifestBefore,
    );
    expect(await exists(join(rootDir, "types", "bb-plugin-sdk.d.ts"))).toBe(
      true,
    );
  });
});

describe("setPluginSdkPin", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "bb-plugin-pin-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("repoints an outdated pin and leaves the engines floor alone", async () => {
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-pinned",
          engines: { bbPluginSdk: ">=0.2.0" },
          bb: { server: "./server.ts" },
          devDependencies: {
            "@get-bb/plugin-sdk": "0.2.0",
            typescript: "^5.7.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setPluginSdkPin({
      rootDir,
      sdkVersion: SDK_VERSION,
      app: false,
    });

    expect(result).toEqual({
      pin: { from: "0.2.0", to: SDK_VERSION },
      movedFromDependencies: false,
      shimmedTypePins: [],
    });
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(
      (manifest.devDependencies as Record<string, string>)[
        "@get-bb/plugin-sdk"
      ],
    ).toBe(SDK_VERSION);
    expect((manifest.engines as Record<string, string>).bbPluginSdk).toBe(
      ">=0.2.0",
    );
    expect(
      await setPluginSdkPin({ rootDir, sdkVersion: SDK_VERSION, app: false }),
    ).toBeNull();
  });

  it("moves a runtime-declared SDK into devDependencies rather than duplicating it", async () => {
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-runtime-dep",
          bb: { server: "./server.ts" },
          dependencies: { "@get-bb/plugin-sdk": "0.2.0", zod: "^4.3.6" },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setPluginSdkPin({
      rootDir,
      sdkVersion: SDK_VERSION,
      app: false,
    });

    expect(result?.movedFromDependencies).toBe(true);
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });
    expect(
      (manifest.devDependencies as Record<string, string>)[
        "@get-bb/plugin-sdk"
      ],
    ).toBe(SDK_VERSION);
  });

  it("moves an already-exact pin out of dependencies", async () => {
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-exact-runtime-dep",
          bb: { server: "./server.ts" },
          dependencies: { "@get-bb/plugin-sdk": SDK_VERSION },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setPluginSdkPin({
      rootDir,
      sdkVersion: SDK_VERSION,
      app: false,
    });

    expect(result).toEqual({
      pin: null,
      movedFromDependencies: true,
      shimmedTypePins: [],
    });
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toEqual({
      "@get-bb/plugin-sdk": SDK_VERSION,
    });
    expect(
      await setPluginSdkPin({ rootDir, sdkVersion: SDK_VERSION, app: false }),
    ).toBeNull();
  });

  it("brings an app plugin's shimmed packages to the host's versions in devDependencies", async () => {
    const hostSonner = PLUGIN_SHIMMED_TYPE_DEPENDENCIES.sonner!;
    const hostVaul = PLUGIN_SHIMMED_TYPE_DEPENDENCIES.vaul!;
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-toasty",
          bb: { server: "./server.ts", app: "./app.tsx" },
          dependencies: { vaul: "^0.9.0", zod: "^4.3.6" },
          devDependencies: {
            "@get-bb/plugin-sdk": SDK_VERSION,
            sonner: "^0.3.0",
            typescript: "^5.7.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setPluginSdkPin({
      rootDir,
      sdkVersion: SDK_VERSION,
      app: true,
    });

    expect(result?.pin).toBeNull();
    expect(result?.shimmedTypePins).toContainEqual({
      name: "sonner",
      from: "^0.3.0",
      to: hostSonner,
      movedFromDependencies: false,
    });
    expect(result?.shimmedTypePins).toContainEqual({
      name: "vaul",
      from: "^0.9.0",
      to: hostVaul,
      movedFromDependencies: true,
    });
    expect(result?.shimmedTypePins).toContainEqual({
      name: "@radix-ui/react-popover",
      from: null,
      to: PLUGIN_SHIMMED_TYPE_DEPENDENCIES["@radix-ui/react-popover"],
      movedFromDependencies: false,
    });
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(manifest.dependencies).toEqual({ zod: "^4.3.6" });
    const devDependencies = manifest.devDependencies as Record<string, string>;
    for (const [name, version] of Object.entries(
      PLUGIN_SHIMMED_TYPE_DEPENDENCIES,
    )) {
      expect(devDependencies[name], name).toBe(version);
    }
    expect(devDependencies["@get-bb/plugin-sdk"]).toBe(SDK_VERSION);
    expect(devDependencies.typescript).toBe("^5.7.0");
    expect(
      await setPluginSdkPin({ rootDir, sdkVersion: SDK_VERSION, app: true }),
    ).toBeNull();
  });

  it("only repins the shimmed packages a headless plugin already declares", async () => {
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-headless",
          bb: { server: "./server.ts" },
          devDependencies: {
            "@get-bb/plugin-sdk": SDK_VERSION,
            clsx: "^1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setPluginSdkPin({
      rootDir,
      sdkVersion: SDK_VERSION,
      app: false,
    });

    expect(result?.shimmedTypePins).toEqual([
      {
        name: "clsx",
        from: "^1.0.0",
        to: PLUGIN_SHIMMED_TYPE_DEPENDENCIES.clsx,
        movedFromDependencies: false,
      },
    ]);
    const manifest = await readJson(join(rootDir, "package.json"));
    expect(manifest.devDependencies).toEqual({
      "@get-bb/plugin-sdk": SDK_VERSION,
      clsx: PLUGIN_SHIMMED_TYPE_DEPENDENCIES.clsx,
    });
  });
});
