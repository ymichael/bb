import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ICON_MAX_BYTES } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  assertValidPluginCompactIconSvg,
  assertValidPluginIconSvg,
  assertValidPluginLogoSvg,
} from "./svg-asset.js";

const LABEL = 'bb.branding.experimental_icons["receipt"]';
const LOGO = 'manifest bb.branding.logo.light ("./logo.svg")';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const FIRST_PARTY_BRANDING_SVGS = [
  "examples/plugins/echo-provider/icons/receipt.svg",
  "plugins/plugin-api-docs/icons/ai-generative.svg",
  "plugins/provider-acp/icons/acp.svg",
  "plugins/provider-acp/icons/cursor.svg",
  "plugins/provider-acp/icons/grok.svg",
  "plugins/provider-acp/icons/hermes-agent.svg",
  "plugins/provider-acp/icons/omp.svg",
  "plugins/provider-acp/icons/opencode.svg",
  "plugins/provider-claude-code/icons/claude-code.svg",
  "plugins/provider-codex/icons/codex.svg",
  "plugins/provider-pi/icons/pi.svg",
];

function discoverFirstPartyBrandingSvgs(): string[] {
  const files: string[] = [];
  for (const pluginsDir of ["plugins", "examples/plugins"]) {
    for (const plugin of readdirSync(join(REPO_ROOT, pluginsDir))) {
      const iconsDir = join(REPO_ROOT, pluginsDir, plugin, "icons");
      if (!existsSync(iconsDir)) continue;
      for (const file of readdirSync(iconsDir)) {
        if (file.endsWith(".svg")) {
          files.push(`${pluginsDir}/${plugin}/icons/${file}`);
        }
      }
    }
  }
  return files.sort();
}

const LATIN1_SVG: Uint8Array = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><title>Café</title><path d="M0 0h4v4z"/></svg>',
  "latin1",
);

const TOOL_EXPORTS: Array<[string, Uint8Array]> = [
  [
    "an Illustrator export: XML declaration, generator comment, legacy public doctype, SaveForWeb metadata, a switch/foreignObject fallback, an Illustrator-namespace attribute",
    encode(
      '<?xml version="1.0" encoding="utf-8"?>\n' +
        "<!-- Generator: Adobe Illustrator 16.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n" +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        '<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/" x="0px" y="0px" width="64px" height="64px" viewBox="0 0 64 64" enable-background="new 0 0 64 64" xml:space="preserve">\n' +
        '<metadata><sfw xmlns="http://ns.adobe.com/SaveForWeb/1.0/"><slices></slices><sliceSourceBounds bottomLeftOrigin="true" height="64" width="64" x="0" y="0"></sliceSourceBounds></sfw></metadata>\n' +
        '<switch><foreignObject requiredExtensions="http://ns.adobe.com/AdobeIllustrator/10.0/" x="0" y="0" width="1" height="1"/>' +
        '<g i:extraneous="self"><path fill="#231F20" d="M0 0h64v64H0z"/></g></switch>\n' +
        "</svg>\n",
    ),
  ],
  [
    "an Illustrator 10 export whose doctype declares the namespace entities",
    encode(
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.0//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd" [\n' +
        '\t<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n' +
        '\t<!ENTITY ns_xlink "http://www.w3.org/1999/xlink">\n' +
        "]>\n" +
        '<svg xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;" width="64" height="64" viewBox="0 0 64 64"><path d="M0 0h64v64H0z"/></svg>',
    ),
  ],
  [
    "an Inkscape export: a sodipodi namedview, RDF metadata, inkscape attributes",
    encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
        "<!-- Created with Inkscape (http://www.inkscape.org/) -->\n" +
        '<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="64" height="64" viewBox="0 0 64 64" version="1.1" id="svg8" inkscape:version="1.3 (0e150ed, 2023-07-21)" sodipodi:docname="logo.svg">\n' +
        '<sodipodi:namedview id="base" pagecolor="#ffffff" bordercolor="#666666" inkscape:current-layer="layer1"/>\n' +
        '<metadata id="metadata5"><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format><dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/><dc:title></dc:title></cc:Work></rdf:RDF></metadata>\n' +
        '<g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1"><path style="fill:#000000;stroke:none" d="M0 0h64v64H0z" id="path1" inkscape:connector-curvature="0"/></g>\n' +
        "</svg>\n",
    ),
  ],
  [
    "a Figma/Sketch export embedding a raster as a data: image behind a pattern",
    encode(
      '<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<rect width="64" height="64" fill="url(#pattern0)"/>' +
        '<defs><pattern id="pattern0" patternContentUnits="objectBoundingBox" width="1" height="1"><use xlink:href="#image0" transform="scale(0.015625)"/></pattern>' +
        '<image id="image0" width="64" height="64" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="/></defs>' +
        "</svg>",
    ),
  ],
  [
    "an <a>-wrapped logo linking out",
    encode(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><a xlink:href="https://example.com" target="_blank"><path d="M0 0h64v64H0z"/></a></svg>',
    ),
  ],
  [
    "full artwork: a style element, a same-document image, url() paint, a CSS escape, an external use and an external image",
    encode(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">' +
        "<style>.a{fill:#f00}</style>" +
        '<defs><linearGradient id="g"/><symbol id="s"><path d="M0 0h4v4z"/></symbol></defs>' +
        '<image href="#s" width="4" height="4"/><use xlink:href="#s"/>' +
        '<circle class="a" fill="url(#g)" style="stroke:u\\72l( \'#g\' )" r="4"/>' +
        '<use href="https://example.com/sprite.svg#mark"/><image href="https://example.com/x.png"/>' +
        '<animate attributeName="opacity" from="0" to="1" dur="1s"/>' +
        "</svg>",
    ),
  ],
  ["Latin-1 bytes", LATIN1_SVG],
];

