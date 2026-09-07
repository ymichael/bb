import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_ICON_MAX_BYTES } from "@bb/domain";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const BASE = "http://127.0.0.1:3334";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16v16H4z"/></svg>`;
const OTHER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle fill="currentColor" r="8" cx="12" cy="12"/></svg>`;

async function writeIconPluginFixture(
  rootDir: string,
  options: {
    name: string;
    brandingIcon?: string;
    icons?: Record<string, string>;
    files?: Record<string, string | Buffer>;
    serverSource?: string;
    withHost?: boolean;
  },
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "Icons fixture",
        description: "Declares icons.",
        branding: {
          icon: options.brandingIcon ?? "Zap",
          ...(options.icons === undefined
            ? {}
            : { experimental_icons: options.icons }),
        },
        server: "./server.ts",
        ...(options.withHost ? { host: "./bridge.ts" } : {}),
      },
    }),
  );
  await writeFile(
    join(rootDir, "server.ts"),
    options.serverSource ?? "export default function plugin() {}\n",
  );
  if (options.withHost) {
    await writeFile(
      join(rootDir, "bridge.ts"),
      "export const experimental_providerBridge = { experimental_apiVersion: 1, handleLine: () => undefined };\n",
    );
  }
  for (const [relative, contents] of Object.entries(options.files ?? {})) {
    const path = join(rootDir, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
}

const PROVIDER_SOURCE = (icon: string): string => `
  export default function plugin(bb: any) {
    bb.providers.register({
      id: "marked-agent",
      displayName: "Marked Agent",
      icon: ${JSON.stringify(icon)},
      maintenance: { health: false, usage: false, installation: false },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        fork: "none",
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["full"],
        reasoningLevels: ["medium"],
      },
      composerActions: [],
    });
  }
