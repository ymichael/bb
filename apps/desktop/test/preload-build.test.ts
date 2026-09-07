import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(__filename);
const electronBinary = require("electron") as string;
const desktopPackageRoot = process.cwd();
const ELECTRON_STARTUP_TIMEOUT_MS = 15_000;
const ELECTRON_EXIT_TIMEOUT_MS = 5_000;
const ELECTRON_POST_READY_SETTLE_MS = 300;

const desktopPackageJsonSchema = z.object({
  version: z.string().min(1),
});

interface DesktopSmokeServer {
  close(): Promise<void>;
  port: number;
  preloadReady: Promise<PreloadReadyResult>;
}

interface PreloadReadyResult {
  ok: boolean;
  reason: string;
}

interface StartDesktopSmokeServerArgs {
  dataDir: string;
  expectedDesktopVersion: string;
}

function writeJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function writeHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function writeNotFound(response: ServerResponse): void {
  response.writeHead(404, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ message: "not found" }));
}

function renderSmokePage(expectedDesktopVersion: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>bb desktop smoke</title>
<main>desktop smoke</main>
<script>
(async () => {
  let ok = false;
  let reason = "";
  try {
    if (typeof window.bbDesktop !== "object" || window.bbDesktop === null) {
      reason = "missing window.bbDesktop";
    } else if (typeof window.bbDesktop.getInfo !== "function") {
      reason = "missing window.bbDesktop.getInfo";
    } else {
      const info = await window.bbDesktop.getInfo();
      const expectedVersion = ${JSON.stringify(expectedDesktopVersion)};
      ok = window.bbDesktop.version === expectedVersion && info.version === expectedVersion;
      reason = ok ? "" : "unexpected desktop version";
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const params = new URLSearchParams({
    ok: ok ? "1" : "0",
    reason,
  });
  await fetch("/smoke/preload-ready?" + params.toString(), { method: "POST" });
})();
</script>`;
}

async function startDesktopSmokeServer(
  args: StartDesktopSmokeServerArgs,
): Promise<DesktopSmokeServer> {
  let resolvePreloadReady: (result: PreloadReadyResult) => void = () => {};
  const preloadReady = new Promise<PreloadReadyResult>((resolvePromise) => {
    resolvePreloadReady = resolvePromise;
  });
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === "/health") {
        writeJson(response, { ok: true });
        return;
      }

      if (request.url === "/api/v1/system/config") {
        writeJson(response, {
          appearance: {
            customCss: null,
            faviconColor: "default",
            themeId: "default",
            resolvedCodeTheme: {
              dark: "pierre-dark",
              light: "pierre-light",
              files: {},
            },
          },
          customThemes: [],
          pluginThemes: [],
          dataDir: args.dataDir,
          experiments: {
            changelogPreview: false,
            editMessages: false,
            mobileApp: false,
            sidebarProgressiveDisclosure: false,
            timelineWindowing: false,
          },
          featureFlags: {
            placeholder: false,
          },
          generalSettings: {},
          hostDaemonPort: 38887,
          primaryHostPlatform: null,
          voiceTranscriptionEnabled: false,
        });
        return;
      }

      if (request.url === "/" || request.url === "/index.html") {
        writeHtml(response, renderSmokePage(args.expectedDesktopVersion));
        return;
      }

      if (request.url?.startsWith("/smoke/preload-ready") === true) {
        const url = new URL(request.url, "http://127.0.0.1");
        resolvePreloadReady({
          ok: url.searchParams.get("ok") === "1",
          reason: url.searchParams.get("reason") ?? "",
        });
        response.writeHead(204);
        response.end();
        return;
      }

      writeNotFound(response);
    },
  );

  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected desktop smoke server to listen on a TCP port");
  }

  return {
    close: async () => {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    port: address.port,
    preloadReady,
  };
}

function formatProcessOutput(args: {
  stderr: string[];
  stdout: string[];
}): string {
  const stdout = args.stdout.join("").trim();
  const stderr = args.stderr.join("").trim();
  return [
    stdout.length > 0 ? `stdout:\n${stdout}` : "",
    stderr.length > 0 ? `stderr:\n${stderr}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

async function waitForPreloadReady(args: {
  child: ChildProcessWithoutNullStreams;
  preloadReady: Promise<PreloadReadyResult>;
  stderr: string[];
  stdout: string[];
  timeoutMs: number;
}): Promise<PreloadReadyResult> {
  return await new Promise<PreloadReadyResult>(
    (resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        cleanup();
        rejectPromise(
          new Error(
            `Timed out waiting for the Electron smoke page to report ready.\n${formatProcessOutput(
              args,
            )}`,
          ),
        );
      }, args.timeoutMs);

      const handleExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        cleanup();
        rejectPromise(
          new Error(
            `Electron exited before startup completed: code=${String(
              code,
            )} signal=${String(signal)}.\n${formatProcessOutput(args)}`,
          ),
        );
      };

      const cleanup = () => {
        clearTimeout(timeout);
        args.child.off("exit", handleExit);
      };

      args.child.once("exit", handleExit);
      args.preloadReady.then(
        (result) => {
          cleanup();
          resolvePromise(result);
        },
        (error: unknown) => {
          cleanup();
          rejectPromise(error);
        },
      );
    },
  );
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolvePromise) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolvePromise(false);
    }, timeoutMs);

    const handleExit = () => {
      cleanup();
      resolvePromise(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
    };

    child.once("exit", handleExit);
  });
}

