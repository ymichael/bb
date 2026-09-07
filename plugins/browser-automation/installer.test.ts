import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { unlink, utimes } from "node:fs/promises";
import {
  acquireLock,
  checkProvenance,
  checkSignatures,
  currentPlatform,
  installRoot,
  installRuntime,
  integrityToHex,
  type RuntimePlatform,
  type RuntimeRelease,
} from "./installer.js";
import { resolveRuntime } from "./runtime-pin.js";

const platform = currentPlatform() as RuntimePlatform;
const version = "1.0.0-test";
const binaryContent = `#!/bin/sh\necho "dev-browser ${version}"\n`;
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const tarballIntegrity = `sha512-${createHash("sha512").update("tarball").digest("base64")}`;
const release: RuntimeRelease = {
  package: "dev-browser",
  version,
  registry: "http://127.0.0.1:9",
  repository: "example/dev-browser",
  artifacts: { [platform]: sha256(binaryContent) },
};
const asset = `dev-browser-${platform}`;
const attestationPath = `/-/npm/v1/attestations/dev-browser@${version}`;

function provenance(
  repository: string,
  ref: string,
  digest = integrityToHex(tarballIntegrity),
) {
  const statement = {
    subject: [
      { name: `pkg:npm/dev-browser@${version}`, digest: { sha512: digest } },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: `https://github.com/${repository}`, ref },
        },
      },
    },
  };
  return {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
        },
      },
    ],
  };
}
const validProvenance = provenance(
  "example/dev-browser",
  `refs/tags/v${version}`,
);

const fakeNpmSource = `
const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const counter = path.join(__dirname, "calls");
fs.appendFileSync(counter, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "install") {
  if (process.env.npm_config_ignore_scripts !== "true") { console.error("scripts not ignored"); process.exit(3); }
  if (!process.env.npm_config_registry) { console.error("no registry"); process.exit(3); }
  if (!process.env.npm_config_cache) { console.error("no cache"); process.exit(3); }
  const wait = Date.now() + (config.installDelayMs ?? 0);
  while (Date.now() < wait) {}
  if (config.installExit) { console.error("registry unreachable: ENOTFOUND registry.npmjs.org"); process.exit(config.installExit); }
  const dir = path.join(process.cwd(), "node_modules", "dev-browser", "bin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dev-browser.cjs"), "shim");
  fs.writeFileSync(path.join(dir, "..", "package.json"), JSON.stringify({ name: "dev-browser", version: config.version }));
  fs.writeFileSync(path.join(process.cwd(), "node_modules", ".package-lock.json"), JSON.stringify({ packages: { "node_modules/dev-browser": { version: config.version, resolved: (config.resolvedBase ?? process.env.npm_config_registry) + "/dev-browser/-/dev-browser.tgz", integrity: config.integrity } } }));
  process.exit(0);
}
if (process.argv[2] === "audit") { process.stdout.write(JSON.stringify(config.audit)); process.exit(config.auditExit ?? 0); }
process.exit(9);
`;

let fixture: string;
let npmDir: string;
let server: Server;
let base: string;
let served: Record<string, string> = {};
let requests: string[] = [];
const dirs: string[] = [];

