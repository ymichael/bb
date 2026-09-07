import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const { values } = parseArgs({
  options: {
    "dev-browser": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Usage: smoke:browser-broker [--dev-browser /absolute/path/to/dev-browser]",
  );
  process.exit(0);
}
const artifacts = await mkdtemp(join(tmpdir(), "bb-browser-broker-smoke-"));
const releaseChecksum =
  "986362bf28dec2463ff80f9e06fc9f1d9765f187f5a4ab2245ed77bef8216a6d";
const releaseUrl =
  "https://github.com/SawyerHood/dev-browser/releases/download/v1.0.0-rc.2/dev-browser-linux-x64";
try {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("This smoke pins the Linux x64 DevBrowser binary");
  console.log(`Browser broker smoke artifacts: ${artifacts}`);
  const source = values["dev-browser"] === undefined ? "release" : "local";
  const bytes = await (async () => {
    if (values["dev-browser"] !== undefined)
      return readFile(resolve(values["dev-browser"]));
    const response = await fetch(releaseUrl, {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(`DevBrowser download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  })();
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (source === "release" && checksum !== releaseChecksum)
    throw new Error("DevBrowser release checksum mismatch");
  const devBrowser = join(artifacts, "dev-browser");
  await writeFile(devBrowser, bytes, { mode: 0o700 });
  const electronFixture = join(artifacts, "electron-fixture.cjs");
  await build({
    entryPoints: [join(desktopRoot, "test/fixtures/browser-broker-smoke.ts")],
    outfile: electronFixture,
    bundle: true,
    platform: "node",
    format: "cjs",
    conditions: ["source"],
    external: ["electron"],
    legalComments: "none",
  });
  const configPath = join(artifacts, "launcher-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      artifacts,
      devBrowser,
      checksum,
      source,
      electron: require("electron"),
      electronFixture,
      repoRoot,
    }),
    { mode: 0o600 },
  );
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: "test",
    BB_DATA_DIR: join(artifacts, "bb-data"),
    BB_SERVER_URL: "http://127.0.0.1:1",
  };
  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      join(repoRoot, "apps/server/scripts/desktop-browser-broker-smoke.mjs"),
      configPath,
    ],
    { cwd: repoRoot, env: environment, stdio: "inherit", detached: true },
  );
  const timer = setTimeout(() => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }, 150000);
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => done(value ?? 1));
  }).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`Browser broker smoke exited ${code}`);
  const result = JSON.parse(
    await readFile(join(artifacts, "result.json"), "utf8"),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Artifacts retained at ${artifacts}`);
  process.exitCode = 1;
}
