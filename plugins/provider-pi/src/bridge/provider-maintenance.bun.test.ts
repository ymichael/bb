import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const probeState = vi.hoisted(() => ({
  bunBin: "",
  executablePath: "",
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...original,
    experimental_commandOutput: vi.fn(async () => probeState.bunBin),
    experimental_npmLatestVersion: vi.fn(async () => "0.85.0"),
    experimental_probeNpmGlobalPackage: vi.fn(async () => ({
      npmBin: path.join(path.sep, "npm", "bin"),
      npmGlobalPackageVersion: null,
    })),
    experimental_resolveExecutablePath: vi.fn(
      async () => probeState.executablePath,
    ),
  };
});

vi.mock("./rpc-child.js", () => ({
  resolvePiLaunch: () => ({ command: probeState.executablePath, args: [] }),
}));

import {
  getPiProviderInstallationRun,
  getPiProviderInstallationStatus,
} from "./provider-maintenance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi provider maintenance with a Bun-managed executable", () => {
  it("updates through Bun when the resolved Pi command is a wrapper around Bun's global binary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-pi-bun-update-"));
    temporaryDirectories.push(root);
    probeState.bunBin = path.join(root, ".bun", "bin");
    const bunPi = path.join(probeState.bunBin, "pi");
    probeState.executablePath = path.join(root, "bin", "pi");
    await Promise.all([
      mkdir(probeState.bunBin, { recursive: true }),
      mkdir(path.dirname(probeState.executablePath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(bunPi, "#!/bin/sh\nprintf '0.84.0\\n'\n", { mode: 0o755 }),
      writeFile(
        probeState.executablePath,
        `#!/bin/sh\nexec "${bunPi}" "$@"\n`,
        { mode: 0o755 },
      ),
    ]);
    await Promise.all([
      chmod(bunPi, 0o755),
      chmod(probeState.executablePath, 0o755),
    ]);

    const status = await getPiProviderInstallationStatus();
    const run = await getPiProviderInstallationRun("update");

    expect(status.installAction?.command).toBe(
      "bun add -g @earendil-works/pi-coding-agent@latest",
    );
    expect(run).toMatchObject({
      available: true,
      command: {
        command: "bun",
        args: ["add", "-g", "@earendil-works/pi-coding-agent@latest"],
      },
    });
  });
});
