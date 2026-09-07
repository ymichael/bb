import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSystemProviderInfos } from "../../../src/services/system/execution-options.js";
import { resolveCreateThreadExecutionDefaults } from "../../../src/services/threads/thread-default-policy.js";
import { withTestHarness } from "../../helpers/test-app.js";

async function writePlugin(
  dir: string,
  options: {
    bridgeSource?: string;
    name: string;
    serverSource: string;
    withBridge?: boolean;
  },
): Promise<string> {
  const withBridge = options.withBridge ?? true;
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "Provider fixture",
        description: "Provider registration plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(withBridge ? { host: "./bridge.ts" } : {}),
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  if (withBridge) {
    await writeFile(
      join(rootDir, "bridge.ts"),
      options.bridgeSource ??
        "export const experimental_providerBridge = { experimental_apiVersion: 1, handleLine: () => undefined };\n",
    );
  }
  return rootDir;
}

const REGISTER_PROVIDER_SOURCE = (id: string): string => `
  export default function plugin(bb: any) {
    bb.providers.register({
      id: ${JSON.stringify(id)},
      displayName: "My Remote Agent",
      icon: "./icons/agent.svg",
      maintenance: { health: true, usage: true, installation: false },
      capabilities: {
        supportsServiceTier: true,
        supportsNativeUserQuestion: true,
        fork: "tip",
        supportsManualCompaction: true,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["accept-edits", "full"],
        reasoningLevels: ["low", "medium", "high"],
      },
      composerActions: ["plan"],
    });
  }
`;

