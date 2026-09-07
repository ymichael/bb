import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncPluginTypes } from "../src/plugin-scaffold.js";

describe("syncPluginTypes", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "bb-sync-types-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("replaces a stale declaration and creates a missing types/", async () => {
    const results = await syncPluginTypes({ rootDir, app: false });

    expect(results).toEqual([
      { path: "types/bb-plugin-sdk.d.ts", outcome: "written" },
    ]);
    const written = await readFile(
      join(rootDir, "types", "bb-plugin-sdk.d.ts"),
      "utf8",
    );
    expect(written).toContain("interface BbPluginApi");

    await writeFile(join(rootDir, "types", "bb-plugin-sdk.d.ts"), "// stale\n");
    const refreshed = await syncPluginTypes({ rootDir, app: false });
    expect(refreshed[0]?.outcome).toBe("written");
    expect(
      await readFile(join(rootDir, "types", "bb-plugin-sdk.d.ts"), "utf8"),
    ).toContain("interface BbPluginApi");
  });

  it("reports unchanged instead of rewriting a current declaration", async () => {
    await syncPluginTypes({ rootDir, app: false });
    const before = await stat(join(rootDir, "types", "bb-plugin-sdk.d.ts"));

    const results = await syncPluginTypes({ rootDir, app: false });

    expect(results).toEqual([
      { path: "types/bb-plugin-sdk.d.ts", outcome: "unchanged" },
    ]);
    const after = await stat(join(rootDir, "types", "bb-plugin-sdk.d.ts"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("never creates app types a headless plugin did not ask for", async () => {
    await syncPluginTypes({ rootDir, app: false });

    await expect(
      readFile(join(rootDir, "types", "bb-plugin-sdk-app.d.ts"), "utf8"),
    ).rejects.toThrow();
  });

  it("refreshes existing app types even when the caller reports no bb.app", async () => {
    await mkdir(join(rootDir, "types"), { recursive: true });
    await writeFile(
      join(rootDir, "types", "bb-plugin-sdk-app.d.ts"),
      "// stale\n",
    );

    const results = await syncPluginTypes({ rootDir, app: false });

    expect(results).toContainEqual({
      path: "types/bb-plugin-sdk-app.d.ts",
      outcome: "written",
    });
    expect(
      await readFile(join(rootDir, "types", "bb-plugin-sdk-app.d.ts"), "utf8"),
    ).toContain("definePluginApp");
  });

  describe("refuses to write through a symbolic link", () => {
    it("rejects a linked declaration file and leaves the target intact", async () => {
      const victim = join(rootDir, "victim.txt");
      await writeFile(victim, "PRECIOUS\n");
      await mkdir(join(rootDir, "types"));
      await symlink(victim, join(rootDir, "types", "bb-plugin-sdk.d.ts"));

      await expect(syncPluginTypes({ rootDir, app: false })).rejects.toThrow(
        /symbolic link/,
      );
      expect(await readFile(victim, "utf8")).toBe("PRECIOUS\n");
    });

    it("rejects a linked types directory and leaves the target intact", async () => {
      const outside = join(rootDir, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "bb-plugin-sdk.d.ts"), "PRECIOUS\n");
      await symlink(outside, join(rootDir, "types"));

      await expect(syncPluginTypes({ rootDir, app: false })).rejects.toThrow(
        /symbolic link/,
      );
      expect(await readFile(join(outside, "bb-plugin-sdk.d.ts"), "utf8")).toBe(
        "PRECIOUS\n",
      );
    });
  });

  it("leaves no temporary file behind after a successful write", async () => {
    await syncPluginTypes({ rootDir, app: true });

    const entries = await readdir(join(rootDir, "types"));
    expect(entries.filter((name) => name.includes("bb-tmp"))).toEqual([]);
  });

  it("check mode reports stale files and writes nothing", async () => {
    const missing = await syncPluginTypes({
      rootDir,
      app: true,
      check: true,
    });
    expect(missing).toEqual([
      { path: "types/bb-plugin-sdk.d.ts", outcome: "stale" },
      { path: "types/bb-plugin-sdk-app.d.ts", outcome: "stale" },
    ]);
    await expect(stat(join(rootDir, "types"))).rejects.toThrow();

    await syncPluginTypes({ rootDir, app: true });
    const current = await syncPluginTypes({
      rootDir,
      app: true,
      check: true,
    });
    expect(current.every((file) => file.outcome === "unchanged")).toBe(true);
  });
});