async function stopElectron(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (await waitForProcessExit(child, 0)) {
    return;
  }

  child.kill("SIGTERM");
  if (await waitForProcessExit(child, ELECTRON_EXIT_TIMEOUT_MS)) {
    return;
  }

  child.kill("SIGKILL");
  await waitForProcessExit(child, ELECTRON_EXIT_TIMEOUT_MS);
}

async function readDesktopPackageVersion(): Promise<string> {
  const packageJsonText = await readFile(
    resolve(desktopPackageRoot, "package.json"),
    "utf8",
  );
  return desktopPackageJsonSchema.parse(JSON.parse(packageJsonText)).version;
}

describe("desktop build", () => {
  it("emits package-compatible Electron entries", async () => {
    const desktopVersion = await readDesktopPackageVersion();

    await execFileAsync(process.execPath, ["scripts/build.mjs"], {
      cwd: desktopPackageRoot,
    });

    const mainSource = await readFile(
      resolve(desktopPackageRoot, "dist", "main.js"),
      "utf8",
    );
    const preloadSource = await readFile(
      resolve(desktopPackageRoot, "dist", "preload.cjs"),
      "utf8",
    );
    const bridgeSource = await readFile(
      resolve(desktopPackageRoot, "dist", "bb-app-bridge.mjs"),
      "utf8",
    );

    expect(mainSource).toContain('"use strict";');
    expect(mainSource).not.toMatch(/^import\s/mu);

    expect(preloadSource).toContain(desktopVersion);
    expect(preloadSource).not.toContain("BB_DESKTOP_VERSION");
    expect(preloadSource).not.toContain("getDesktopVersion(process.env");

    expect(bridgeSource).toContain('import "bb-app/dist/bb-app.js"');

    for (const mapPath of [
      "main.js.map",
      "preload.cjs.map",
      "log-viewer-preload.cjs.map",
      "bb-app-bridge.mjs.map",
    ]) {
      await expect(
        access(resolve(desktopPackageRoot, "dist", mapPath)),
      ).resolves.toBeUndefined();
    }

    if (process.platform !== "darwin") {
      return;
    }

    const smokeRoot = await mkdtemp(join(tmpdir(), "bb-desktop-smoke-"));
    const smokeServer = await startDesktopSmokeServer({
      dataDir: join(smokeRoot, "data"),
      expectedDesktopVersion: desktopVersion,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BB_DATA_DIR: join(smokeRoot, "data"),
      BB_DESKTOP_AUTO_UPDATE: "0",
      BB_DESKTOP_OPEN_DEVTOOLS: "0",
      BB_DESKTOP_VERSION_CHECK: "0",
      BB_SERVER_PORT: String(smokeServer.port),
    };
    delete childEnv.BB_DESKTOP_APP_URL;
    delete childEnv.BB_DESKTOP_NODE_EXEC_PATH;
    delete childEnv.ELECTRON_RUN_AS_NODE;

    const child = spawn(
      electronBinary,
      [`--user-data-dir=${join(smokeRoot, "user-data")}`, "."],
      {
        cwd: desktopPackageRoot,
        env: childEnv,
      },
    );
    child.stdout.on("data", (chunk) => {
      stdout.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(String(chunk));
    });

    try {
      const preloadReady = await waitForPreloadReady({
        child,
        preloadReady: smokeServer.preloadReady,
        stderr,
        stdout,
        timeoutMs: ELECTRON_STARTUP_TIMEOUT_MS,
      });
      expect(preloadReady).toEqual({ ok: true, reason: "" });

      await sleep(ELECTRON_POST_READY_SETTLE_MS);
      expect(
        child.exitCode,
        `Electron exited after startup.\n${formatProcessOutput({
          stderr,
          stdout,
        })}`,
      ).toBeNull();
      expect(
        child.signalCode,
        `Electron exited after startup.\n${formatProcessOutput({
          stderr,
          stdout,
        })}`,
      ).toBeNull();
    } finally {
      await stopElectron(child);
      await smokeServer.close();
      await rm(smokeRoot, { force: true, recursive: true });
    }
  }, 30_000);
});
