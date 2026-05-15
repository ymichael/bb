import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createHostJoinRequestBody,
  isMainModule,
  resolveDataDir,
  resolvePort,
  resolveBbAppStartContext,
  resolveBbAppCommand,
} from "../src/index.js";

describe("bb-app launcher", () => {
  it("resolves production defaults for npx startup", () => {
    const context = resolveBbAppStartContext({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js")
        .href,
      env: {},
      homeDir: "/home/tester",
    });

    expect(context.dataDir).toBe("/home/tester/.bb");
    expect(context.serverPort).toBe(38886);
    expect(context.daemonPort).toBe(38887);
    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
    expect(context.serverEntry).toBe(
      "/repo/packages/bb-app/server/dist/index.js",
    );
    expect(context.daemonEntry).toBe(
      "/repo/packages/bb-app/host-daemon/dist/daemon-bundle.mjs",
    );
  });

  it("honors explicit production ports and data directory", () => {
    const env = {
      BB_DATA_DIR: "~/custom-bb",
      BB_HOST_DAEMON_PORT: "48887",
      BB_SERVER_PORT: "48886",
    };

    expect(resolveDataDir({ env, homeDir: "/home/tester" })).toBe(
      "/home/tester/custom-bb",
    );
    expect(resolvePort({ defaultPort: 1, env, name: "BB_SERVER_PORT" })).toBe(
      48886,
    );
    expect(
      resolvePort({ defaultPort: 1, env, name: "BB_HOST_DAEMON_PORT" }),
    ).toBe(48887);
  });

  it("creates the same local persistent join request as pnpm start", () => {
    expect(createHostJoinRequestBody({ requestedHostId: null })).toEqual({
      hostType: "persistent",
      joinMode: "local",
    });
    expect(
      createHostJoinRequestBody({ requestedHostId: "host_local" }),
    ).toEqual({
      hostId: "host_local",
      hostType: "persistent",
      joinMode: "local",
    });
  });

  it("starts bb when no command or the explicit start command is provided", () => {
    expect(resolveBbAppCommand([])).toEqual({ kind: "start" });
    expect(resolveBbAppCommand(["start"])).toEqual({ kind: "start" });
  });

  it("keeps CLI commands on the bb binary", () => {
    expect(resolveBbAppCommand(["status"])).toEqual({
      command: "status",
      kind: "invalid",
    });
    expect(resolveBbAppCommand(["thread", "list"])).toEqual({
      command: "thread",
      kind: "invalid",
    });
  });

  it("starts only the host daemon for the explicit host-daemon start command", () => {
    expect(resolveBbAppCommand(["host-daemon"])).toEqual({
      args: [],
      kind: "host-daemon",
    });
  });

  it("prints help for help requests", () => {
    expect(resolveBbAppCommand(["--help"])).toEqual({ kind: "help" });
    expect(resolveBbAppCommand(["help"])).toEqual({ kind: "help" });
  });

  it("detects npm bin symlinks as the main module", () => {
    const testDir = mkdtempSync(join(tmpdir(), "bb-bb-app-main-"));
    const realEntryPath = join(testDir, "dist-index.js");
    const symlinkPath = join(testDir, "bb");
    writeFileSync(realEntryPath, "", "utf8");
    symlinkSync(realEntryPath, symlinkPath);

    expect(
      isMainModule({
        entrypointPath: symlinkPath,
        moduleUrl: pathToFileURL(realEntryPath).href,
      }),
    ).toBe(true);
  });
});
