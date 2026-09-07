import { appendOutput, formatProcessOutput } from "./smoke-output.mjs";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPackagedAppLaunchArguments } from "./packaged-app-launch.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const releaseDir = join(desktopPackageRoot, "release");
const startupTimeoutMs = 60_000;
const exitTimeoutMs = 10_000;
const outputFlushTimeoutMs = 2_000;
const pollIntervalMs = 100;
async function sleep(delayMs) {
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

async function waitFor({
  describe,
  predicate,
  retryErrors = true,
  timeoutMs = startupTimeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const result = await predicate();
      if (result !== false && result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      if (!retryErrors) {
        throw error;
      }
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }

  const detail =
    lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${describe}.${detail}`);
}

function parseEphemeralTcpPortRange(rawRange) {
  const ports = rawRange.trim().split(/\s+/u).map(Number);
  const [firstPort, lastPort] = ports;
  if (
    ports.length !== 2 ||
    !Number.isInteger(firstPort) ||
    !Number.isInteger(lastPort) ||
    firstPort < 1 ||
    lastPort > 65_535 ||
    firstPort > lastPort
  ) {
    throw new Error("Invalid Linux ephemeral TCP port range");
  }
  return { firstPort, lastPort };
}

async function reserveTcpPort(port) {
  const server = createServer();
  const reserved = await new Promise((resolvePromise, rejectPromise) => {
    const handleError = (error) => {
      if (error.code === "EADDRINUSE") {
        resolvePromise(null);
        return;
      }
      rejectPromise(error);
    };
    server.once("error", handleError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", handleError);
      resolvePromise(server);
    });
  });
  return reserved;
}

async function allocateNonEphemeralTcpPorts(count) {
  const range = parseEphemeralTcpPortRange(
    await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8"),
  );
  const candidateRanges = [
    { firstPort: 65_535, lastPort: range.lastPort + 1 },
    { firstPort: range.firstPort - 1, lastPort: 1_024 },
  ];
  const reservations = [];
  try {
    for (const candidateRange of candidateRanges) {
      for (
        let port = candidateRange.firstPort;
        port >= candidateRange.lastPort && reservations.length < count;
        port -= 1
      ) {
        const server = await reserveTcpPort(port);
        if (server !== null) {
          reservations.push({ port, server });
        }
      }
    }
    if (reservations.length !== count) {
      throw new Error(`Unable to reserve ${String(count)} non-ephemeral ports`);
    }
    return reservations.map((reservation) => reservation.port);
  } finally {
    await Promise.all(
      reservations.map(
        (reservation) =>
          new Promise((resolvePromise, rejectPromise) => {
            reservation.server.close((error) => {
              if (error) {
                rejectPromise(error);
                return;
              }
              resolvePromise();
            });
          }),
      ),
    );
  }
}

async function resolveAppImage() {
  const entries = await readdir(releaseDir, { withFileTypes: true });
  const appImages = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".AppImage"))
    .map((entry) => join(releaseDir, entry.name))
    .sort();
  if (appImages.length !== 1) {
    throw new Error(
      `Expected exactly one AppImage under ${releaseDir}, found ${String(
        appImages.length,
      )}`,
    );
  }
  return appImages[0];
}

function parseProcessStat(stat) {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return {
    processGroupId: Number(fields[2]),
    state: fields[0] ?? "",
  };
}

function parseProcessEnvironment(rawEnvironment) {
  const entries = rawEnvironment
    .split("\0")
    .filter((entry) => entry.length > 0);
  return Object.fromEntries(
    entries.map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex === -1) {
        return [entry, ""];
      }
      return [entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)];
    }),
  );
}

async function readProcess(pid) {
  try {
    const [stat, command, environment, executablePath] = await Promise.all([
      readFile(`/proc/${String(pid)}/stat`, "utf8"),
      readFile(`/proc/${String(pid)}/cmdline`, "utf8"),
      readFile(`/proc/${String(pid)}/environ`, "utf8"),
      readlink(`/proc/${String(pid)}/exe`),
    ]);
    return {
      command: command.split("\0").filter((part) => part.length > 0),
      environment: parseProcessEnvironment(environment),
      executablePath,
      pid,
      ...parseProcessStat(stat),
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "EACCES" ||
        error.code === "ENOENT" ||
        error.code === "EPERM" ||
        error.code === "ESRCH")
    ) {
      return null;
    }
    throw error;
  }
}

async function processIsLive(pid) {
  const processInfo = await readProcess(pid);
  return processInfo !== null && processInfo.state !== "Z";
}

async function findProcessesExecutingFromMount(mountPath) {
  const entries = await readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    const processInfo = await readProcess(Number(entry.name));
    if (
      processInfo !== null &&
      processInfo.state !== "Z" &&
      (processInfo.executablePath === mountPath ||
        processInfo.executablePath.startsWith(`${mountPath}/`))
    ) {
      processes.push(processInfo);
    }
  }
  return processes;
}

async function killProcessesExecutingFromMount(mountPath) {
  const mountProcesses = await findProcessesExecutingFromMount(mountPath);
  for (const processInfo of mountProcesses) {
    try {
      process.kill(processInfo.pid, "SIGKILL");
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ESRCH"
      ) {
        throw error;
      }
    }
  }
  if (mountProcesses.length > 0) {
    await waitFor({
      describe: `processes executing from ${mountPath} to exit`,
      predicate: async () =>
        (await findProcessesExecutingFromMount(mountPath)).length === 0,
      timeoutMs: exitTimeoutMs,
    });
  }
}

async function readOwnedRuntime(userDataDir) {
  try {
    const raw = await readFile(join(userDataDir, "owned-runtime.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.bridgePath === "string" &&
      parsed.bridgePath.length > 0 &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.serverUrl === "string" &&
      parsed.serverUrl.length > 0
    ) {
      return parsed;
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  return null;
}

function resolveMountFromBridgePath(bridgePath) {
  const marker = "/resources/app.asar.unpacked/";
  const markerIndex = bridgePath.indexOf(marker);
  if (markerIndex <= 0) {
    throw new Error(`Unexpected AppImage bridge path: ${bridgePath}`);
  }
  return bridgePath.slice(0, markerIndex);
}

function decodeMountInfoPath(path) {
  return path.replace(/\\(040|011|012|134)/gu, (match, code) => {
    if (code === "040") return " ";
    if (code === "011") return "\t";
    if (code === "012") return "\n";
    if (code === "134") return "\\";
    return match;
  });
}

async function readMountPoints() {
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  return new Set(
    mountInfo
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[4])
      .filter((path) => path !== undefined)
      .map(decodeMountInfoPath),
  );
}

async function isMounted(path) {
  return (await readMountPoints()).has(path);
}

async function unmount(path) {
  if (!(await isMounted(path))) {
    return;
  }

  let lastError = null;
  for (const command of ["fusermount3", "fusermount"]) {
    for (const options of [
      ["-u", path],
      ["-u", "-z", path],
    ]) {
      try {
        await execFileAsync(command, options);
        return;
      } catch (error) {
        lastError = error;
        if (!(await isMounted(path))) {
          return;
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          break;
        }
      }
    }
  }
  throw lastError ?? new Error(`Could not unmount ${path}`);
}

async function serverIsHealthy(serverUrl) {
  try {
    const response = await fetch(new URL("/health", serverUrl), {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function hostDaemonIsReady({ daemonPort, serverUrl }) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${String(daemonPort)}/status`,
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) {
      return false;
    }
    const status = await response.json();
    return (
      typeof status === "object" &&
      status !== null &&
      status.connected === true &&
      status.serverUrl === serverUrl
    );
  } catch {
    return false;
  }
}