async function configureNpm(config: object) {
  await writeFile(
    join(npmDir, "config.json"),
    JSON.stringify({
      version,
      integrity: tarballIntegrity,
      audit: { invalid: [], missing: [] },
      ...config,
    }),
  );
  await rm(join(npmDir, "calls"), { force: true });
}
async function npmCalls(): Promise<string[]> {
  return (await readFile(join(npmDir, "calls"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
}
function env(withNpm = true): NodeJS.ProcessEnv {
  return {
    PATH: withNpm
      ? `${npmDir}:${process.env.PATH}`
      : join(fixture, "empty-bin"),
    HOME: fixture,
  };
}
async function entries(dir: string): Promise<string[]> {
  return (await readdir(installRoot(dir))).filter((entry) => entry !== "cache");
}
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(fixture, "data-"));
  dirs.push(dir);
  return dir;
}
function install(
  dir: string,
  overrides: Partial<Parameters<typeof installRuntime>[0]> = {},
) {
  return installRuntime({
    release: { ...release, registry: base },
    dataDir: dir,
    platform,
    signal: new AbortController().signal,
    env: env(),
    downloadBase: base,
    ...overrides,
  });
}

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "bb-dev-browser-installer-"));
  npmDir = join(fixture, "npm-bin");
  await mkdir(npmDir);
  await writeFile(join(npmDir, "fake-npm.js"), fakeNpmSource);
  await writeFile(
    join(npmDir, "npm"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(npmDir, "fake-npm.js")}" "$@"\n`,
    { mode: 0o755 },
  );
  server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const body = served[request.url ?? ""];
    if (body === undefined) {
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    response.setHeader("content-length", Buffer.byteLength(body));
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(fixture, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
beforeEach(async () => {
  requests = [];
  served = {
    "/SHA256SUMS": `${sha256(binaryContent)}  ${asset}\n`,
    [`/${asset}`]: binaryContent,
    [attestationPath]: JSON.stringify(validProvenance),
  };
  await configureNpm({});
});

describe("runtime installer", () => {
  it("installs the exact pinned package once and reuses it without npm or network", async () => {
    const dir = await dataDir();
    const progress: string[] = [];
    const installed = await install(dir, {
      onProgress: (detail) => progress.push(detail),
    });
    expect(installed.sha256).toBe(sha256(binaryContent));
    expect(installed.binary).toBe(
      join(
        installRoot(dir),
        `dev-browser@${version}`,
        "node_modules/dev-browser/bin/dev-browser-bin",
      ),
    );
    await access(installed.binary, constants.X_OK);
    expect(await npmCalls()).toEqual([
      `install --ignore-scripts --no-audit --no-fund --omit=dev --loglevel=error --registry=${base}`,
      `audit signatures --json --registry=${base}`,
    ]);
    expect(requests).toEqual([attestationPath, "/SHA256SUMS", `/${asset}`]);
    expect(progress).toContain(
      "verifying npm registry signature and provenance",
    );
    expect(await entries(dir)).toEqual([`dev-browser@${version}`]);
    const warm = await install(dir, {
      env: env(false),
      downloadBase: "http://127.0.0.1:9/unreachable",
    });
    expect(warm.binary).toBe(installed.binary);
    expect(requests).toHaveLength(3);
  });
  it("reinstalls when the cached binary no longer matches the pin", async () => {
    const dir = await dataDir();
    const first = await install(dir);
    await writeFile(first.binary, "#!/bin/sh\necho tampered\n", {
      mode: 0o755,
    });
    await configureNpm({});
    const second = await install(dir);
    expect(await readFile(second.binary, "utf8")).toBe(binaryContent);
    expect(await npmCalls()).toHaveLength(2);
  });
  it("refuses a binary whose digest differs from the pin and leaves nothing behind", async () => {
    const dir = await dataDir();
    served[`/${asset}`] = binaryContent.replace(version, "1.0.0-other");
    await expect(install(dir)).rejects.toThrow("not the pinned");
    expect(await entries(dir)).toEqual([]);
  });
  it("refuses a release whose SHA256SUMS disagrees with the pin", async () => {
    const dir = await dataDir();
    served["/SHA256SUMS"] = `${"0".repeat(64)}  ${asset}\n`;
    await expect(install(dir)).rejects.toThrow(
      "does not match the pinned digest",
    );
    expect(requests).toEqual([attestationPath, "/SHA256SUMS"]);
  });
  it("refuses packages without provenance from the pinned repository tag", async () => {
    const dir = await dataDir();
    served[attestationPath] = JSON.stringify(
      provenance("someone-else/dev-browser", `refs/tags/v${version}`),
    );
    await expect(install(dir)).rejects.toThrow("provenance names");
    expect(requests).toEqual([attestationPath]);
    await configureNpm({
      audit: { invalid: [{ name: "dev-browser" }], missing: [] },
    });
    await expect(install(dir)).rejects.toThrow("registry signature");
    await configureNpm({ auditExit: 1 });
    await expect(install(dir)).rejects.toThrow("npm audit signatures failed");
    await configureNpm({ resolvedBase: "http://mirror.invalid" });
    await expect(install(dir)).rejects.toThrow("not the pinned registry");
    expect(() =>
      checkProvenance(
        provenance("example/dev-browser", "refs/heads/main"),
        release,
        tarballIntegrity,
      ),
    ).toThrow("refs/heads/main");
    expect(() =>
      checkProvenance(validProvenance, release, `sha512-${"A".repeat(88)}`),
    ).toThrow("does not cover the installed tarball");
    expect(() =>
      checkProvenance({ attestations: [] }, release, tarballIntegrity),
    ).toThrow("no SLSA provenance");
    expect(() =>
      checkProvenance({ error: "Not found" }, release, tarballIntegrity),
    ).toThrow("no attestations");
    expect(() => checkSignatures({ verified: [] }, release)).toThrow(
      "unexpected report",
    );
    expect(() =>
      checkSignatures(
        { invalid: [], missing: [{ name: "dev-browser" }] },
        release,
      ),
    ).toThrow("registry signature");
  });
  it("reports npm failures, a missing npm, and an unrecorded platform clearly", async () => {
    const dir = await dataDir();
    await configureNpm({ installExit: 1 });
    await expect(install(dir)).rejects.toThrow(
      /npm install .* failed .*ENOTFOUND/s,
    );
    await expect(install(dir, { env: env(false) })).rejects.toThrow(
      "npm is not available",
    );
    await expect(
      install(dir, { release: { ...release, artifacts: {} } }),
    ).rejects.toThrow(`no verified release artifact recorded for ${platform}`);
    await expect(
      resolveRuntime({
        dataDir: dir,
        signal: new AbortController().signal,
        release: { ...release, artifacts: {} },
      }),
    ).rejects.toThrow(`no verified release artifact recorded for ${platform}`);
  });
  it("serves concurrent installs from one npm run and tolerates a stale lock", async () => {
    const dir = await dataDir();
    await mkdir(installRoot(dir), { recursive: true });
    await writeFile(
      join(installRoot(dir), `dev-browser@${version}.lock`),
      "999999999",
    );
    const foreign = join(installRoot(dir), ".staging-dev-browser@9.9.9-other");
    const ours = join(installRoot(dir), `.staging-dev-browser@${version}-old`);
    await mkdir(foreign);
    await mkdir(ours);
    const [a, b, c] = await Promise.all([
      install(dir),
      install(dir),
      install(dir),
    ]);
    expect(b.binary).toBe(a.binary);
    expect(c.binary).toBe(a.binary);
    expect(
      (await npmCalls()).filter((call) => call.startsWith("install")),
    ).toHaveLength(1);
    expect((await entries(dir)).sort()).toEqual([
      ".staging-dev-browser@9.9.9-other",
      `dev-browser@${version}`,
    ]);
  });
  it("hands the lock over in order, keeps unparsable young locks, and never removes a replaced lock", async () => {
    const dir = await dataDir();
    await mkdir(installRoot(dir), { recursive: true });
    const path = join(installRoot(dir), "test.lock");
    const signal = new AbortController().signal;
    await writeFile(path, "not-a-pid");
    const young = acquireLock(path, AbortSignal.timeout(600));
    await expect(young).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("not-a-pid");
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    const unlockA = await acquireLock(path, signal);
    expect(await readFile(path, "utf8")).toMatch(
      new RegExp(`^${process.pid} [0-9a-f]{16}$`),
    );
    let bHeld = false;
    const b = acquireLock(path, signal).then((unlock) => {
      bHeld = true;
      return unlock;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bHeld).toBe(false);
    await unlockA();
    const unlockB = await b;
    await unlink(path);
    const unlockC = await acquireLock(path, signal);
    await unlockB();
    expect(await readFile(path, "utf8")).toMatch(
      new RegExp(`^${process.pid} `),
    );
    await unlockC();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
  it("cancels an in-progress install, cleans up, and allows a retry", async () => {
    const dir = await dataDir();
    await configureNpm({ installDelayMs: 3_000 });
    const controller = new AbortController();
    const pending = install(dir, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(await entries(dir)).toEqual([]);
    await configureNpm({});
    await expect(install(dir)).resolves.toMatchObject({ version });
  });
});
