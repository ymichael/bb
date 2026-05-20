import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBbAppVersion } from "../version.js";

describe("resolveBbAppVersion", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bb-cli-version-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("prefers BB_APP_VERSION from the env", () => {
    expect(
      resolveBbAppVersion({
        env: { BB_APP_VERSION: "1.2.3" },
        fromDir: tempRoot,
      }),
    ).toBe("1.2.3");
  });

  it("trims whitespace around BB_APP_VERSION", () => {
    expect(
      resolveBbAppVersion({
        env: { BB_APP_VERSION: "  4.5.6  " },
        fromDir: tempRoot,
      }),
    ).toBe("4.5.6");
  });

  it("reads the bb-app package.json adjacent to the binary", async () => {
    const packageRoot = join(tempRoot, "package-root");
    const binDir = join(packageRoot, "host-daemon", "dist");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "bb-app", version: "0.0.7" }),
    );
    expect(
      resolveBbAppVersion({
        env: {},
        fromDir: binDir,
      }),
    ).toBe("0.0.7");
  });

  it("ignores adjacent package.json files that are not bb-app", async () => {
    const repoRoot = join(tempRoot, "repo");
    const cliDistDir = join(repoRoot, "apps", "cli", "dist");
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({ name: "bb", version: "0.0.0", private: true }),
    );
    await writeFile(
      join(repoRoot, "apps", "cli", "package.json"),
      JSON.stringify({ name: "@bb/cli", version: "0.0.1" }),
    );
    const bbAppDir = join(repoRoot, "packages", "bb-app");
    await mkdir(bbAppDir, { recursive: true });
    await writeFile(
      join(bbAppDir, "package.json"),
      JSON.stringify({ name: "bb-app", version: "0.1.2" }),
    );
    expect(
      resolveBbAppVersion({
        env: {},
        fromDir: cliDistDir,
      }),
    ).toBe("0.1.2");
  });

  it("falls back to the dev sentinel when no bb-app package.json is found", () => {
    expect(
      resolveBbAppVersion({
        env: {},
        fromDir: tempRoot,
      }),
    ).toBe("0.0.0-dev");
  });
});
