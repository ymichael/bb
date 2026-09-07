import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPluginServer } from "./build-plugin-server.js";
import { resolvePluginBuildToolchain } from "./toolchain.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

function bundledSdkSpecifiers(bundle: string): string[] {
  const specifiers = new Set<string>();
  for (const match of bundle.matchAll(
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](@get-bb\/plugin-sdk[^"']*)["']/gu,
  )) {
    specifiers.add(match[1] ?? "");
  }
  return [...specifiers].sort();
}

describe("builtin server artifacts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it.each([
    { pluginDir: "provider-acp" },
    { pluginDir: "provider-claude-code" },
    { pluginDir: "provider-codex" },
    { pluginDir: "provider-pi" },
  ])(
    "builds the $pluginDir server entry with only the bare SDK specifier left external",
    async ({ pluginDir }) => {
      const root = await mkdtemp(join(repositoryRoot, ".builtin-server-test-"));
      tempDirs.push(root);
      const source = join(repositoryRoot, "plugins", pluginDir);
      for (const fileName of ["package.json", "server.ts"]) {
        await cp(join(source, fileName), join(root, fileName));
      }
      await cp(join(source, "src"), join(root, "src"), { recursive: true });
      await cp(join(source, "icons"), join(root, "icons"), { recursive: true });
      await symlink(
        join(source, "node_modules"),
        join(root, "node_modules"),
        "dir",
      );
      const toolchain = await resolvePluginBuildToolchain(
        join(repositoryRoot, "node_modules", ".unused-toolchain"),
      );
      const built = await buildPluginServer(root, "0.9.0-test", toolchain);

      const bundle = await readFile(built.jsPath, "utf8");
      expect(
        bundledSdkSpecifiers(bundle).filter(
          (specifier) => specifier !== "@get-bb/plugin-sdk",
        ),
      ).toEqual([]);

      const imported: unknown = await import(
        `${pathToFileURL(built.jsPath).href}?test=${Date.now()}`
      );
      expect(typeof Reflect.get(Object(imported), "default")).toBe("function");
    },
    90_000,
  );
});
