import { spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createHostJoinRequestBody,
  isMainModule,
  parseLauncherArgs,
  resolveBbAppRuntimeContext,
  resolveDataDir,
  resolvePort,
  resolveBbAppStartContext,
  resolveBbAppCommand,
} from "../src/index.js";
import { waitForProcessExit } from "../src/launcher.js";

interface DelayArgs {
  ms: number;
}

type DelayResult = "timeout";

function delay(args: DelayArgs): Promise<DelayResult> {
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      resolvePromise("timeout");
    }, args.ms);
  });
}

describe("bb-app launcher", () => {
  it("resolves production defaults for npx startup", () => {
    const context = resolveBbAppStartContext({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {},
      homeDir: "/home/tester",
    });

    expect(context.dataDir).toBe("/home/tester/.bb");
    expect(context.configFile).toBe("/home/tester/.bb/config.json");
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
    expect(
      createHostJoinRequestBody({ localJoin: true, requestedHostId: null }),
    ).toEqual({
      hostType: "persistent",
      joinMode: "local",
    });
    expect(
      createHostJoinRequestBody({
        localJoin: true,
        requestedHostId: "host_local",
      }),
    ).toEqual({
      hostId: "host_local",
      hostType: "persistent",
      joinMode: "local",
    });
  });

  it("creates persistent remote join requests without local mode", () => {
    expect(
      createHostJoinRequestBody({ localJoin: false, requestedHostId: null }),
    ).toEqual({
      hostType: "persistent",
    });
    expect(
      createHostJoinRequestBody({
        localJoin: false,
        requestedHostId: "host_remote",
      }),
    ).toEqual({
      hostId: "host_remote",
      hostType: "persistent",
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
    expect(resolveBbAppCommand(["host-daemon", "join"])).toEqual({
      args: ["join"],
      kind: "host-daemon",
    });
  });

  it("prints help for help requests", () => {
    expect(resolveBbAppCommand(["--help"])).toEqual({ kind: "help" });
    expect(resolveBbAppCommand(["help"])).toEqual({ kind: "help" });
  });

  it("parses launcher flags separately from commands", () => {
    expect(
      parseLauncherArgs([
        "host-daemon",
        "join",
        "--data-dir",
        "~/bb-data",
        "--server-url",
        "https://bb.example.test",
        "--host-daemon-port",
        "48887",
      ]),
    ).toEqual({
      options: {
        dataDir: "~/bb-data",
        help: false,
        hostDaemonPort: "48887",
        serverUrl: "https://bb.example.test",
      },
      positionals: ["host-daemon", "join"],
    });
  });

  it("uses managed config server URL when env and flags omit it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://bb.example.test" }),
      "utf8",
    );

    const context = await resolveBbAppRuntimeContext({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "managed",
    });

    expect(context.serverUrl).toBe("https://bb.example.test");
  });

  it("keeps full-stack startup local even when managed config has a server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-local-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://bb.example.test" }),
      "utf8",
    );

    const context = await resolveBbAppRuntimeContext({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
    });

    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
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

  it("observes child processes that exited before wait registration", async () => {
    const childProcess = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolvePromise, reject) => {
      childProcess.once("error", reject);
      childProcess.once("exit", () => {
        resolvePromise();
      });
    });

    await expect(
      Promise.race([waitForProcessExit(childProcess), delay({ ms: 100 })]),
    ).resolves.toEqual({ code: 7, signal: null });
  });
});
