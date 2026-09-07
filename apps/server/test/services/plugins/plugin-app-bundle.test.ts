import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertInstalledPlugin } from "@bb/db";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@bb/domain";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const BASE = "http://127.0.0.1:3334";

const run = promisify(execFile);

async function hasBinary(command: string): Promise<boolean> {
  try {
    await run(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const hasNpm = await hasBinary("npm");

function npmPersistence(packageName: string, version: string) {
  return {
    provenance: { kind: "direct" } as const,
    sourceIntent: {
      kind: "npm" as const,
      packageName,
      registry: "https://registry.npmjs.org",
      requestedSpec: version,
      specKind: "exact" as const,
    },
    exactResolution: {
      kind: "npm" as const,
      version,
      integrity: "test-integrity",
    },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    activeArtifactId: null,
  };
}

const SERVER_SOURCE = `export default function plugin(bb: any) { bb.log.info("loaded"); }`;
const APP_SOURCE = `export default function App() {\n  return <div className="line-clamp-2">hi</div>;\n}\n`;
const COMPRESSIBLE_APP_SOURCE = `const payload = ${JSON.stringify(
  "compressible plugin bundle payload ".repeat(200),
)};\nexport default function App() {\n  return <div className="line-clamp-2" data-payload={payload}>hi</div>;\n}\n`;

async function writeAppPluginFixture(
  rootDir: string,
  options: {
    name: string;
    app?: boolean;
    appSource?: string;
    serverSource?: string;
  },
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "App bundle fixture",
        description: "Plugin app bundle fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(options.app === false ? {} : { app: "./app.tsx" }),
      },
    }),
  );
  await writeFile(
    join(rootDir, "server.ts"),
    options.serverSource ?? SERVER_SOURCE,
  );
  if (options.app !== false) {
    await writeFile(join(rootDir, "app.tsx"), options.appSource ?? APP_SOURCE);
  }
}