async function pluginStartupIsSettled(serverUrl) {
  try {
    const response = await fetch(
      new URL("/api/v1/system/providers", serverUrl),
      { signal: AbortSignal.timeout(2_000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForChildExit(child, timeoutMs) {
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

async function stopRuntime(runtime) {
  const processInfo = await readProcess(runtime.pid);
  if (
    processInfo === null ||
    !processInfo.command.includes(runtime.bridgePath)
  ) {
    return;
  }

  process.kill(runtime.pid, "SIGTERM");
  try {
    await waitFor({
      describe: `runtime supervisor ${String(runtime.pid)} to exit`,
      predicate: async () => !(await processIsLive(runtime.pid)),
      timeoutMs: exitTimeoutMs,
    });
  } catch {
    const survivingProcess = await readProcess(runtime.pid);
    if (
      survivingProcess !== null &&
      survivingProcess.command.includes(runtime.bridgePath)
    ) {
      process.kill(runtime.pid, "SIGKILL");
    }
  }
}

async function killIsolatedProcesses({ dataDir, userDataDir }) {
  const entries = await readdir("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    if (pid === process.pid) {
      continue;
    }
    const processInfo = await readProcess(pid);
    if (
      processInfo !== null &&
      (processInfo.environment.BB_DATA_DIR === dataDir ||
        processInfo.command.includes(`--user-data-dir=${userDataDir}`))
    ) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ESRCH"
        ) {
          throw error;
        }
      }
    }
  }
}

async function smokeLinuxAppImageLifecycle() {
  if (process.platform !== "linux") {
    throw new Error("The AppImage lifecycle smoke only runs on Linux.");
  }

  const appImage = await resolveAppImage();
  const smokeRoot = await mkdtemp(
    join(tmpdir(), "bb-appimage-lifecycle-smoke-"),
  );
  const dataDir = join(smokeRoot, "data");
  const userDataDir = join(smokeRoot, "user-data");
  const stdout = [];
  const stderr = [];
  let child = null;
  let guiMount = null;
  let runtimeMount = null;
  let runtime = null;

  try {
    const [serverPort, daemonPort] = await allocateNonEphemeralTcpPorts(2);

    const childEnv = {
      ...process.env,
      BB_DATA_DIR: dataDir,
      BB_DESKTOP_AUTO_UPDATE: "0",
      BB_DESKTOP_OPEN_DEVTOOLS: "0",
      BB_DESKTOP_VERSION_CHECK: "0",
      BB_HOST_DAEMON_PORT: String(daemonPort),
      BB_SERVER_PORT: String(serverPort),
    };
    delete childEnv.APPIMAGE_EXTRACT_AND_RUN;
    delete childEnv.BB_DESKTOP_APP_URL;
    delete childEnv.BB_DESKTOP_NODE_EXEC_PATH;
    delete childEnv.ELECTRON_RUN_AS_NODE;

    child = spawn(
      appImage,
      createPackagedAppLaunchArguments({
        platform: process.platform,
        userDataDir,
      }),
      {
        detached: true,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (child.pid === undefined) {
      throw new Error("The AppImage process did not expose a PID");
    }
    child.stdout.on("data", (chunk) => appendOutput(stdout, chunk));
    child.stderr.on("data", (chunk) => appendOutput(stderr, chunk));
    const childClosed = new Promise((resolveClosed) => {
      child.once("close", resolveClosed);
    });

    runtime = await waitFor({
      describe: "the desktop-owned runtime PID file",
      predicate: async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          await Promise.race([childClosed, sleep(outputFlushTimeoutMs)]);
          throw new Error(
            `AppImage exited before its runtime started: code=${String(
              child.exitCode,
            )} signal=${String(child.signalCode)}.\n${formatProcessOutput({
              stdout,
              stderr,
            })}`,
          );
        }
        return await readOwnedRuntime(userDataDir);
      },
      retryErrors: false,
    });
    await waitFor({
      describe: `bb startup and its host daemon at ${runtime.serverUrl} to settle`,
      predicate: async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          await Promise.race([childClosed, sleep(outputFlushTimeoutMs)]);
          throw new Error(
            `AppImage exited before bb became ready: code=${String(
              child.exitCode,
            )} signal=${String(child.signalCode)}.\n${formatProcessOutput({
              stdout,
              stderr,
            })}`,
          );
        }
        if (!(await processIsLive(runtime.pid))) {
          throw new Error(
            `The owned runtime exited before bb became ready.\n${formatProcessOutput(
              { stdout, stderr },
            )}`,
          );
        }
        return (
          (await hostDaemonIsReady({
            daemonPort,
            serverUrl: runtime.serverUrl,
          })) && (await pluginStartupIsSettled(runtime.serverUrl))
        );
      },
      retryErrors: false,
    });

    const guiProcess = await readProcess(child.pid);
    const runtimeProcess = await readProcess(runtime.pid);
    if (guiProcess === null || runtimeProcess === null) {
      throw new Error("The GUI or runtime supervisor exited during startup");
    }
    if (guiProcess.processGroupId !== child.pid) {
      throw new Error("The test AppImage GUI is not its process-group leader");
    }
    if (runtimeProcess.processGroupId !== runtime.pid) {
      throw new Error(
        "The AppImage runtime supervisor is not its group leader",
      );
    }
    if (!runtimeProcess.command.includes(runtime.bridgePath)) {
      throw new Error("The runtime PID does not match its ownership marker");
    }

    guiMount = resolveMountFromBridgePath(runtime.bridgePath);
    runtimeMount = runtimeProcess.environment.APPDIR ?? null;
    if (runtimeMount === null || runtimeMount.length === 0) {
      throw new Error("The runtime supervisor did not inherit APPDIR");
    }
    if (guiMount === runtimeMount) {
      throw new Error("The GUI and owned runtime unexpectedly share a mount");
    }
    if (!(await isMounted(guiMount)) || !(await isMounted(runtimeMount))) {
      throw new Error("Expected both AppImage FUSE mounts to be active");
    }

    // The GUI is an anchored group of its own. The runtime supervisor starts a
    // separate session, so killing this exact group models an unclean desktop
    // crash without touching the owned server/daemon/watcher tree.
    process.kill(-child.pid, "SIGKILL");
    await waitForChildExit(child, exitTimeoutMs);
    await killProcessesExecutingFromMount(guiMount);
    await unmount(guiMount);
    await waitFor({
      describe: `GUI mount ${guiMount} to disappear`,
      predicate: async () => !(await isMounted(guiMount)),
      timeoutMs: exitTimeoutMs,
    });

    if (!(await processIsLive(runtime.pid))) {
      throw new Error("The owned runtime exited with the GUI AppImage");
    }
    if (!(await isMounted(runtimeMount))) {
      throw new Error(
        "The owned runtime AppImage mount disappeared with the GUI",
      );
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await serverIsHealthy(runtime.serverUrl))) {
        throw new Error("bb became unhealthy after the GUI mount teardown");
      }
      await sleep(250);
    }

    console.log(
      `AppImage lifecycle smoke passed: ${appImage}\n` +
        `GUI mount removed: ${guiMount}\n` +
        `Owned runtime remained healthy on: ${runtimeMount}`,
    );
  } finally {
    if (runtime !== null) {
      await stopRuntime(runtime);
    }
    if (
      child !== null &&
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      const guiProcess = await readProcess(child.pid);
      if (guiProcess?.processGroupId === child.pid) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
      await waitForChildExit(child, exitTimeoutMs);
    }
    await killIsolatedProcesses({ dataDir, userDataDir });
    for (const mount of [guiMount, runtimeMount]) {
      if (mount !== null) {
        await killProcessesExecutingFromMount(mount);
        await unmount(mount);
      }
    }
    await rm(smokeRoot, { force: true, recursive: true });
  }
}

await smokeLinuxAppImageLifecycle().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : error;
  console.error(message);
  process.exitCode = 1;
});
