import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPluginHost } from "./build-plugin-host.js";
import { resolvePluginBuildToolchain } from "./toolchain.js";

function testToolchain() {
  return resolvePluginBuildToolchain(join(process.cwd(), ".unused-toolchain"));
}

describe("plugin host build", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("builds a self-contained Node artifact with identity and digest metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-host-build-test-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-host-build-fixture",
        version: "1.2.3",
        engines: { bb: ">=0.0" },
        bb: {
          name: "Host fixture",
          description: "Exercises the host artifact builder.",
          branding: { icon: "Cpu" },
          server: "./server.ts",
          host: "./host.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(
      join(dir, "host.ts"),
      [
        'import { experimental_defineHostEntry, type ExperimentalHostEntry } from "@get-bb/plugin-sdk/host";',
        'import { defineRpcContract } from "@get-bb/plugin-sdk";',
        'const schema = { "~standard": { validate(value: unknown) { return { value }; } } };',
        "const contract = defineRpcContract({ echo: {",
        "  input: schema,",
        "  output: schema,",
        "} });",
        "const entry: ExperimentalHostEntry<typeof contract> = experimental_defineHostEntry({",
        "  contract,",
        "  experimental_signals: { changed: { payload: schema } },",
        "  handlers: { echo: (input) => input },",
        "});",
        "export default entry;",
        "",
      ].join("\n"),
    );

    const result = await buildPluginHost(
      dir,
      "0.9.0-test",
      await testToolchain(),
    );
    const bytes = await readFile(result.jsPath);
    const bundle = bytes.toString("utf8");
    const metadata = JSON.parse(await readFile(result.metaPath, "utf8")) as {
      pluginId: string;
      pluginVersion: string;
      builtWith: { bbVersion: string };
      artifactDigest: string;
    };

    expect(bundle).not.toMatch(/from\s+["']@get-bb\/plugin-sdk/u);
    expect(metadata).toMatchObject({
      pluginId: "host-build-fixture",
      pluginVersion: "1.2.3",
      builtWith: { bbVersion: "0.9.0-test" },
      artifactDigest: result.artifactDigest,
    });
    expect(result.artifactDigest).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );

    const builtEntry = (await import(result.jsPath)) as {
      default: {
        experimental_apiVersion: number;
        experimental_signals: { changed: { payload: unknown } };
        handlers: { echo: (input: string) => string };
      };
    };
    expect(builtEntry.default.experimental_apiVersion).toBe(1);
    expect(builtEntry.default.experimental_signals).toHaveProperty("changed");
    expect(builtEntry.default.handlers.echo("from-artifact")).toBe(
      "from-artifact",
    );
  });

  it("removes old host staging directories without deleting an active concurrent build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-host-stage-cleanup-test-"));
    tempDirs.push(dir);
    const distDir = join(dir, "dist");
    await mkdir(join(distDir, ".host-stage-abandoned"), { recursive: true });
    await writeFile(
      join(distDir, ".host-stage-abandoned", "partial-host.js"),
      "partial artifact\n",
    );
    const abandonedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await utimes(
      join(distDir, ".host-stage-abandoned"),
      abandonedAt,
      abandonedAt,
    );
    await mkdir(join(distDir, ".host-stage-active"));
    await writeFile(
      join(distDir, ".host-stage-active", "partial-host.js"),
      "active build artifact\n",
    );
    await mkdir(join(distDir, ".stage-app-build"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-host-stage-cleanup-fixture",
        version: "1.0.0",
        engines: { bb: ">=0.0" },
        bb: {
          name: "Host stage cleanup fixture",
          description: "Exercises stale host staging directory cleanup.",
          branding: { icon: "Cpu" },
          server: "./server.ts",
          host: "./host.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(join(dir, "host.ts"), "export default {};\n");

    await buildPluginHost(dir, "0.9.0-test", await testToolchain());

    const distEntries = await readdir(distDir);
    expect(distEntries).not.toContain(".host-stage-abandoned");
    expect(distEntries).toContain(".host-stage-active");
    expect(distEntries).toContain(".stage-app-build");
    expect(
      distEntries.filter(
        (entry) =>
          entry.startsWith(".host-stage-") && entry !== ".host-stage-active",
      ),
    ).toEqual([]);
  });

  it("rejects a host entry outside the plugin directory", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".host-build-escape-test-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-host-escape-fixture",
        version: "1.0.0",
        engines: { bb: ">=0.0" },
        bb: {
          name: "Escape fixture",
          description: "Invalid host path.",
          branding: { icon: "Cpu" },
          server: "./server.ts",
          host: "../host.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "server.ts"),
      "export default function plugin() {}\n",
    );

    await expect(
      buildPluginHost(dir, "0.9.0-test", await testToolchain()),
    ).rejects.toThrow(/escapes the plugin directory/u);
  });

  it("rejects private BB workspace imports from host entries", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".host-build-private-test-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-host-private-fixture",
        version: "1.0.0",
        engines: { bb: ">=0.0" },
        bb: {
          name: "Private import fixture",
          description: "Invalid host dependency.",
          branding: { icon: "Cpu" },
          server: "./server.ts",
          host: "./host.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(
      join(dir, "host.ts"),
      'import value from "./helper.js";\nexport default value;\n',
    );
    await writeFile(
      join(dir, "helper.ts"),
      'import type { JsonValue } from "@bb/domain";\nexport default function helper(value: JsonValue) { return value; }\n',
    );

    await expect(
      buildPluginHost(dir, "0.9.0-test", await testToolchain()),
    ).rejects.toThrow(/cannot import private BB workspace package/u);
  });

  it("bundles the published bridge surface without stubbing it", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".host-build-bridge-test-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-host-bridge-fixture",
        version: "1.0.0",
        engines: { bb: ">=0.0" },
        bb: {
          name: "Bridge surface fixture",
          description: "Imports the published bridge surface.",
          branding: { icon: "Cpu" },
          server: "./server.ts",
          host: "./host.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(
      join(dir, "host.ts"),
      [
        'import { experimental_defineProviderBridge, threadDeltaSchema, threadStartParamsSchema } from "@get-bb/plugin-sdk/provider-bridge";',
        "export const experimental_providerBridge = experimental_defineProviderBridge({",
        "  handleLine(line) {",
        "    threadStartParamsSchema.safeParse(JSON.parse(line));",
        '    process.stdout.write(JSON.stringify(threadDeltaSchema.parse({ kind: "turn.open" })));',
        "  },",
        "});",
        "export default {};",
      ].join("\n"),
    );
    const result = await buildPluginHost(
      dir,
      "0.9.0-test",
      await testToolchain(),
    );
    const bundle = await readFile(result.jsPath, "utf8");
    expect(bundle).not.toMatch(/from\s*"@bb\//u);
    expect(bundle).toContain("experimental_apiVersion");
  });

  describe("host contract imports without a usable SDK", () => {
    const manifest = {
      name: "bb-plugin-host-contract-fixture",
      version: "1.0.0",
      engines: { bb: ">=0.0" },
      bb: {
        name: "Host contract fixture",
        description: "Imports a host contract from the SDK.",
        branding: { icon: "Cpu" },
        server: "./server.ts",
        host: "./host.ts",
      },
    };
    const hostSource = [
      "import {",
      "  experimental_defineHostEntry,",
      "  experimental_nativeRootsHostContract,",
      "  type ExperimentalHostEntry,",
      '} from "@get-bb/plugin-sdk/host";',
      "export default experimental_defineHostEntry({",
      "  contract: experimental_nativeRootsHostContract,",
      "  handlers: { resolveNativeRoots: () => ({ roots: [] }) },",
      "});",
      "",
    ].join("\n");

    async function writeFixture(dir: string): Promise<void> {
      await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
      await writeFile(
        join(dir, "server.ts"),
        "export default function plugin() {}\n",
      );
      await writeFile(join(dir, "host.ts"), hostSource);
    }

    it("names the missing SDK dependency when the plugin has no node_modules", async () => {
      const dir = await mkdtemp(join(tmpdir(), "bb-host-no-sdk-test-"));
      tempDirs.push(dir);
      await writeFixture(dir);

      await expect(
        buildPluginHost(dir, "0.9.0-test", await testToolchain()),
      ).rejects.toThrow(
        '"@get-bb/plugin-sdk/host" is not installed for this plugin (no node_modules/@get-bb/plugin-sdk); a host entry that imports experimental_nativeRootsHostContract needs the SDK as a dependency',
      );
    });

    it("names the unbuilt SDK dist when the package is installed without it", async () => {
      const dir = await mkdtemp(join(tmpdir(), "bb-host-unbuilt-sdk-test-"));
      tempDirs.push(dir);
      await writeFixture(dir);
      const sdkDir = join(dir, "node_modules", "@get-bb", "plugin-sdk");
      await mkdir(sdkDir, { recursive: true });
      await writeFile(
        join(sdkDir, "package.json"),
        JSON.stringify({
          name: "@get-bb/plugin-sdk",
          version: "0.0.0-test",
          type: "module",
          exports: {
            "./host": {
              types: "./bundled-types/bb-plugin-sdk-host.d.ts",
              import: "./dist/host.js",
              default: "./dist/host.js",
            },
          },
        }),
      );

      await expect(
        buildPluginHost(dir, "0.9.0-test", await testToolchain()),
      ).rejects.toThrow(
        `"@get-bb/plugin-sdk/host" is installed for this plugin but its dist is not built: run the SDK build (${join(sdkDir, "dist", "host.js")} is missing); a host entry that imports experimental_nativeRootsHostContract needs the built SDK`,
      );
    });
  });

  it("rejects relative type imports into private BB workspace packages", async () => {
    const parent = await mkdtemp(join(tmpdir(), "bb-host-relative-private-"));
    tempDirs.push(parent);
    const dir = join(parent, "plugin");
    const privatePackage = join(parent, "private-package");
    await mkdir(dir, { recursive: true });
    await mkdir(privatePackage, { recursive: true });
    await writeFile(
      join(privatePackage, "package.json"),
      JSON.stringify({ name: "@bb/private-fixture", type: "module" }),
    );
    await writeFile(
      join(privatePackage, "index.ts"),
      "export type PrivateValue = string;\n",
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-relative-private-fixture",
        version: "1.0.0",
        engines: { bb: ">=0.0" },
        bb: {
          name: "Relative private import fixture",
          description: "Invalid relative host dependency.",
          branding: { icon: "Cpu" },
          server: "./server.ts",
          host: "./host.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(
      join(dir, "host.ts"),
      'import type { PrivateValue } from "../private-package/index.js";\nconst value: PrivateValue = "nope";\nexport default value;\n',
    );

    await expect(
      buildPluginHost(dir, "0.9.0-test", await testToolchain()),
    ).rejects.toThrow(/@bb\/private-fixture/u);
  });

  it("allows private package names in comments and diagnostic strings", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".host-build-prose-test-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-host-prose-fixture",
        version: "1.0.0",
        engines: { bb: ">=0.0" },
        bb: {
          name: "Prose fixture",
          description: "Valid host source.",
          branding: { icon: "Cpu" },
          server: "./server.ts",
          host: "./host.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(
      join(dir, "host.ts"),
      '// Do not import from "@bb/domain".\nexport default "import type X from \'@bb/domain\'";\n',
    );

    await expect(
      buildPluginHost(dir, "0.9.0-test", await testToolchain()),
    ).resolves.toMatchObject({ artifactDigest: expect.any(String) });
  });
});
