import { appendOutput, formatProcessOutput } from "./smoke-output.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";
import { createPackagedAppLaunchArguments } from "./packaged-app-launch.mjs";
import { resolvePackagedAppBinary } from "./packaged-app-paths.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const releaseDir = join(desktopPackageRoot, "release");
const releaseChannel = resolveDesktopReleaseChannel(process.env);
const releaseConfig = createDesktopReleaseConfig(releaseChannel);
const startupTimeoutMs = 20_000;
const exitTimeoutMs = 5_000;
const outputFlushTimeoutMs = 2_000;
const postReadySettleMs = 300;
function writeJson(response, body) {
  response.writeHead(200, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function writeHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function writeNotFound(response) {
  response.writeHead(404, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ message: "not found" }));
}

function createDesktopVersionFeed(platform, version) {
  return {
    schemaVersion: 1,
    // The app rejects a feed whose channel is not its own, so a nightly
    // packaged build must be smoked against a nightly feed.
    channel: releaseChannel,
    platform,
    version,
    releaseDate: new Date(0).toISOString(),
    releaseName: `bb desktop ${version}`,
    releaseNotes: null,
    minimumSystemVersion: null,
    files: [
      {
        url: "https://example.invalid/bb.zip",
        sha512: "smoke",
        size: 0,
      },
    ],
    path: "bb.zip",
    sha512: "smoke",
    stagingPercentage: null,
  };
}