describe("plugin app bundles (build policy, inventory, asset routes)", () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    harness = await createTestAppHarness();
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  it("builds path installs at install time and serves hash-cached assets", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-appy");
    await writeAppPluginFixture(rootDir, {
      name: "bb-plugin-appy",
      appSource: COMPRESSIBLE_APP_SOURCE,
    });

    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.app.hasApp).toBe(true);
    const bundle = entry.app.bundle;
    expect(bundle).not.toBeNull();
    if (bundle === null) throw new Error("unreachable");
    expect(bundle.compatible).toBe(true);
    expect(bundle.sdkMajor).toBe(PLUGIN_SDK_MAJOR);
    expect(bundle.sdkVersion).toBe(PLUGIN_SDK_VERSION);
    expect(bundle.jsUrl).toBe(
      `/api/v1/plugins/appy/assets/app.js?h=${bundle.hash}`,
    );
    expect(bundle.cssUrl).toBe(
      `/api/v1/plugins/appy/assets/app.css?h=${bundle.hash}`,
    );
    const jsStat = await stat(join(rootDir, "dist", "app.js"));
    await stat(join(rootDir, "dist", "app.meta.json"));
    expect(bundle.jsBytes).toBe(jsStat.size);

    const js = await harness.app.request(`${BASE}${bundle.jsUrl}`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const jsText = await js.text();
    expect(jsText).toContain("__bbPluginRuntime");
    expect(js.headers.get("content-encoding")).toBeNull();
    expect(js.headers.get("content-length")).toBe(
      String(Buffer.byteLength(jsText)),
    );

    const brotliJs = await harness.app.request(`${BASE}${bundle.jsUrl}`, {
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(brotliJs.headers.get("content-encoding")).toBe("br");
    expect(
      brotliJs.headers
        .get("vary")
        ?.split(",")
        .map((value) => value.trim()),
    ).toContain("Accept-Encoding");
    expect(brotliJs.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const brotliJsBytes = Buffer.from(await brotliJs.arrayBuffer());
    expect(brotliJsBytes.length).toBeLessThan(Buffer.byteLength(jsText));
    expect(brotliDecompressSync(brotliJsBytes).toString()).toBe(jsText);

    const rejectedCompression = await harness.app.request(
      `${BASE}${bundle.jsUrl}`,
      { headers: { "accept-encoding": "br;q=0, gzip;q=0" } },
    );
    expect(rejectedCompression.headers.get("content-encoding")).toBeNull();
    expect(await rejectedCompression.text()).toBe(jsText);

    const brotliJsHead = await harness.app.request(`${BASE}${bundle.jsUrl}`, {
      method: "HEAD",
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(brotliJsHead.headers.get("content-encoding")).toBe("br");
    expect(brotliJsHead.headers.get("content-length")).toBe(
      String(brotliJsBytes.length),
    );
    expect((await brotliJsHead.arrayBuffer()).byteLength).toBe(0);

    const css = await harness.app.request(`${BASE}${bundle.cssUrl}`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const cssText = await css.text();
    expect(cssText).toContain("line-clamp-2");
    const scope =
      ":where([data-bb-plugin=appy],[data-bb-plugin-root]:not([data-bb-plugin]))";
    expect(cssText).toContain(`${scope} .line-clamp-2`);
    expect(cssText).toContain(`${scope}.line-clamp-2`);
    expect(cssText).not.toMatch(/@layer utilities\{\./);

    const gzipCss = await harness.app.request(`${BASE}${bundle.cssUrl}`, {
      headers: { "accept-encoding": "br;q=0, gzip;q=1" },
    });
    expect(gzipCss.headers.get("content-encoding")).toBe("gzip");
    const gzipCssBytes = Buffer.from(await gzipCss.arrayBuffer());
    expect(gzipCssBytes.length).toBeLessThan(Buffer.byteLength(cssText));
    expect(gunzipSync(gzipCssBytes).toString()).toBe(cssText);

    const staleHash = await harness.app.request(
      `${BASE}/api/v1/plugins/appy/assets/app.js?h=deadbeefdeadbeef`,
    );
    expect(staleHash.status).toBe(200);
    expect(staleHash.headers.get("cache-control")).toBe("no-store");
    const noHash = await harness.app.request(
      `${BASE}/api/v1/plugins/appy/assets/app.js`,
    );
    expect(noHash.status).toBe(200);
    expect(noHash.headers.get("cache-control")).toBe("no-store");

    const unknownPlugin = await harness.app.request(
      `${BASE}/api/v1/plugins/nope/assets/app.js`,
    );
    expect(unknownPlugin.status).toBe(404);
    const unknownFile = await harness.app.request(
      `${BASE}/api/v1/plugins/appy/assets/evil.js`,
    );
    expect(unknownFile.status).toBe(404);
  }, 60_000);

  it("reports hasApp:false for headless plugins and 404s their assets", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-headless",
    );
    await writeAppPluginFixture(rootDir, {
      name: "bb-plugin-headless",
      app: false,
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.app).toEqual({ hasApp: false, bundle: null });

    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/headless/assets/app.js`,
    );
    expect(response.status).toBe(404);
  });

  it("erases a type-only backend RPC contract import from the frontend bundle", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-typed-rpc",
    );
    await writeAppPluginFixture(rootDir, {
      name: "bb-plugin-typed-rpc",
      serverSource: `
        import { defineRpcContract } from "@get-bb/plugin-sdk";
        import { z } from "zod";
        const BACKEND_ONLY_SENTINEL = "backend-contract-must-not-bundle";
        export const rpcContract = defineRpcContract({
          echo: {
            input: z.object({ value: z.string() }),
            output: z.object({ value: z.string() }),
          },
        });
        export default function plugin(bb: any) {
          void BACKEND_ONLY_SENTINEL;
          bb.rpc.register(rpcContract, { echo: (input: any) => input });
        }
      `,
      appSource: `
        import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
        import type { rpcContract } from "./server";
        function Panel() {
          const rpc = useRpc<typeof rpcContract>();
          void rpc.call("echo", { value: "typed" });
          return <div>typed rpc</div>;
        }
        export default definePluginApp((app) => {
          app.slots.homepageSection({ id: "typed", title: "Typed", component: Panel });
        });
      `,
    });

    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    const bundled = await readFile(join(rootDir, "dist", "app.js"), "utf8");
    expect(bundled).not.toContain("backend-contract-must-not-bundle");
    expect(bundled).not.toContain("defineRpcContract");
    expect(bundled).toContain("typed rpc");
  }, 60_000);

  it("fails the install when the frontend build fails", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-bad");
    await writeAppPluginFixture(rootDir, {
      name: "bb-plugin-bad",
      appSource: "export default function App( {\n",
    });
    await expect(
      harness.pluginService.installPath(rootDir),
    ).rejects.toThrowError(/frontend bundle build for "bad" failed/);
    expect(harness.pluginService.list()).toHaveLength(0);
  }, 60_000);

  it("rebuilds a path plugin at load when the recorded SDK version is stale", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-aged");
    await writeAppPluginFixture(rootDir, { name: "bb-plugin-aged" });
    await harness.pluginService.installPath(rootDir);

    const metaPath = join(rootDir, "dist", "app.meta.json");
    await writeFile(
      metaPath,
      JSON.stringify({ sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: "0.0.0-stale" }),
    );
    await harness.pluginService.reload("aged");

    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    expect(meta.sdkVersion).toBe(PLUGIN_SDK_VERSION);
    const entry = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "aged");
    expect(entry?.app.bundle?.sdkVersion).toBe(PLUGIN_SDK_VERSION);
    expect(entry?.app.bundle?.compatible).toBe(true);
  }, 120_000);

  it("keeps an npm plugin's backend running with compatible:false on a major mismatch (no rebuild)", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-oldie");
    await writeAppPluginFixture(rootDir, { name: "bb-plugin-oldie" });
    const staleMajor = PLUGIN_SDK_MAJOR + 1;
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default {};\n");
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({ sdkMajor: staleMajor, sdkVersion: `${staleMajor}.0.0` }),
    );
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("bb-plugin-oldie", "0.1.0"),
      id: "oldie",
      source: "npm:bb-plugin-oldie@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
    });
    await harness.pluginService.reload("oldie");

    const entry = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "oldie");
    expect(entry?.status).toBe("running");
    expect(entry?.app.hasApp).toBe(true);
    expect(entry?.app.bundle).toMatchObject({
      sdkMajor: staleMajor,
      sdkVersion: `${staleMajor}.0.0`,
      compatible: false,
    });
    const meta = JSON.parse(
      await readFile(join(rootDir, "dist", "app.meta.json"), "utf8"),
    );
    expect(meta.sdkVersion).toBe(`${staleMajor}.0.0`);
    const js = await harness.app.request(
      `${BASE}${entry?.app.bundle?.jsUrl ?? ""}`,
    );
    expect(js.status).toBe(200);
  });

  it("refreshes the served bundle hash on reload-by-id after dist changes (bb plugin dev cycle)", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-devy");
    await writeAppPluginFixture(rootDir, { name: "bb-plugin-devy" });
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default 1;\n");
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
      }),
    );
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("bb-plugin-devy", "0.1.0"),
      id: "devy",
      source: "npm:bb-plugin-devy@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
    });
    await harness.pluginService.reload("devy");
    const before = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "devy")?.app.bundle;
    expect(before).not.toBeNull();

    await writeFile(join(rootDir, "dist", "app.js"), "export default 2;\n");
    const reload = await harness.app.request(
      `${BASE}/api/v1/plugins/reload?id=devy`,
      { method: "POST" },
    );
    expect(reload.status).toBe(200);

    const after = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "devy")?.app.bundle;
    expect(after).not.toBeNull();
    expect(after?.hash).not.toBe(before?.hash);
    expect(after?.jsUrl).toBe(
      `/api/v1/plugins/devy/assets/app.js?h=${after?.hash}`,
    );
    const js = await harness.app.request(`${BASE}${after?.jsUrl ?? ""}`);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("export default 2");
  });

  it("clears the served bundle and sets a status detail when a required rebuild fails", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-brittle",
    );
    await writeAppPluginFixture(rootDir, { name: "bb-plugin-brittle" });
    await harness.pluginService.installPath(rootDir);
    const before = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "brittle");
    expect(before?.app.bundle).not.toBeNull();

    await writeFile(
      join(rootDir, "app.tsx"),
      "export default function App( {\n",
    );
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({ sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: "0.0.0-stale" }),
    );
    await harness.pluginService.reload("brittle");

    const entry = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "brittle");
    expect(entry?.status).toBe("running");
    expect(entry?.statusDetail).toContain("frontend bundle rebuild failed");
    expect(entry?.app).toEqual({ hasApp: true, bundle: null });
    const js = await harness.app.request(
      `${BASE}/api/v1/plugins/brittle/assets/app.js`,
    );
    expect(js.status).toBe(404);
  }, 120_000);

  it("re-keys the bundle hash when only the meta changes (same js/css)", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-meta");
    await writeAppPluginFixture(rootDir, { name: "bb-plugin-meta" });
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default 1;\n");
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
      }),
    );
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("bb-plugin-meta", "0.1.0"),
      id: "meta",
      source: "npm:bb-plugin-meta@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
    });
    await harness.pluginService.reload("meta");
    const before = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "meta")?.app.bundle;
    expect(before?.compatible).toBe(true);

    const staleMajor = PLUGIN_SDK_MAJOR + 1;
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({ sdkMajor: staleMajor, sdkVersion: `${staleMajor}.0.0` }),
    );
    await harness.pluginService.reload("meta");
    const after = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "meta")?.app.bundle;
    expect(after?.compatible).toBe(false);
    expect(after?.hash).not.toBe(before?.hash);
  });

  it("rejects malformed bundle meta (strict parse)", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-malformed",
    );
    await writeAppPluginFixture(rootDir, { name: "bb-plugin-malformed" });
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default 1;\n");
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("bb-plugin-malformed", "0.1.0"),
      id: "malformed",
      source: "npm:bb-plugin-malformed@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
    });
    const badMetas = [
      { sdkMajor: -1, sdkVersion: "0.0.0" },
      { sdkMajor: 0.5, sdkVersion: "0.5.0" },
      { sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: "banana" },
      { sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: `${PLUGIN_SDK_MAJOR + 1}.0.0` },
    ];
    for (const badMeta of badMetas) {
      await writeFile(
        join(rootDir, "dist", "app.meta.json"),
        JSON.stringify(badMeta),
      );
      await harness.pluginService.reload("malformed");
      const entry = harness.pluginService
        .list()
        .find((plugin) => plugin.id === "malformed");
      expect(entry?.app, JSON.stringify(badMeta)).toEqual({
        hasApp: true,
        bundle: null,
      });
    }
  });

  it("stops serving assets when the plugin is disabled", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-gated");
    await writeAppPluginFixture(rootDir, { name: "bb-plugin-gated" });
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(join(rootDir, "dist", "app.js"), "export default 1;\n");
    await writeFile(
      join(rootDir, "dist", "app.meta.json"),
      JSON.stringify({
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
      }),
    );
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("bb-plugin-gated", "0.1.0"),
      id: "gated",
      source: "npm:bb-plugin-gated@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
    });
    await harness.pluginService.reload("gated");
    const bundle = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "gated")?.app.bundle;
    expect(bundle).not.toBeNull();
    const url = `${BASE}${bundle?.jsUrl ?? ""}`;
    expect((await harness.app.request(url)).status).toBe(200);

    await harness.pluginService.setEnabled("gated", false);
    expect((await harness.app.request(url)).status).toBe(404);

    await harness.pluginService.setEnabled("gated", true);
    expect((await harness.app.request(url)).status).toBe(200);
  });

  it("reports bundle:null when an npm plugin's dist is missing at load", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-bare");
    await writeAppPluginFixture(rootDir, { name: "bb-plugin-bare" });
    upsertInstalledPlugin(harness.db, {
      ...npmPersistence("bb-plugin-bare", "0.1.0"),
      id: "bare",
      source: "npm:bb-plugin-bare@0.1.0",
      rootDir,
      version: "0.1.0",
      enabled: true,
    });
    await harness.pluginService.reload("bare");

    const entry = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "bare");
    expect(entry?.status).toBe("running");
    expect(entry?.app).toEqual({ hasApp: true, bundle: null });
    const response = await harness.app.request(
      `${BASE}/api/v1/plugins/bare/assets/app.js`,
    );
    expect(response.status).toBe(404);
  });

  describe.skipIf(!hasNpm)("npm install policy", () => {
    it(
      "refuses npm installs without a prebuilt bundle and accepts prebuilt ones",
      { timeout: 180_000 },
      async () => {
        const workDir = join(harness.config.dataDir, "npm-work");

        const noDistDir = join(workDir, "no-dist");
        await writeAppPluginFixture(noDistDir, { name: "bb-plugin-nodist" });

        const prebuiltDir = join(workDir, "prebuilt");
        await writeAppPluginFixture(prebuiltDir, {
          name: "bb-plugin-prebuilt",
        });
        await mkdir(join(prebuiltDir, "dist"), { recursive: true });
        await writeFile(
          join(prebuiltDir, "dist", "app.js"),
          "export default {};\n",
        );
        await writeFile(
          join(prebuiltDir, "dist", "app.meta.json"),
          JSON.stringify({
            sdkMajor: PLUGIN_SDK_MAJOR,
            sdkVersion: PLUGIN_SDK_VERSION,
          }),
        );

        const partialDir = join(workDir, "partial");
        await writeAppPluginFixture(partialDir, {
          name: "bb-plugin-partial",
        });
        await mkdir(join(partialDir, "dist"), { recursive: true });
        await writeFile(
          join(partialDir, "dist", "server.meta.json"),
          JSON.stringify({
            sdkMajor: PLUGIN_SDK_MAJOR,
            sdkVersion: PLUGIN_SDK_VERSION,
          }),
        );
        await writeFile(
          join(partialDir, "dist", "app.js"),
          "export default {};\n",
        );
        const incompatibleMajor = PLUGIN_SDK_MAJOR + 1;
        await writeFile(
          join(partialDir, "dist", "app.meta.json"),
          JSON.stringify({
            sdkMajor: incompatibleMajor,
            sdkVersion: `${incompatibleMajor}.0.0`,
          }),
        );

        const packDir = join(workDir, "pack");
        await mkdir(packDir, { recursive: true });
        const tarballs = new Map<string, Buffer>();
        for (const [name, dir] of [
          ["bb-plugin-nodist", noDistDir],
          ["bb-plugin-prebuilt", prebuiltDir],
          ["bb-plugin-partial", partialDir],
        ] as const) {
          await run("npm", ["pack", "--pack-destination", packDir], {
            cwd: dir,
          });
          tarballs.set(
            name,
            await readFile(join(packDir, `${name}-0.1.0.tgz`)),
          );
        }

        const registry = await new Promise<Server>((resolvePromise) => {
          const server = createServer((request, response) => {
            const url = request.url ?? "";
            for (const [name, tarball] of tarballs) {
              if (url === `/${name}/-/${name}-0.1.0.tgz`) {
                response.writeHead(200, {
                  "content-type": "application/octet-stream",
                });
                response.end(tarball);
                return;
              }
              if (url === `/${name}`) {
                const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                response.writeHead(200, {
                  "content-type": "application/json",
                });
                response.end(
                  JSON.stringify({
                    name,
                    "dist-tags": { latest: "0.1.0" },
                    versions: {
                      "0.1.0": {
                        name,
                        version: "0.1.0",
                        dist: {
                          tarball: `${origin}/${name}/-/${name}-0.1.0.tgz`,
                          shasum: createHash("sha1")
                            .update(tarball)
                            .digest("hex"),
                          integrity: `sha512-${createHash("sha512")
                            .update(tarball)
                            .digest("base64")}`,
                        },
                      },
                    },
                  }),
                );
                return;
              }
            }
            response.writeHead(404);
            response.end();
          });
          server.listen(0, "127.0.0.1", () => resolvePromise(server));
        });
        const port = (registry.address() as AddressInfo).port;
        const previousRegistry = process.env.npm_config_registry;
        const previousCache = process.env.npm_config_cache;
        process.env.npm_config_registry = `http://127.0.0.1:${port}`;
        process.env.npm_config_cache = join(workDir, "npm-cache");
        try {
          await expect(
            harness.pluginService.install("npm:bb-plugin-nodist@0.1.0", {
              kind: "root",
            }),
          ).rejects.toThrowError(/must publish a prebuilt bundle/);
          expect(harness.pluginService.list()).toHaveLength(0);
          const prefix = join(
            harness.config.dataDir,
            "plugins",
            "npm",
            "bb-plugin-nodist@0.1.0",
          );
          await expect(stat(prefix)).rejects.toThrowError();

          await expect(
            harness.pluginService.install("npm:bb-plugin-partial@0.1.0", {
              kind: "root",
            }),
          ).rejects.toThrowError(
            /app artifact.*SDK major.*rebuild the app artifact/,
          );
          const partialPrefix = join(
            harness.config.dataDir,
            "plugins",
            "npm",
            "bb-plugin-partial@0.1.0",
          );
          await expect(stat(partialPrefix)).rejects.toThrowError();
          await expect(stat(`${partialPrefix}.staging`)).rejects.toThrowError();
          expect(harness.pluginService.list()).toHaveLength(0);

          const entry = await harness.pluginService.install(
            "npm:bb-plugin-prebuilt@0.1.0",
            { kind: "root" },
          );
          expect(entry.status).toBe("running");
          expect(entry.app.hasApp).toBe(true);
          expect(entry.app.bundle).toMatchObject({
            sdkMajor: PLUGIN_SDK_MAJOR,
            sdkVersion: PLUGIN_SDK_VERSION,
            compatible: true,
          });
        } finally {
          if (previousRegistry === undefined) {
            delete process.env.npm_config_registry;
          } else {
            process.env.npm_config_registry = previousRegistry;
          }
          if (previousCache === undefined) {
            delete process.env.npm_config_cache;
          } else {
            process.env.npm_config_cache = previousCache;
          }
          await new Promise<void>((resolvePromise) =>
            registry.close(() => resolvePromise()),
          );
        }
      },
    );
  });
});