describe("assertValidPluginCompactIconSvg (bb.branding.icon, marketplace icons)", () => {
  it("checks the document shape only: markup the response headers keep inert is accepted", () => {
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      '<svg><path onload="x()" d="M0 0"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/x.svg#p"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:div/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:1"><path d="M0 0"/></a></svg>',
    ]) {
      expect(() => assertValidPluginCompactIconSvg(encode(svg))).not.toThrow();
    }
  });

  it.each([
    [
      "a doctype",
      '<!DOCTYPE svg [<!ENTITY m "x">]><svg>&m;</svg>',
      /must not contain a doctype declaration/,
    ],
    [
      "a processing instruction",
      '<?xml-stylesheet href="x.css"?><svg/>',
      /must not contain processing instructions/,
    ],
    ["malformed XML", "<svg><g></svg>", /is not valid SVG XML/],
    ["a non-svg root", "<html/>", /must have an <svg> root element/],
    [
      "a root outside the SVG namespace",
      '<svg xmlns="http://www.w3.org/1999/xhtml"/>',
      /must have an <svg> root element/,
    ],
  ])("rejects %s and names the field", (_case, svg, expected) => {
    expect(() => assertValidPluginCompactIconSvg(encode(svg), "icon")).toThrow(
      expected,
    );
    expect(() => assertValidPluginCompactIconSvg(encode(svg), "icon")).toThrow(
      "manifest icon",
    );
  });

  it("rejects bytes that are not UTF-8, naming bb.branding.icon by default", () => {
    expect(() => assertValidPluginCompactIconSvg(LATIN1_SVG)).toThrow(
      "manifest bb.branding.icon must contain valid UTF-8 SVG bytes",
    );
  });
});