function renderSmokePage(expectedDesktopPlatform, expectedDesktopVersion) {
  return `<!doctype html>
<meta charset="utf-8">
<title>bb packaged desktop smoke</title>
<main>packaged desktop smoke</main>
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
      const expectedPlatform = ${JSON.stringify(expectedDesktopPlatform)};
      const expectedVersion = ${JSON.stringify(expectedDesktopVersion)};
      ok =
        window.bbDesktop.platform === expectedPlatform &&
        window.bbDesktop.version === expectedVersion &&
        info.version === expectedVersion;
      reason = ok ? "" : "unexpected desktop bridge info";
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

async function readDesktopPackageVersion() {
  const packageJsonText = await readFile(
    join(desktopPackageRoot, "package.json"),
    "utf8",
  );
  const packageJson = JSON.parse(packageJsonText);
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error("apps/desktop/package.json must define a version");
  }
  return packageJson.version;
}

async function startSmokeServer({
  dataDir,
  expectedDesktopPlatform,
  expectedDesktopVersion,
}) {
  let resolvePreloadReady = () => {};
  const preloadReady = new Promise((resolvePromise) => {
    resolvePreloadReady = resolvePromise;
  });
  const server = createServer((request, response) => {
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
        },
        customThemes: [],
        dataDir,
        experiments: {
          mobileApp: false,
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

    if (request.url === "/desktop-version.json") {
      writeJson(
        response,
        createDesktopVersionFeed(
          expectedDesktopPlatform,
          expectedDesktopVersion,
        ),
      );
      return;
    }

    if (request.url === "/" || request.url === "/index.html") {
      writeHtml(
        response,
        renderSmokePage(expectedDesktopPlatform, expectedDesktopVersion),
      );
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
  });

  await new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected desktop smoke server to listen on a TCP port");
  }

  return {
    close: async () => {
      await new Promise((resolvePromise, rejectPromise) => {
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

async function waitForOutputFlush(child) {
  await Promise.race([
    new Promise((resolveClosed) => {
      child.once("close", resolveClosed);
    }),
    sleep(outputFlushTimeoutMs),
  ]);
}

async function waitForPreloadReady({ child, preloadReady, stdout, stderr }) {
  return await new Promise((resolvePromise, rejectPromise) => {
    let exited = false;
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(
        new Error(
          `Timed out waiting for the packaged Electron app to report ready.\n${formatProcessOutput(
            { stdout, stderr },
          )}`,
        ),
      );
    }, startupTimeoutMs);

    const handleExit = (code, signal) => {
      exited = true;
      cleanup();
      void waitForOutputFlush(child).then(() => {
        rejectPromise(
          new Error(
            `Packaged Electron app exited before startup completed: code=${String(
              code,
            )} signal=${String(signal)}.\n${formatProcessOutput({
              stdout,
              stderr,
            })}`,
          ),
        );
      });
    };
    const handleError = (error) => {
      cleanup();
      rejectPromise(
        new Error(
          `Could not launch packaged Electron app: ${
            error instanceof Error ? error.message : String(error)
          }.\n${formatProcessOutput({ stdout, stderr })}`,
        ),
      );
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
      child.off("error", handleError);
    };

    child.once("exit", handleExit);
    child.once("error", handleError);
    preloadReady.then(
      (result) => {
        if (exited) return;
        cleanup();
        resolvePromise(result);
      },
      (error) => {
        if (exited) return;
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

async function sleep(delayMs) {
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise((resolvePromise) => {
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

async function stopPackagedApp(child) {
  if (await waitForProcessExit(child, 0)) {
    return;
  }

  child.kill("SIGTERM");
  if (await waitForProcessExit(child, exitTimeoutMs)) {
    return;
  }

  child.kill("SIGKILL");
  await waitForProcessExit(child, exitTimeoutMs);
}

async function smokePackagedApp() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Packaged desktop smoke only runs on macOS or Linux.");
  }

  const desktopVersion = await readDesktopPackageVersion();
  const desktopPlatform = process.platform === "darwin" ? "macos" : "linux";
  const appBinary = await resolvePackagedAppBinary({
    executableName: releaseConfig.linuxExecutableName,
    platform: process.platform,
    productName: releaseConfig.applicationName,
    releaseDir,
  });
  const smokeRoot = await mkdtemp(join(tmpdir(), "bb-desktop-packaged-smoke-"));
  const dataDir = join(smokeRoot, "data");
  const userDataDir = join(smokeRoot, "user-data");
  const smokeServer = await startSmokeServer({
    dataDir,
    expectedDesktopPlatform: desktopPlatform,
    expectedDesktopVersion: desktopVersion,
  });
  const serverUrl = `http://127.0.0.1:${smokeServer.port}`;
  const stdout = [];
  const stderr = [];
  const childEnv = {
    ...process.env,
    BB_DATA_DIR: dataDir,
    // The smoke server answers the bb probe, so a packaged build treats it as a
    // foreign bb and asks before attaching. No one is here to click, so opt out
    // and keep exercising the real attach path.
    BB_DESKTOP_ATTACH_WITHOUT_PROMPT: "1",
    BB_DESKTOP_OPEN_DEVTOOLS: "0",
    BB_DESKTOP_VERSION_FEED_URL: `${serverUrl}/desktop-version.json`,
    BB_SERVER_PORT: String(smokeServer.port),
  };
  delete childEnv.BB_DESKTOP_APP_URL;
  delete childEnv.BB_DESKTOP_NODE_EXEC_PATH;
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    appBinary,
    createPackagedAppLaunchArguments({
      platform: process.platform,
      userDataDir,
    }),
    {
      env: childEnv,
    },
  );
  child.stdout.on("data", (chunk) => {
    appendOutput(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    appendOutput(stderr, chunk);
  });

  try {
    const preloadReady = await waitForPreloadReady({
      child,
      preloadReady: smokeServer.preloadReady,
      stdout,
      stderr,
    });
    if (!preloadReady.ok) {
      throw new Error(
        `Packaged desktop preload bridge did not become ready: ${preloadReady.reason}`,
      );
    }

    await sleep(postReadySettleMs);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Packaged Electron app exited after startup: code=${String(
          child.exitCode,
        )} signal=${String(child.signalCode)}.\n${formatProcessOutput({
          stdout,
          stderr,
        })}`,
      );
    }

    console.log(`Packaged desktop smoke passed: ${appBinary}`);
  } finally {
    await stopPackagedApp(child);
    await smokeServer.close();
    await rm(smokeRoot, { force: true, recursive: true });
  }
}

await smokePackagedApp().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : error;
  console.error(message);
  process.exitCode = 1;
});
