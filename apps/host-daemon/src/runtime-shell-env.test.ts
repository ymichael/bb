import fs from "node:fs/promises";
import os from "node:os";
import path, { delimiter } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareRuntimeShellEnv,
  resolveLocalBbExecutableDirectory,
} from "./runtime-shell-env.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directoryPath);
  return directoryPath;
}

interface FakeCliPackageOptions {
  binPath?: string;
  executable?: boolean;
  writeEntry?: boolean;
}

interface FakeCliPackage {
  cliEntryPath: string;
  cliPackageManifestPath: string;
}

async function createFakeCliPackage(
  options: FakeCliPackageOptions = {},
): Promise<FakeCliPackage> {
  const cliPackageRoot = await makeTempDir("bb-cli-package-");
  const cliPackageManifestPath = path.join(cliPackageRoot, "package.json");
  const binPath = options.binPath ?? "./dist/bin/bb";
  const cliEntryPath = path.resolve(cliPackageRoot, binPath);

  await fs.writeFile(
    cliPackageManifestPath,
    JSON.stringify({
      name: "@bb/cli",
      bin: {
        bb: binPath,
      },
    }),
  );

  if (options.writeEntry ?? true) {
    await fs.mkdir(path.dirname(cliEntryPath), { recursive: true });
    await fs.writeFile(
      cliEntryPath,
      "#!/usr/bin/env node\nprocess.stdout.write('bb')\n",
      { mode: options.executable ? 0o755 : 0o644 },
    );
    await fs.chmod(cliEntryPath, options.executable ? 0o755 : 0o644);
  }

  return {
    cliEntryPath,
    cliPackageManifestPath,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directoryPath) =>
      fs.rm(directoryPath, { recursive: true, force: true }),
    ),
  );
});

describe("resolveLocalBbExecutableDirectory", () => {
  it("returns the built CLI executable directory", async () => {
    const { cliEntryPath, cliPackageManifestPath } = await createFakeCliPackage({
      executable: true,
    });

    await expect(
      resolveLocalBbExecutableDirectory({
        cliPackageManifestPath,
      }),
    ).resolves.toBe(path.dirname(cliEntryPath));
  });

  it("fails clearly when the built CLI entry is missing", async () => {
    const { cliEntryPath, cliPackageManifestPath } = await createFakeCliPackage({
      writeEntry: false,
    });

    await expect(
      resolveLocalBbExecutableDirectory({
        cliPackageManifestPath,
      }),
    ).rejects.toThrow(
      `Missing built bb CLI entry at ${cliEntryPath}. Build @bb/cli before starting the host daemon.`,
    );
  });

  it("fails clearly when the built CLI entry is not executable", async () => {
    const { cliEntryPath, cliPackageManifestPath } = await createFakeCliPackage({
      executable: false,
    });

    await expect(
      resolveLocalBbExecutableDirectory({
        cliPackageManifestPath,
      }),
    ).rejects.toThrow(
      `Resolved bb CLI entry is not executable: ${cliEntryPath}. Build @bb/cli before starting the host daemon.`,
    );
  });
});

describe("prepareRuntimeShellEnv", () => {
  it("prepends the configured bb executable directory to PATH", () => {
    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        inheritedPath: "/usr/bin",
        localApiPort: 3002,
        serverUrl: "http://127.0.0.1:3334",
      }),
    ).toEqual({
      PATH: `/tmp/bb-bin${delimiter}/usr/bin`,
      BB_SERVER_URL: "http://127.0.0.1:3334",
      BB_HOST_DAEMON_PORT: "3002",
    });
  });
});