describe("assertValidPluginLogoSvg (SVG logos and provider icons, at build)", () => {
  it.each(TOOL_EXPORTS)("accepts %s", (_case, bytes) => {
    expect(() => assertValidPluginLogoSvg(bytes, LOGO)).not.toThrow();
  });

  it.each([
    [
      "script",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      /must not contain a <script> element/,
    ],
    [
      "an upper-cased SCRIPT under an un-namespaced root",
      "<svg><SCRIPT>1</SCRIPT></svg>",
      /must not contain a <SCRIPT> element/,
    ],
    [
      "a script in another namespace",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:script>1</h:script></svg>',
      /must not contain a <h:script> element/,
    ],
    [
      "a script under an unbound prefix",
      "<svg><x:script>1</x:script></svg>",
      /must not contain a <x:script> element/,
    ],
    [
      "an SVG-Tiny handler",
      '<svg xmlns="http://www.w3.org/2000/svg"><handler type="text/ecmascript">1</handler></svg>',
      /must not contain a <handler> element/,
    ],
    [
      "an SVG-Tiny listener",
      '<svg xmlns="http://www.w3.org/2000/svg"><listener event="click" handler="#h"/></svg>',
      /must not contain a <listener> element/,
    ],
    [
      "an on* attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path onclick="x()" d="M0 0"/></svg>',
      /must not contain a <path onclick> event handler attribute/,
    ],
    [
      "a mixed-case on* attribute on the root",
      '<svg OnLoad="x()"/>',
      /must not contain a <svg OnLoad> event handler attribute/,
    ],
    [
      "a SMIL event attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="opacity" onbegin="x()"/></svg>',
      /must not contain a <animate onbegin> event handler attribute/,
    ],
    [
      "a javascript: href",
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><path d="M0 0"/></a></svg>',
      /must not contain a javascript: URL in <a href>/,
    ],
    [
      "a javascript: xlink:href in mixed case behind leading whitespace",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="  JavaScript:alert(1)"/></svg>',
      /must not contain a javascript: URL in <use xlink:href>/,
    ],
    [
      "a javascript: href split by an encoded newline and tab",
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#10;scr&#9;ipt:alert(1)"><path d="M0 0"/></a></svg>',
      /must not contain a javascript: URL in <a href>/,
    ],
    [
      "a javascript: href on an image",
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="javascript:alert(1)"/></svg>',
      /must not contain a javascript: URL in <image href>/,
    ],
  ])("refuses %s and opens with the subject", (_case, svg, expected) => {
    expect(() => assertValidPluginLogoSvg(encode(svg), LOGO)).toThrow(expected);
    expect(() => assertValidPluginLogoSvg(encode(svg), LOGO)).toThrow(LOGO);
  });

  it("finds a script vector behind a legacy doctype and behind malformed markup", () => {
    expect(() =>
      assertValidPluginLogoSvg(
        encode(
          '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
        ),
        LOGO,
      ),
    ).toThrow(/must not contain a <script> element/);
    expect(() =>
      assertValidPluginLogoSvg(
        encode("<svg><g><script>1</script></svg>"),
        LOGO,
      ),
    ).toThrow(/must not contain a <script> element/);
  });

  it("does not mistake a non-script scheme or a non-event attribute for a vector", () => {
    expect(() =>
      assertValidPluginLogoSvg(
        encode(
          '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript-docs.html"><path d="M0 0"/></a><stop offset="1" opacity="1"/><marker orient="auto"/><feComposite operator="over"/></svg>',
        ),
        LOGO,
      ),
    ).not.toThrow();
  });

  it.each(FIRST_PARTY_BRANDING_SVGS)(
    "passes the build rules for the shipped %s",
    (relative) => {
      const bytes = new Uint8Array(readFileSync(join(REPO_ROOT, relative)));
      expect(() => assertValidPluginLogoSvg(bytes, relative)).not.toThrow();
    },
  );

  it("covers every SVG a first-party or example plugin ships under icons/", () => {
    expect(discoverFirstPartyBrandingSvgs()).toEqual(FIRST_PARTY_BRANDING_SVGS);
  });
});