`;

describe("plugin-declared icons", () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    harness = await createTestAppHarness();
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  it("serves a declared icon hashed and immutable, advertises it in the inventory, and keeps it while disabled", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-iconed",
    );
    await writeIconPluginFixture(rootDir, {
      name: "bb-plugin-iconed",
      icons: { receipt: "./icons/receipt.svg", mark: "./icons/mark.svg" },
      files: { "icons/receipt.svg": SVG, "icons/mark.svg": OTHER_SVG },
    });

    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status, entry.statusDetail ?? "").toBe("running");
    expect(entry.icons.receipt).toMatch(
      /^\/api\/v1\/plugins\/iconed\/assets\/icons\/receipt\.svg\?h=[0-9a-f]{16}$/,
    );
    expect(Object.keys(entry.icons).sort()).toEqual(["mark", "receipt"]);

    const icon = await harness.app.request(`${BASE}${entry.icons.receipt}`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
    expect(icon.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(icon.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await icon.text()).toBe(SVG);

    const noHash = await harness.app.request(
      `${BASE}/api/v1/plugins/iconed/assets/icons/mark.svg`,
    );
    expect(noHash.status).toBe(200);
    expect(noHash.headers.get("cache-control")).toBe("no-store");
    expect(await noHash.text()).toBe(OTHER_SVG);

    for (const path of [
      "/api/v1/plugins/iconed/assets/icons/missing.svg",
      "/api/v1/plugins/nope/assets/icons/receipt.svg",
      "/api/v1/plugins/iconed/assets/icons/receipt",
      "/api/v1/plugins/iconed/assets/icons/.svg",
    ]) {
      const response = await harness.app.request(`${BASE}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({
        ok: false,
        error: "plugin has no such icon",
      });
    }

    const disabled = await harness.pluginService.setEnabled("iconed", false);
    expect(disabled?.icons).toEqual(entry.icons);
    const disabledIcon = await harness.app.request(
      `${BASE}${entry.icons.receipt}`,
    );
    expect(disabledIcon.status).toBe(200);

    await harness.pluginService.remove("iconed");
    const gone = await harness.app.request(`${BASE}${entry.icons.receipt}`);
    expect(gone.status).toBe(404);
  });

  it.each([
    [
      "a missing file",
      { receipt: "./icons/receipt.svg" },
      {},
      /experimental_icons\["receipt"\] points at a missing file/,
    ],
    [
      "a non-svg path",
      { receipt: "./icons/receipt.png" },
      { "icons/receipt.png": SVG },
      /experimental_icons\.receipt.*plugin-relative \.svg/,
    ],
    [
      "a path that escapes the plugin directory",
      { receipt: "./../receipt.svg" },
      {},
      /experimental_icons\["receipt"\] escapes the plugin directory/,
    ],
    [
      "a bad name",
      { "Receipt Icon": "./icons/receipt.svg" },
      { "icons/receipt.svg": SVG },
      /experimental_icons\.Receipt Icon/,
    ],
    [
      "a script element",
      { receipt: "./icons/receipt.svg" },
      {
        "icons/receipt.svg": `<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`,
      },
      /experimental_icons\["receipt"\] must not contain a <script> element/,
    ],
    [
      "an event handler attribute",
      { receipt: "./icons/receipt.svg" },
      {
        "icons/receipt.svg": `<svg xmlns="http://www.w3.org/2000/svg"><path onload="x()" d="M0 0"/></svg>`,
      },
      /experimental_icons\["receipt"\] must not contain a <path onload> event handler/,
    ],
    [
      "an external reference",
      { receipt: "./icons/receipt.svg" },
      {
        "icons/receipt.svg": `<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/x.svg#p"/></svg>`,
      },
      /experimental_icons\["receipt"\].*only same-document "#" references/,
    ],
    [
      "an oversized file",
      { receipt: "./icons/receipt.svg" },
      {
        "icons/receipt.svg": `<svg>${" ".repeat(PLUGIN_ICON_MAX_BYTES)}</svg>`,
      },
      /experimental_icons\["receipt"\] is \d+ bytes; the limit is/,
    ],
  ])(
    "fails the load naming the icon for %s",
    async (_case, icons, files, expected) => {
      const rootDir = join(
        harness.config.dataDir,
        "fixtures",
        "bb-plugin-badicon",
      );
      await writeIconPluginFixture(rootDir, {
        name: "bb-plugin-badicon",
        icons,
        files,
      });
      await expect(
        harness.pluginService.installPath(rootDir),
      ).rejects.toThrowError(expected);
    },
  );

  it("fails the load when bb.branding.icon is a namespaced glyph, even the plugin's own", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-branded",
    );
    await writeIconPluginFixture(rootDir, {
      name: "bb-plugin-branded",
      brandingIcon: "branded/logo",
      icons: { logo: "./icons/logo.svg" },
      files: { "icons/logo.svg": SVG },
    });
    await expect(
      harness.pluginService.installPath(rootDir),
    ).rejects.toThrowError(
      /\(bb\.branding\.icon\): "branded\/logo" is a namespaced glyph/,
    );
    expect(harness.pluginService.getApi("branded")).toBeUndefined();
  });

  it("fails the load for an icon reached through a symlink outside the plugin", async () => {
    const outside = join(tmpdir(), `bb-plugin-icon-outside-${Date.now()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "receipt.svg"), SVG);
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-linked",
    );
    await writeIconPluginFixture(rootDir, {
      name: "bb-plugin-linked",
      icons: { receipt: "./icons/receipt.svg" },
    });
    await mkdir(join(rootDir, "icons"), { recursive: true });
    await symlink(
      join(outside, "receipt.svg"),
      join(rootDir, "icons", "receipt.svg"),
    );
    await expect(
      harness.pluginService.installPath(rootDir),
    ).rejects.toThrowError(
      /experimental_icons\["receipt"\] escapes the plugin directory through a symlink/,
    );
  });

  it("lets a tool presentation name one of the plugin's own declared icons and nothing else", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-tooled",
    );
    await writeIconPluginFixture(rootDir, {
      name: "bb-plugin-tooled",
      icons: { stamp: "./icons/stamp.svg" },
      files: { "icons/stamp.svg": SVG },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status, entry.statusDetail ?? "").toBe("running");
    const api = harness.pluginService.getApi("tooled")!;

    api.agents.registerTool({
      name: "stamp_tool",
      description: "Names a declared icon",
      presentation: { icon: { glyph: "tooled/stamp" } },
      parameters: { type: "object" },
      execute: () => "ok",
    });
    expect(
      harness.pluginService
        .listAgentTools()
        .find((tool) => tool.tool.name === "stamp_tool")?.tool.presentation,
    ).toMatchObject({ icon: { glyph: "tooled/stamp" } });

    expect(() =>
      api.agents.registerTool({
        name: "undeclared_tool",
        description: "Names an undeclared icon",
        presentation: { icon: { glyph: "tooled/seal" } },
        parameters: { type: "object" },
        execute: () => "ok",
      }),
    ).toThrow(
      'tool "undeclared_tool" presentation.icon "tooled/seal" is not an icon declared by plugin "tooled"',
    );
    expect(() =>
      api.agents.registerTool({
        name: "foreign_tool",
        description: "Names another plugin's icon",
        presentation: { icon: { glyph: "other-plugin/stamp" } },
        parameters: { type: "object" },
        execute: () => "ok",
      }),
    ).toThrow(
      'tool "foreign_tool" presentation.icon "other-plugin/stamp" is not an icon declared by plugin "tooled"',
    );
  });

  it("serves a provider whose icon names a declared icon through the provider logo route", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-marked",
    );
    await writeIconPluginFixture(rootDir, {
      name: "bb-plugin-marked",
      icons: { agent: "./icons/agent.svg" },
      files: { "icons/agent.svg": SVG },
      serverSource: PROVIDER_SOURCE("marked/agent"),
      withHost: true,
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status, entry.statusDetail ?? "").toBe("running");

    const registration = harness.deps.providerRegistry.get("marked-agent");
    const iconHash = registration?.icon?.hash;
    expect(iconHash).toBeTypeOf("string");
    expect(registration?.info.logoUrl).toBe(
      `/api/v1/system/providers/marked-agent/logo?h=${iconHash}`,
    );
    expect(registration?.info.icon).toBeUndefined();
    expect(registration?.iconNames).toEqual(new Set(["agent"]));

    const logo = await harness.app.request(
      `${BASE}/api/v1/system/providers/marked-agent/logo`,
    );
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(logo.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(logo.headers.get("cache-control")).toBe("no-store");
    expect(await logo.text()).toBe(SVG);

    const hashedLogo = await harness.app.request(
      `${BASE}/api/v1/system/providers/marked-agent/logo?h=${iconHash}`,
    );
    expect(hashedLogo.status).toBe(200);
    expect(hashedLogo.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await hashedLogo.text()).toBe(SVG);

    const staleLogo = await harness.app.request(
      `${BASE}/api/v1/system/providers/marked-agent/logo?h=stale`,
    );
    expect(staleLogo.headers.get("cache-control")).toBe("no-store");
  });

  it("fails the load when a provider icon names an icon the plugin did not declare", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-unmarked",
    );
    await writeIconPluginFixture(rootDir, {
      name: "bb-plugin-unmarked",
      icons: { agent: "./icons/agent.svg" },
      files: { "icons/agent.svg": SVG },
      serverSource: PROVIDER_SOURCE("unmarked/badge"),
      withHost: true,
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("error");
    expect(entry.statusDetail).toContain(
      'provider "marked-agent" icon "unmarked/badge" is not an icon declared by plugin "unmarked"',
    );
    expect(harness.deps.providerRegistry.get("marked-agent")).toBeNull();
  });
});
