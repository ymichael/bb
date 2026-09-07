import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePluginBuildManifest } from "./plugin-manifest.js";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h4v4z"/></svg>';
const ILLUSTRATOR_SVG = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 16.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" viewBox="0 0 64 64">
<metadata><sfw xmlns="http://ns.adobe.com/SaveForWeb/1.0/"><slices></slices></sfw></metadata>
<switch>
	<foreignObject requiredExtensions="http://ns.adobe.com/AdobeIllustrator/10.0/" x="0" y="0" width="1" height="1"/>
	<g i:extraneous="self"><path fill="#231F20" d="M0 0h64v64H0z"/></g>
</switch>
</svg>
`;

describe("validatePluginBuildManifest: bb.branding assets", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function fixture(
    icons: Record<string, string>,
    files: Record<string, string> = {},
    branding: Record<string, unknown> = {
      icon: "Zap",
      experimental_icons: icons,
    },
  ): Promise<{ dir: string; manifest: unknown }> {
    const dir = await mkdtemp(join(tmpdir(), "bb-plugin-icons-build-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "server.ts"), "export default () => {};\n");
    for (const [relative, contents] of Object.entries(files)) {
      await mkdir(join(dir, relative, ".."), { recursive: true });
      await writeFile(join(dir, relative), contents);
    }
    return {
      dir,
      manifest: {
        name: "bb-plugin-icons-fixture",
        version: "0.0.0",
        bb: {
          name: "Icons fixture",
          description: "Declares icons.",
          branding,
          server: "./server.ts",
        },
      },
    };
  }

  it("accepts declared icons that resolve to valid SVG files inside the plugin", async () => {
    const { dir, manifest } = await fixture(
      { receipt: "./icons/receipt.svg" },
      { "icons/receipt.svg": SVG },
    );
    const parsed = await validatePluginBuildManifest(
      manifest,
      dir,
      join(dir, "package.json"),
    );
    expect(parsed.bb.branding.experimental_icons).toEqual({
      receipt: "./icons/receipt.svg",
    });
  });

  it("names the icon for a missing file, a directory, a symlink escape, and bad bytes", async () => {
    const missing = await fixture({ receipt: "./icons/receipt.svg" });
    await expect(
      validatePluginBuildManifest(
        missing.manifest,
        missing.dir,
        join(missing.dir, "package.json"),
      ),
    ).rejects.toThrow(
      /experimental_icons\["receipt"\] points at a missing file/,
    );

    const directory = await fixture(
      { receipt: "./icons/receipt.svg" },
      { "icons/receipt.svg/inner.txt": "x" },
    );
    await expect(
      validatePluginBuildManifest(
        directory.manifest,
        directory.dir,
        join(directory.dir, "package.json"),
      ),
    ).rejects.toThrow(/experimental_icons\["receipt"\] must point at a file/);

    const outside = await mkdtemp(join(tmpdir(), "bb-plugin-icons-outside-"));
    tempDirs.push(outside);
    await writeFile(join(outside, "mark.svg"), SVG);
    const escaping = await fixture({ mark: "./icons/mark.svg" });
    await mkdir(join(escaping.dir, "icons"), { recursive: true });
    await symlink(
      join(outside, "mark.svg"),
      join(escaping.dir, "icons", "mark.svg"),
    );
    await expect(
      validatePluginBuildManifest(
        escaping.manifest,
        escaping.dir,
        join(escaping.dir, "package.json"),
      ),
    ).rejects.toThrow(
      /experimental_icons\["mark"\] escapes the plugin directory through a symlink/,
    );

    const scripted = await fixture(
      { evil: "./icons/evil.svg" },
      {
        "icons/evil.svg":
          '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      },
    );
    await expect(
      validatePluginBuildManifest(
        scripted.manifest,
        scripted.dir,
        join(scripted.dir, "package.json"),
      ),
    ).rejects.toThrow(
      /experimental_icons\["evil"\] must not contain a <script> element/,
    );
  });

  it("checks an SVG logo for script vectors, naming the field and the file, and takes a tool export as declared", async () => {
    const scriptedLogo = await fixture(
      {},
      {
        "logo.svg":
          '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      },
      { icon: "Zap", logo: { light: "./logo.svg" } },
    );
    await expect(
      validatePluginBuildManifest(
        scriptedLogo.manifest,
        scriptedLogo.dir,
        join(scriptedLogo.dir, "package.json"),
      ),
    ).rejects.toThrow(
      /bb\.branding\.logo\.light \("\.\/logo\.svg"\) must not contain a <script> element/,
    );

    const handlerDark = await fixture(
      {},
      {
        "logo.svg": SVG,
        "logo-dark.svg":
          '<svg xmlns="http://www.w3.org/2000/svg"><path onload="x()" d="M0 0"/></svg>',
      },
      { icon: "Zap", logo: { light: "./logo.svg", dark: "./logo-dark.svg" } },
    );
    await expect(
      validatePluginBuildManifest(
        handlerDark.manifest,
        handlerDark.dir,
        join(handlerDark.dir, "package.json"),
      ),
    ).rejects.toThrow(
      /bb\.branding\.logo\.dark \("\.\/logo-dark\.svg"\) must not contain a <path onload> event handler attribute/,
    );

    const doctypeIcon = await fixture(
      {},
      { "icon.svg": ILLUSTRATOR_SVG },
      { icon: "./icon.svg" },
    );
    await expect(
      validatePluginBuildManifest(
        doctypeIcon.manifest,
        doctypeIcon.dir,
        join(doctypeIcon.dir, "package.json"),
      ),
    ).rejects.toThrow(
      /bb\.branding\.icon must not contain a doctype declaration/,
    );
    const externalIcon = await fixture(
      {},
      {
        "icon.svg":
          '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/x.svg#p"/></svg>',
      },
      { icon: "./icon.svg" },
    );
    await expect(
      validatePluginBuildManifest(
        externalIcon.manifest,
        externalIcon.dir,
        join(externalIcon.dir, "package.json"),
      ),
    ).resolves.toMatchObject({ bb: { branding: { icon: "./icon.svg" } } });

    const artwork = await fixture(
      {},
      {
        "logo.svg": ILLUSTRATOR_SVG,
        "logo-dark.png": "\u0089PNG<not svg>",
      },
      { icon: "Zap", logo: { light: "./logo.svg", dark: "./logo-dark.png" } },
    );
    await expect(
      validatePluginBuildManifest(
        artwork.manifest,
        artwork.dir,
        join(artwork.dir, "package.json"),
      ),
    ).resolves.toMatchObject({
      bb: {
        branding: { logo: { light: "./logo.svg", dark: "./logo-dark.png" } },
      },
    });
  });

  it("rejects a malformed map before touching the filesystem", async () => {
    const { dir, manifest } = await fixture({ Receipt: "./icons/r.svg" });
    await expect(
      validatePluginBuildManifest(manifest, dir, join(dir, "package.json")),
    ).rejects.toThrow(/bb\.branding\.experimental_icons\.Receipt/);
  });
});