describe("assertValidPluginIconSvg", () => {
  it("accepts a plain monochrome shape, with same-document references", () => {
    expect(() =>
      assertValidPluginIconSvg(
        encode(
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24">' +
            '<defs><path id="p" d="M2 2h20v20H2z"/></defs>' +
            '<use href="#p" fill="currentColor"/><use xlink:href="#p"/>' +
            '<linearGradient id="g"/><circle fill="url(#g)" style="stroke:url( \'#g\' )" r="4"/>' +
            '<animate attributeName="opacity" from="0" to="1" dur="1s"/>' +
            "</svg>",
        ),
        LABEL,
      ),
    ).not.toThrow();
    expect(() =>
      assertValidPluginIconSvg(encode('<svg><circle r="4"/></svg>'), LABEL),
    ).not.toThrow();
  });

  it.each([
    [
      "script",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      /<script> element/,
    ],
    [
      "an upper-cased SCRIPT under an un-namespaced root",
      "<svg><SCRIPT>1</SCRIPT></svg>",
      /<SCRIPT> element/,
    ],
    ["iframe", "<svg><iframe/></svg>", /<iframe> element/],
    [
      "an SVG-Tiny handler",
      '<svg xmlns="http://www.w3.org/2000/svg"><handler type="text/ecmascript">1</handler></svg>',
      /<handler> element/,
    ],
    [
      "an SVG-Tiny listener",
      '<svg xmlns="http://www.w3.org/2000/svg"><listener event="click" handler="#h"/></svg>',
      /<listener> element/,
    ],
    [
      "foreignObject",
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
      /<foreignObject> element/,
    ],
    [
      "image",
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="#x"/></svg>',
      /<image> element/,
    ],
    [
      "a",
      '<svg xmlns="http://www.w3.org/2000/svg"><a><path d="M0 0"/></a></svg>',
      /<a> element/,
    ],
    [
      "style",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>*{}</style></svg>',
      /<style> element/,
    ],
    [
      "an on* attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path onclick="x()" d="M0 0"/></svg>',
      /onclick> event handler/,
    ],
    [
      "an external href",
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/x.svg#p"/></svg>',
      /only same-document "#" references/,
    ],
    [
      "an external xlink:href",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="x.svg#p"/></svg>',
      /only same-document "#" references/,
    ],
    [
      "an element outside the SVG namespace",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:div/></svg>',
      /outside the SVG namespace/,
    ],
    [
      "an external url() in a style attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(https://example.com/p.svg#g)" d="M0 0"/></svg>',
      /only same-document "url\(#…\)" references/,
    ],
    [
      "an external url() in a paint attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(\'https://example.com/p.svg#g\')" d="M0 0"/></svg>',
      /only same-document "url\(#…\)" references/,
    ],
    [
      "an external url() in a filter attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path filter="url(//example.com/f.svg#f)" d="M0 0"/></svg>',
      /only same-document "url\(#…\)" references/,
    ],
    [
      "an external url() in a mask attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path mask="url(data:image/svg+xml,x)" d="M0 0"/></svg>',
      /only same-document "url\(#…\)" references/,
    ],
    [
      "an external url() in a marker attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path marker-start="url(https://example.com/m.svg#m)" d="M0 0"/></svg>',
      /only same-document "url\(#…\)" references/,
    ],
    [
      "an external url() in a cursor attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path cursor="url(https://example.com/c.cur)" d="M0 0"/></svg>',
      /only same-document "url\(#…\)" references/,
    ],
    [
      "a CSS-escaped url() in a style attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l(https://example.com/x.svg#g)" d="M0 0"/></svg>',
      /CSS escape in <path style>/,
    ],
    [
      "a CSS-escaped url() in a paint attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\\72l(https://example.com/x.svg#g)" d="M0 0"/></svg>',
      /CSS escape in <path fill>/,
    ],
    [
      "a CSS-escaped url() in a SMIL set of style",
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"><set attributeName="style" to="fill:u\\72l(https://example.com/x.svg#g)"/></path></svg>',
      /CSS escape in <set to>/,
    ],
    [
      "a CSS-escaped url() in SMIL animate values of fill",
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"><animate attributeName="fill" values="u\\72l(https://example.com/x.svg#g);red" dur="1s"/></path></svg>',
      /CSS escape in <animate values>/,
    ],
    [
      "an external image-set() in a style attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="mask-image:image-set(\'https://example.com/m.svg\' 1x)" d="M0 0"/></svg>',
      /only same-document "url\(#…\)" references/,
    ],
    [
      "an external image() in a style attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="mask-image:image(\'https://example.com/m.svg\')" d="M0 0"/></svg>',
      /only same-document "url\(#…\)" references/,
    ],
    [
      "an external src() in a style attribute",
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="mask-image:src(\'https://example.com/m.svg\')" d="M0 0"/></svg>',
      /only same-document "url\(#…\)" references/,
    ],
    [
      "a SMIL animation of href",
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="#p"><animate attributeName="href" to="https://example.com/x.svg#p"/></use></svg>',
      /must not animate "href"/,
    ],
    [
      "a SMIL set of an event handler",
      '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="onload" to="x()"/></svg>',
      /must not animate "onload"/,
    ],
    [
      "a SMIL animation of xlink:href",
      '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="xlink:href" to="#p"/></svg>',
      /must not animate "xlink:href"/,
    ],
    [
      "xml:base",
      '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://example.com/"><use href="#p"/></svg>',
      /<svg xml:base> attribute/,
    ],
    ["a doctype", '<!DOCTYPE svg [<!ENTITY m "x">]><svg>&m;</svg>', /doctype/],
    ["a non-svg root", "<html/>", /<svg> root element/],
  ])("rejects %s and names the icon", (_case, svg, expected) => {
    expect(() => assertValidPluginIconSvg(encode(svg), LABEL)).toThrow(
      expected,
    );
    expect(() => assertValidPluginIconSvg(encode(svg), LABEL)).toThrow(LABEL);
  });

  it("reports malformed XML before a rule the broken markup also breaks", () => {
    expect(() =>
      assertValidPluginIconSvg(encode("<svg><script>1</script>"), LABEL),
    ).toThrow(/not valid SVG XML/);
  });

  it("rejects a file over the byte cap before parsing it", () => {
    const padding = " ".repeat(PLUGIN_ICON_MAX_BYTES);
    expect(() =>
      assertValidPluginIconSvg(encode(`<svg>${padding}</svg>`), LABEL),
    ).toThrow(/the limit is/);
  });
});
