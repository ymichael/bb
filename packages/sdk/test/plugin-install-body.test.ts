import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createBbSdk } from "../src/core.js";
import type { FetchImplementation } from "../src/response.js";
import { createHttpTransport } from "../src/transport-http.js";

const legacyPluginInstallRequestSchema = z
  .object({ source: z.string().min(1) })
  .strict();

const legacyInstalledPlugin = {
  id: "my-plugin",
  source: "path:/tmp/my-plugin",
  rootDir: "/tmp/my-plugin",
  version: "0.1.0",
  provenance: "direct",
  isOrphanedBuiltin: false,
  sourceDisplay: "path · /tmp/my-plugin",
  updateState: {},
  enabled: true,
  description: null,
  name: "My plugin",
  icon: null,
  iconUrl: null,
  status: "running",
  statusDetail: null,
  handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
  services: [],
  schedules: [],
  cliCommand: null,
  capabilities: [],
  hasSettings: false,
  app: { hasApp: false, bundle: null },
  logoUrl: null,
  logoDarkUrl: null,
};

function createLegacyServerSdk(): {
  sdk: ReturnType<typeof createBbSdk>;
  bodies: unknown[];
} {
  const bodies: unknown[] = [];
  const fetch: FetchImplementation = async (_input, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    bodies.push(body);
    const ok = legacyPluginInstallRequestSchema.safeParse(body).success;
    return new Response(
      JSON.stringify(
        ok
          ? { ok: true, plugin: legacyInstalledPlugin }
          : { ok: false, error: 'expected { "source": string }' },
      ),
      {
        status: ok ? 200 : 422,
        headers: { "content-type": "application/json" },
      },
    );
  };
  const sdk = createBbSdk({
    transport: createHttpTransport({
      baseUrl: "http://bb.test",
      fetch,
      runtime: "node",
    }),
  });
  return { sdk, bodies };
}

describe("issue #1662: plugin install against a pre-0.38.0 server", () => {
  it("a plain root install sends only { source } and accepts the legacy response", async () => {
    const { sdk, bodies } = createLegacyServerSdk();
    await expect(
      sdk.plugins.install({ source: "path:/tmp/my-plugin" }),
    ).resolves.toEqual({
      ...legacyInstalledPlugin,
      publisherLabel: null,
      screenshots: [],
      collections: [],
      providerIds: [],
      // Likewise for the declared-icon map, added later still.
      icons: {},
    });
    expect(bodies).toEqual([{ source: "path:/tmp/my-plugin" }]);
  });

  it("a subdirectory install still sends an explicit selection", async () => {
    const { sdk, bodies } = createLegacyServerSdk();
    await sdk.plugins
      .install({
        source: "git:github.com/acme/plugins",
        subdirectory: "packages/notes",
      })
      .catch(() => undefined);
    expect(bodies).toEqual([
      {
        source: "git:github.com/acme/plugins",
        selection: { kind: "subdirectory", path: "packages/notes" },
      },
    ]);
  });
});
