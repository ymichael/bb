import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { values } = parseArgs({
  options: {
    "dev-browser": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Usage: smoke:browser-cdp [--dev-browser /absolute/path/to/dev-browser]\nDefault: checksum-pinned release compatibility. --dev-browser copies a local build and additionally requires cross-origin snapshot refs and stale-ref invalidation.",
  );
  process.exit(0);
}
const artifacts = await mkdtemp(join(tmpdir(), "bb-cdp-smoke-"));
const releases = [
  {
    name: "dev-browser",
    version: "1.0.0-rc.2",
    repository: "SawyerHood/dev-browser",
    sha256: "986362bf28dec2463ff80f9e06fc9f1d9765f187f5a4ab2245ed77bef8216a6d",
  },
  {
    name: "agent-browser",
    version: "0.36.0",
    repository: "vercel-labs/agent-browser",
    sha256: "56d15181e51e00213f907fcf39707cfc76bfa804ff20f5a9373661c73f96de5e",
  },
];

async function download(release) {
  const asset = `${release.name}-linux-x64`;
  const url = `https://github.com/${release.repository}/releases/download/v${release.version}/${asset}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok)
    throw new Error(`Downloading ${asset}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== release.sha256) {
    throw new Error(`Checksum mismatch for ${asset}`);
  }
  const destination = join(artifacts, asset);
  await writeFile(destination, bytes, { mode: 0o700 });
  await chmod(destination, 0o700);
  return destination;
}

async function copyLocalClient(source) {
  const destination = join(artifacts, "dev-browser-local");
  await copyFile(resolve(source), destination);
  await chmod(destination, 0o700);
  return destination;
}

try {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "This compatibility harness currently pins Linux x64 client binaries",
    );
  }
  console.log(`Browser CDP smoke artifacts: ${artifacts}`);
  const devBrowserSource =
    values["dev-browser"] === undefined ? "release" : "local";
  const [devBrowser, agentBrowser] = await Promise.all([
    devBrowserSource === "release"
      ? download(releases[0])
      : copyLocalClient(values["dev-browser"]),
    download(releases[1]),
  ]);
  const devBrowserSha256 = createHash("sha256")
    .update(await readFile(devBrowser))
    .digest("hex");
  await mkdir(join(artifacts, "agent-state"));
  await writeFile(join(artifacts, "agent-config.json"), "{}\n");
  const config = { artifacts, devBrowser, devBrowserSource, agentBrowser };
  const configPath = join(artifacts, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const fixture = join(artifacts, "fixture.cjs");
  await build({
    entryPoints: [join(packageRoot, "test/fixtures/browser-cdp-smoke.ts")],
    outfile: fixture,
    bundle: true,
    platform: "node",
    format: "cjs",
    conditions: ["source"],
    external: ["electron"],
    legalComments: "none",
  });
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const electron = require("electron");
  const child = spawn(
    "xvfb-run",
    ["-a", electron, "--no-sandbox", fixture, configPath],
    {
      cwd: artifacts,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const output = [];
  let capturedBytes = 0;
  let outputTail = "";
  let gracefulExitTimer;
  let forcedExit = false;
  let checksFailed = false;
  function terminateGroup() {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  function capture(chunk) {
    capturedBytes += chunk.length;
    if (capturedBytes <= 2 * 1024 * 1024) output.push(chunk);
    process.stdout.write(chunk);
    outputTail = (outputTail + chunk.toString()).slice(-1024);
    if (outputTail.includes("BB_CDP_SMOKE_FAILED\n")) checksFailed = true;
    if (
      (outputTail.includes("BB_CDP_SMOKE_COMPLETE\n") ||
        outputTail.includes("BB_CDP_SMOKE_FAILED\n")) &&
      gracefulExitTimer === undefined
    ) {
      gracefulExitTimer = setTimeout(() => {
        forcedExit = true;
        console.log(
          "Electron fixture did not exit within 5 seconds; terminating its process group.",
        );
        terminateGroup();
      }, 5000);
    }
  }
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timeout = setTimeout(() => {
    terminateGroup();
  }, 180_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  }).finally(() => {
    clearTimeout(timeout);
    clearTimeout(gracefulExitTimer);
  });
  await writeFile(join(artifacts, "electron.log"), Buffer.concat(output));
  if (checksFailed)
    throw new Error("Browser CDP smoke checks failed; see electron.log");
  if (exitCode !== 0 && !forcedExit)
    throw new Error(`Electron smoke failed with exit ${exitCode}`);
  const summary = JSON.parse(
    await readFile(join(artifacts, "result.json"), "utf8"),
  );
  if (summary.cleanupCompleted !== true)
    throw new Error("Fixture did not finish cleanup");
  summary.forcedExit = forcedExit;
  summary.devBrowser = {
    source: devBrowserSource,
    path: devBrowser,
    sha256: devBrowserSha256,
  };
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Artifacts retained at ${artifacts}`);
  process.exitCode = 1;
}
