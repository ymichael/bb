import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import { loadPluginBrandingAssets } from "../../../src/services/plugins/app-bundle.js";

const BASE = "http://127.0.0.1:3334";

const SERVER_SOURCE = `export default function plugin(bb: any) { bb.log.info("loaded"); }`;
const SVG_LOGO = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>`;
const DARK_SVG_LOGO = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff" width="4" height="4"/></svg>`;
const PNG_STUB = Buffer.from("89504e470d0a1a0a", "hex");
const WEBP_STUB = Buffer.from("52494646", "hex");
const ILLUSTRATOR_LOGO = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 16.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" x="0px" y="0px" width="64px" height="64px" viewBox="0 0 64 64" enable-background="new 0 0 64 64" xml:space="preserve">
<metadata>
	<sfw xmlns="http://ns.adobe.com/SaveForWeb/1.0/">
		<slices></slices>
		<sliceSourceBounds bottomLeftOrigin="true" height="64" width="64" x="0" y="0"></sliceSourceBounds>
	</sfw>
</metadata>
<switch>
	<foreignObject requiredExtensions="http://ns.adobe.com/AdobeIllustrator/10.0/" x="0" y="0" width="1" height="1"/>
	<g i:extraneous="self">
		<path fill="#231F20" d="M0 0h64v64H0z"/>
	</g>
</switch>
</svg>
`;
const INKSCAPE_LOGO = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="64" height="64" viewBox="0 0 64 64" version="1.1" id="svg8" inkscape:version="1.3 (0e150ed, 2023-07-21)" sodipodi:docname="logo.svg">
  <sodipodi:namedview id="base" pagecolor="#ffffff" bordercolor="#666666" inkscape:current-layer="layer1"/>
  <metadata id="metadata5"><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format><dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/></cc:Work></rdf:RDF></metadata>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <path style="fill:#ffffff;stroke:none" d="M0 0h64v64H0z" id="path1" inkscape:connector-curvature="0"/>
  </g>
</svg>
`;
const UNTRUSTED_IMAGE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
};

