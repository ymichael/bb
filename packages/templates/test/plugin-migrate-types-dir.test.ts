import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migratePluginToPackageLayout } from "../src/plugin-scaffold.js";

const race = vi.hoisted(() => ({ armed: false }));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    readdir: async (path: string, options?: unknown) => {
      const entries = await (
        actual.readdir as (p: string, o?: unknown) => Promise<unknown>
      )(path, options);
      if (race.armed && path.endsWith(`${sep}types`)) {
        race.armed = false;
        await actual.writeFile(
          join(path, "appeared.d.ts"),
          "// saved mid-migration\n",
        );
      }
      return entries;
    },
  };
});

const SDK_VERSION = "0.4.3";

describe("migratePluginToPackageLayout when types/ survives the rmdir", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "bb-plugin-types-dir-"));
    race.armed = false;
  });

  afterEach(async () => {
    race.armed = false;
    await rm(rootDir, { recursive: true, force: true });
  });

  it("reports the directory it could not remove and keeps the include", async () => {
    await writeFile(
      join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: "bb-plugin-legacy",
          bb: { server: "./server.ts" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(rootDir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            paths: { "@get-bb/plugin-sdk": ["./types/bb-plugin-sdk.d.ts"] },
          },
          include: ["server.ts", "types"],
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(join(rootDir, "types"), { recursive: true });
    await writeFile(join(rootDir, "types", "bb-plugin-sdk.d.ts"), "// old\n");
    race.armed = true;

    const result = await migratePluginToPackageLayout({
      rootDir,
      sdkVersion: SDK_VERSION,
    });

    expect(result.deletedFiles).toEqual(["types/bb-plugin-sdk.d.ts"]);
    expect(result.removedTypesDir).toBe(false);
    expect(
      await stat(join(rootDir, "types")).then((s) => s.isDirectory()),
    ).toBe(true);
    expect(result.removedIncludes).toEqual([]);
    const tsconfig: { include: string[] } = JSON.parse(
      await readFile(join(rootDir, "tsconfig.json"), "utf8"),
    );
    expect(tsconfig.include).toEqual(["server.ts", "types"]);
    const compilerOptions: { paths?: unknown } = JSON.parse(
      await readFile(join(rootDir, "tsconfig.json"), "utf8"),
    ).compilerOptions;
    expect(compilerOptions.paths).toBeUndefined();
  });
});
