import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface PackageExport {
  source: string;
  types: string;
  import: string;
  default: string;
}

describe("packed plugin SDK exports", () => {
  it("maps every packed subpath to runtime JavaScript and portable declarations", async () => {
    const packageRoot = new URL("../../", import.meta.url);
    const packageJson = JSON.parse(
      await readFile(new URL("package.json", packageRoot), "utf8"),
    ) as {
      files: string[];
      private?: boolean;
      exports: Record<string, PackageExport>;
    };

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.files).toEqual(["bundled-types", "dist", "README.md"]);
    expect(Object.keys(packageJson.exports)).toEqual([
      ".",
      "./ai-services",
      "./provider-bridge",
      "./provider-bridge/testing",
      "./provider-bridge/acp",
      "./environment-provider",
      "./machine-provider",
      "./app",
      "./host",
      "./internal/composer-customization-validation",
      "./internal/composer-view",
      "./internal/file-navigation-validation",
      "./internal/host-policy",
      "./internal/plugin-app-collector",
      "./testing",
      "./testing/app",
      "./testing/host",
    ]);

    for (const entry of Object.values(packageJson.exports)) {
      expect(entry.import).toMatch(/^\.\/dist\/.*\.js$/u);
      expect(entry.default).toBe(entry.import);
      expect(entry.types).toMatch(/^\.\/bundled-types\/.*\.d\.ts$/u);
      await expect(
        access(new URL(entry.types.slice(2), packageRoot)),
      ).resolves.toBeUndefined();
      expect(entry.source).toMatch(/^\.\/src\//u);
    }
  });
});