describe("bb.providers.register (server)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-provider-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("adds the provider to the composed listing and removes it when the plugin is disabled", async () => {
    await withTestHarness(async (harness) => {
      const notifySystem = vi.spyOn(harness.deps.hub, "notifySystem");
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-remote-agent",
        serverSource: REGISTER_PROVIDER_SOURCE("my-remote-agent"),
      });
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status).toBe("running");
      expect(notifySystem).toHaveBeenCalledWith([
        "plugins-changed",
        "provider-registrations-changed",
      ]);

      const registration = harness.deps.providerRegistry.get("my-remote-agent");
      expect(registration).toMatchObject({
        pluginId: entry.id,
        info: {
          id: "my-remote-agent",
          displayName: "My Remote Agent",
          available: true,
          logoUrl: "/api/v1/system/providers/my-remote-agent/logo",
          maintenance: { health: true, usage: true, installation: false },
          capabilities: {
            supportsThreadArchive: false,
            supportsThreadRename: false,
            supportsServiceTier: true,
            supportsNativeUserQuestion: true,
            supportsFork: true,
            permissionModes: ["accept-edits", "full"],
          },
          composerActions: [
            { kind: "skills", trigger: "/" },
            {
              kind: "plan",
              command: { trigger: "/", name: "plan", trailingText: " " },
            },
          ],
        },
        serverCapabilities: {
          reasoningLevels: ["low", "medium", "high"],
        },
      });
      expect(registration?.serverCapabilities.supportsManualCompaction).toBe(
        true,
      );

      const providers = await listSystemProviderInfos(harness.deps, {});
      expect(providers.map((provider) => provider.id)).toContain(
        "my-remote-agent",
      );

      notifySystem.mockClear();
      await harness.pluginService.setEnabled(entry.id, false);
      expect(notifySystem).toHaveBeenCalledWith([
        "plugins-changed",
        "provider-registrations-changed",
      ]);
      expect(harness.deps.providerRegistry.get("my-remote-agent")).toBeNull();
      const afterDisable = await listSystemProviderInfos(harness.deps, {});
      expect(afterDisable.map((provider) => provider.id)).not.toContain(
        "my-remote-agent",
      );
      notifySystem.mockRestore();
    });
  });

  it("keeps a failed provider in the listing as unavailable", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-failed-agent",
        serverSource: REGISTER_PROVIDER_SOURCE("failed-agent"),
        bridgeSource: 'import "missing-provider-runtime";\n',
      });
      const entry = await harness.pluginService.installPath(rootDir);

      expect(entry.status).toBe("error");
      expect(entry.statusDetail).toContain("Could not resolve");
      expect(harness.deps.providerRegistry.get("failed-agent")?.info).toEqual(
        expect.objectContaining({
          id: "failed-agent",
          displayName: "My Remote Agent",
          available: false,
        }),
      );
      expect(
        (await listSystemProviderInfos(harness.deps, {})).find(
          (provider) => provider.id === "failed-agent",
        ),
      ).toEqual(expect.objectContaining({ available: false }));

      await writeFile(
        join(rootDir, "bridge.ts"),
        "export const experimental_providerBridge = { experimental_apiVersion: 1, handleLine: () => undefined };\n",
      );
      await harness.pluginService.reload(entry.id);
      expect(
        harness.pluginService.list().find((plugin) => plugin.id === entry.id)
          ?.status,
      ).toBe("running");
      expect(
        harness.deps.providerRegistry.get("failed-agent")?.info.available,
      ).toBe(true);
      expect(
        harness.deps.providerRegistry
          .list()
          .filter((provider) => provider.info.id === "failed-agent"),
      ).toHaveLength(1);

      await harness.pluginService.setEnabled(entry.id, false);
      expect(harness.deps.providerRegistry.get("failed-agent")).toBeNull();
    });
  });

  it("makes the registered provider usable by thread policy end to end", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-policy-agent",
        serverSource: REGISTER_PROVIDER_SOURCE("policy-agent"),
      });
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status).toBe("running");
      const registry = harness.deps.providerRegistry;

      const resolved = resolveCreateThreadExecutionDefaults(registry, {
        requestedProviderId: "policy-agent",
        storedDefaults: null,
      });
      expect(resolved.providerId).toBe("policy-agent");
      expect(
        registry.getSupportedPermissionModes("policy-agent"),
      ).not.toBeNull();
    });
  });

  it("re-registers wholesale on reload instead of colliding with itself", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-reload-agent",
        serverSource: REGISTER_PROVIDER_SOURCE("reload-agent"),
      });
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status).toBe("running");
      expect(harness.deps.providerRegistry.get("reload-agent")).not.toBeNull();

      await harness.pluginService.reload(entry.id);

      const reloaded = harness.deps.providerRegistry.get("reload-agent");
      expect(reloaded).toMatchObject({
        pluginId: entry.id,
      });
      const listed = harness.deps.providerRegistry
        .list()
        .filter((candidate) => candidate.info.id === "reload-agent");
      expect(listed).toHaveLength(1);
    });
  });

  it("serves a path-shaped icon through the provider logo route with untrusted-image headers", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-marked-agent",
        serverSource: REGISTER_PROVIDER_SOURCE("marked-agent"),
      });
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><style>.a{fill:#f00}</style><path class="a" d="M0 0h4v4z"/></svg>`;
      await mkdir(join(rootDir, "icons"), { recursive: true });
      await writeFile(join(rootDir, "icons", "agent.svg"), svg);
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status, entry.statusDetail ?? "").toBe("running");

      const logo = await harness.app.request(
        "http://127.0.0.1:3334/api/v1/system/providers/marked-agent/logo",
      );
      expect(logo.status).toBe(200);
      expect(logo.headers.get("content-type")).toBe("image/svg+xml");
      expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
      expect(logo.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(logo.headers.get("cache-control")).toBe("no-store");
      expect(await logo.text()).toBe(svg);
    });
  });

  it("serves a path-shaped icon as declared even when it carries an event handler", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-scripted-agent",
        serverSource: REGISTER_PROVIDER_SOURCE("scripted-agent"),
      });
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path onload="x()" d="M0 0"/></svg>`;
      await mkdir(join(rootDir, "icons"), { recursive: true });
      await writeFile(join(rootDir, "icons", "agent.svg"), svg);
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status, entry.statusDetail ?? "").toBe("running");
      expect(
        harness.deps.providerRegistry.get("scripted-agent"),
      ).not.toBeNull();

      const logo = await harness.app.request(
        "http://127.0.0.1:3334/api/v1/system/providers/scripted-agent/logo",
      );
      expect(logo.status).toBe(200);
      expect(logo.headers.get("content-type")).toBe("image/svg+xml");
      expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
      expect(logo.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(await logo.text()).toBe(svg);
    });
  });

  it("refuses a declaration with no bridge to run on", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-bridgeless-agent",
        serverSource: REGISTER_PROVIDER_SOURCE("bridgeless-agent"),
        withBridge: false,
      });
      const entry = await harness.pluginService.installPath(rootDir);

      expect(entry.status).toBe("error");
      expect(entry.statusDetail).toContain(
        'provider "bridgeless-agent" has no bridge to run on',
      );
      expect(harness.deps.providerRegistry.get("bridgeless-agent")).toBeNull();
      const providers = await listSystemProviderInfos(harness.deps, {});
      expect(providers.map((provider) => provider.id)).not.toContain(
        "bridgeless-agent",
      );
    });
  });

  it("rejects a live id claimed by another plugin as a load failure", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-shadow-codex",
        serverSource: REGISTER_PROVIDER_SOURCE("codex"),
      });
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status).toBe("error");
      expect(entry.statusDetail).toContain(
        'Provider "codex" is already registered; a plugin cannot shadow an existing provider.',
      );
      expect(harness.deps.providerRegistry.get("codex")?.pluginId).toBe(
        "provider-codex",
      );
      const providers = await listSystemProviderInfos(harness.deps, {});
      expect(
        providers.filter((provider) => provider.id === "codex"),
      ).toHaveLength(1);
    });
  });
});