function expectUntrustedImageHeaders(response: Response): void {
  for (const [name, value] of Object.entries(UNTRUSTED_IMAGE_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

async function writeLogoPluginFixture(
  rootDir: string,
  options: {
    name: string;
    files?: Record<string, string | Buffer>;
    logoLight?: string;
    logoDark?: string;
    pluginName?: string;
    brandingIcon?: string | null;
  },
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: options.pluginName ?? "Logo fixture",
        description: "Plugin branding fixture.",
        branding: {
          ...(options.brandingIcon === null
            ? {}
            : { icon: options.brandingIcon ?? "Zap" }),
          ...(options.logoLight === undefined && options.logoDark === undefined
            ? {}
            : {
                logo: {
                  ...(options.logoLight === undefined
                    ? {}
                    : { light: options.logoLight }),
                  ...(options.logoDark === undefined
                    ? {}
                    : { dark: options.logoDark }),
                },
              }),
        },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), SERVER_SOURCE);
  for (const [relative, contents] of Object.entries(options.files ?? {})) {
    const path = join(rootDir, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
}

describe("plugin branding assets (manifest, asset route, inventory)", () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    harness = await createTestAppHarness();
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  it("serves a path-shaped branding.icon as a hashed compact SVG asset", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-mark");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-mark",
      brandingIcon: "./assets/icon.svg",
      files: { "assets/icon.svg": SVG_LOGO },
    });

    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.icon).toBe("./assets/icon.svg");
    expect(entry.iconUrl).toMatch(
      /^\/api\/v1\/plugins\/mark\/assets\/icon\?h=[0-9a-f]{16}$/,
    );

    const icon = await harness.app.request(`${BASE}${entry.iconUrl}`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expectUntrustedImageHeaders(icon);
    expect(await icon.text()).toBe(SVG_LOGO);

    const disabled = await harness.pluginService.setEnabled("mark", false);
    expect(disabled?.iconUrl).toBe(entry.iconUrl);
    const disabledIcon = await harness.app.request(
      `${BASE}${disabled?.iconUrl}`,
    );
    expect(disabledIcon.status).toBe(200);
  });

  it("validates the exact compact icon bytes before snapshotting them; a logo is snapshotted as declared", async () => {
    const iconPath = join(harness.config.dataDir, "mutable-icon.svg");
    await writeFile(iconPath, "<html/>");

    await expect(
      loadPluginBrandingAssets("mutable", {
        branding: { compactIconPath: iconPath, icons: new Map() },
      }),
    ).rejects.toThrow(/bb\.branding\.icon must have an <svg> root element/);

    const logoPath = join(harness.config.dataDir, "mutable-logo.svg");
    const scripted = `<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`;
    await writeFile(logoPath, scripted);
    const assets = await loadPluginBrandingAssets("mutable", {
      branding: { logo: { lightPath: logoPath }, icons: new Map() },
    });
    expect(assets.logo).not.toBeNull();
    expect(new TextDecoder().decode(assets.logo?.bytes)).toBe(scripted);
  });

  it("installs a plugin whose logos are Illustrator and Inkscape exports, runs it, and serves both with the untrusted-image headers", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-logotool",
    );
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logotool",
      logoLight: "./logo.svg",
      logoDark: "./logo-dark.svg",
      files: { "logo.svg": ILLUSTRATOR_LOGO, "logo-dark.svg": INKSCAPE_LOGO },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status, entry.statusDetail ?? "").toBe("running");

    const logo = await harness.app.request(`${BASE}${entry.logoUrl}`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expectUntrustedImageHeaders(logo);
    expect(await logo.text()).toBe(ILLUSTRATOR_LOGO);
    const dark = await harness.app.request(`${BASE}${entry.logoDarkUrl}`);
    expect(dark.status).toBe(200);
    expectUntrustedImageHeaders(dark);
    expect(await dark.text()).toBe(INKSCAPE_LOGO);
  });

  it("never refuses a logo at install, load or reload: script-bearing markup and Latin-1 bytes are served as declared behind the headers", async () => {
    const rootDir = join(
      harness.config.dataDir,
      "fixtures",
      "bb-plugin-logoraw",
    );
    const scripted = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><rect width="4" height="4"/></a></svg>`;
    const latin1 = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg"><title>Café</title><rect fill="#fff" width="4" height="4"/></svg>`,
      "latin1",
    );
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logoraw",
      logoLight: "./logo.svg",
      logoDark: "./logo-dark.svg",
      files: { "logo.svg": scripted, "logo-dark.svg": latin1 },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status, entry.statusDetail ?? "").toBe("running");

    const logo = await harness.app.request(`${BASE}${entry.logoUrl}`);
    expect(logo.status).toBe(200);
    expectUntrustedImageHeaders(logo);
    expect(await logo.text()).toBe(scripted);
    const dark = await harness.app.request(`${BASE}${entry.logoDarkUrl}`);
    expect(dark.status).toBe(200);
    expectUntrustedImageHeaders(dark);
    expect(Buffer.from(await dark.arrayBuffer()).equals(latin1)).toBe(true);

    await harness.pluginService.reload("logoraw");
    const reloaded = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "logoraw");
    expect(reloaded?.status, reloaded?.statusDetail ?? "").toBe("running");
    expect(reloaded?.logoUrl).toBe(entry.logoUrl);
  });

  it("serves an explicit light SVG hash-cached as image/svg+xml", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-logoa");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logoa",
      logoLight: "./logo.svg",
      files: { "logo.svg": SVG_LOGO, "logo.png": PNG_STUB },
    });

    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.logoUrl).toMatch(
      /^\/api\/v1\/plugins\/logoa\/assets\/logo\?h=[0-9a-f]{16}$/,
    );

    const logo = await harness.app.request(`${BASE}${entry.logoUrl}`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(logo.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expectUntrustedImageHeaders(logo);
    expect(await logo.text()).toBe(SVG_LOGO);

    const noHash = await harness.app.request(
      `${BASE}/api/v1/plugins/logoa/assets/logo`,
    );
    expect(noHash.status).toBe(200);
    expect(noHash.headers.get("cache-control")).toBe("no-store");
    expectUntrustedImageHeaders(noHash);
  });

  it("serves an explicit PNG as image/png", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-logob");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logob",
      logoLight: "./logo.png",
      files: { "logo.png": PNG_STUB },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    const logo = await harness.app.request(`${BASE}${entry.logoUrl}`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expectUntrustedImageHeaders(logo);
  });

  it("honors a relocated bb.branding.logo.light webp", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-logoc");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logoc",
      logoLight: "./assets/mark.webp",
      files: {
        "logo.svg": SVG_LOGO,
        "assets/mark.webp": WEBP_STUB,
      },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    const logo = await harness.app.request(`${BASE}${entry.logoUrl}`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/webp");
  });

  it("rejects a light logo that escapes the plugin directory", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-logod");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logod",
      logoLight: "../outside.svg",
    });
    await expect(
      harness.pluginService.installPath(rootDir),
    ).rejects.toThrowError(
      /bb\.branding\.logo\.light escapes the plugin directory/,
    );
  });

  it("rejects a light logo with an unsupported extension", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-logoe");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logoe",
      logoLight: "./logo.gif",
      files: { "logo.gif": PNG_STUB },
    });
    await expect(
      harness.pluginService.installPath(rootDir),
    ).rejects.toThrowError(
      /bb\.branding\.logo\.light must point at a \.svg, \.png, or \.webp file/,
    );
  });

  it("does not auto-detect an undeclared root logo", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-logof");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logof",
      files: { "logo.svg": SVG_LOGO },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.logoUrl).toBeNull();
    const logo = await harness.app.request(
      `${BASE}/api/v1/plugins/logof/assets/logo`,
    );
    expect(logo.status).toBe(404);
  });

  it("keeps advertising and serving both logos when the plugin is disabled", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-logog");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logog",
      logoLight: "./logo.svg",
      logoDark: "./logo-dark.svg",
      files: { "logo.svg": SVG_LOGO, "logo-dark.svg": DARK_SVG_LOGO },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    const logoUrl = entry.logoUrl;
    const logoDarkUrl = entry.logoDarkUrl;
    expect(logoUrl).not.toBeNull();
    expect(logoDarkUrl).not.toBeNull();

    const disabled = await harness.pluginService.setEnabled("logog", false);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.logoUrl).toBe(logoUrl);
    expect(disabled?.logoDarkUrl).toBe(logoDarkUrl);
    const logo = await harness.app.request(`${BASE}${logoUrl}`);
    expect(logo.status).toBe(200);
    expect(await logo.text()).toBe(SVG_LOGO);
    const dark = await harness.app.request(`${BASE}${logoDarkUrl}`);
    expect(dark.status).toBe(200);
    expect(await dark.text()).toBe(DARK_SVG_LOGO);

    const enabled = await harness.pluginService.setEnabled("logog", true);
    expect(enabled?.logoUrl).toBe(logoUrl);
    expect(enabled?.logoDarkUrl).toBe(logoDarkUrl);
  });

  it("keeps a disabled plugin's manifest name and icon in the inventory", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-ident");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-ident",
      pluginName: "Identity Demo",
      brandingIcon: "Brain",
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.name).toBe("Identity Demo");
    expect(entry.icon).toBe("Brain");
    expect(entry.iconUrl).toBeNull();

    const disabled = await harness.pluginService.setEnabled("ident", false);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.name).toBe("Identity Demo");
    expect(disabled?.icon).toBe("Brain");
    expect(disabled?.logoUrl).toBe(entry.logoUrl);
  });

  it("drops a removed plugin's identity (logo 404s after uninstall)", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-gone");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-gone",
      logoLight: "./logo.svg",
      files: { "logo.svg": SVG_LOGO },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    const logoUrl = entry.logoUrl;
    expect(logoUrl).not.toBeNull();

    await harness.pluginService.remove("gone");
    const logo = await harness.app.request(`${BASE}${logoUrl}`);
    expect(logo.status).toBe(404);
  });

  it("serves immutable snapshot bytes until reload refreshes the hash", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-logoh");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-logoh",
      logoLight: "./logo.svg",
      files: { "logo.svg": SVG_LOGO },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    const firstUrl = entry.logoUrl;
    expect(firstUrl).not.toBeNull();

    const changed = `<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>`;
    await writeFile(join(rootDir, "logo.svg"), changed);

    const original = await harness.app.request(`${BASE}${firstUrl}`);
    expect(original.status).toBe(200);
    expect(await original.text()).toBe(SVG_LOGO);
    expect(original.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );

    await harness.pluginService.reload("logoh");

    const reloaded = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "logoh");
    expect(reloaded?.logoUrl).not.toBeNull();
    expect(reloaded?.logoUrl).not.toBe(firstUrl);

    const logo = await harness.app.request(`${BASE}${reloaded?.logoUrl}`);
    expect(logo.status).toBe(200);
    expect(await logo.text()).toBe(changed);
    expect(logo.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("serves an explicit dark SVG as image/svg+xml", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-darka");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-darka",
      logoLight: "./logo.svg",
      logoDark: "./logo-dark.svg",
      files: {
        "logo.svg": SVG_LOGO,
        "logo-dark.svg": DARK_SVG_LOGO,
        "logo-dark.png": PNG_STUB,
      },
    });

    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.logoUrl).toMatch(
      /^\/api\/v1\/plugins\/darka\/assets\/logo\?h=[0-9a-f]{16}$/,
    );
    expect(entry.logoDarkUrl).toMatch(
      /^\/api\/v1\/plugins\/darka\/assets\/logo-dark\?h=[0-9a-f]{16}$/,
    );

    const dark = await harness.app.request(`${BASE}${entry.logoDarkUrl}`);
    expect(dark.status).toBe(200);
    expect(dark.headers.get("content-type")).toBe("image/svg+xml");
    expect(dark.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await dark.text()).toBe(DARK_SVG_LOGO);

    const noHash = await harness.app.request(
      `${BASE}/api/v1/plugins/darka/assets/logo-dark`,
    );
    expect(noHash.status).toBe(200);
    expect(noHash.headers.get("cache-control")).toBe("no-store");
  });

  it("serves an explicit dark PNG as image/png", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-darkb");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-darkb",
      logoLight: "./logo.svg",
      logoDark: "./logo-dark.png",
      files: { "logo.svg": SVG_LOGO, "logo-dark.png": PNG_STUB },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.logoUrl).not.toBeNull();
    const dark = await harness.app.request(`${BASE}${entry.logoDarkUrl}`);
    expect(dark.status).toBe(200);
    expect(dark.headers.get("content-type")).toBe("image/png");
  });

  it("honors a relocated bb.branding.logo.dark webp", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-darkc");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-darkc",
      logoLight: "./logo.svg",
      logoDark: "./assets/mark-dark.webp",
      files: {
        "logo.svg": SVG_LOGO,
        "logo-dark.svg": DARK_SVG_LOGO,
        "assets/mark-dark.webp": WEBP_STUB,
      },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    const dark = await harness.app.request(`${BASE}${entry.logoDarkUrl}`);
    expect(dark.status).toBe(200);
    expect(dark.headers.get("content-type")).toBe("image/webp");
  });

  it("rejects a dark logo that escapes the plugin directory", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-darkd");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-darkd",
      logoLight: "./logo.svg",
      logoDark: "../outside-dark.svg",
      files: { "logo.svg": SVG_LOGO },
    });
    await expect(
      harness.pluginService.installPath(rootDir),
    ).rejects.toThrowError(
      /bb\.branding\.logo\.dark escapes the plugin directory/,
    );
  });

  it("rejects a dark logo with an unsupported extension", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-darke");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-darke",
      logoLight: "./logo.svg",
      logoDark: "./logo-dark.gif",
      files: { "logo.svg": SVG_LOGO, "logo-dark.gif": PNG_STUB },
    });
    await expect(
      harness.pluginService.installPath(rootDir),
    ).rejects.toThrowError(
      /bb\.branding\.logo\.dark must point at a \.svg, \.png, or \.webp file/,
    );
  });

  it("reports logoDarkUrl null and 404s the dark asset when only a light logo ships", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-darkf");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-darkf",
      logoLight: "./logo.svg",
      files: { "logo.svg": SVG_LOGO },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    expect(entry.logoUrl).not.toBeNull();
    expect(entry.logoDarkUrl).toBeNull();
    const dark = await harness.app.request(
      `${BASE}/api/v1/plugins/darkf/assets/logo-dark`,
    );
    expect(dark.status).toBe(404);
  });

  it("refreshes the dark logo hash on reload after the file changes", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-darkg");
    await writeLogoPluginFixture(rootDir, {
      name: "bb-plugin-darkg",
      logoLight: "./logo.svg",
      logoDark: "./logo-dark.svg",
      files: { "logo.svg": SVG_LOGO, "logo-dark.svg": DARK_SVG_LOGO },
    });
    const entry = await harness.pluginService.installPath(rootDir);
    const firstUrl = entry.logoDarkUrl;
    const firstLightUrl = entry.logoUrl;
    expect(firstUrl).not.toBeNull();

    const changed = `<svg xmlns="http://www.w3.org/2000/svg"><circle fill="#fff" r="2"/></svg>`;
    await writeFile(join(rootDir, "logo-dark.svg"), changed);
    await harness.pluginService.reload("darkg");

    const reloaded = harness.pluginService
      .list()
      .find((plugin) => plugin.id === "darkg");
    expect(reloaded?.logoDarkUrl).not.toBeNull();
    expect(reloaded?.logoDarkUrl).not.toBe(firstUrl);
    expect(reloaded?.logoUrl).toBe(firstLightUrl);

    const dark = await harness.app.request(`${BASE}${reloaded?.logoDarkUrl}`);
    expect(dark.status).toBe(200);
    expect(await dark.text()).toBe(changed);
  });
});
