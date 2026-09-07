import { SaxesParser, type SaxesTagNS } from "saxes";
import { PLUGIN_ICON_MAX_BYTES } from "@bb/domain";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

const SCRIPT_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "handler",
  "listener",
]);

const FORBIDDEN_ICON_ELEMENTS: ReadonlySet<string> = new Set([
  ...SCRIPT_ELEMENTS,
  "foreignobject",
  "iframe",
  "image",
  "video",
  "audio",
  "a",
  "style",
]);

function hasExternalUrlFunction(value: string): boolean {
  for (const match of value.matchAll(
    /(?:url|src|image-set|image)\(\s*["']?\s*/giu,
  )) {
    if (value[match.index + match[0].length] !== "#") {
      return true;
    }
  }
  return false;
}

function isForbiddenAnimatedAttribute(value: string): boolean {
  const target = value.trim().toLowerCase();
  return (
    target.startsWith("on") || target === "href" || target.endsWith(":href")
  );
}

function isJavascriptUrl(value: string): boolean {
  return value
    .replace(/[\t\n\r]/gu, "")
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu, "")
    .toLowerCase()
    .startsWith("javascript:");
}

function scriptVectorProblem(tag: SaxesTagNS): string | null {
  if (SCRIPT_ELEMENTS.has(tag.local.toLowerCase())) {
    return `must not contain a <${tag.name}> element`;
  }
  for (const attribute of Object.values(tag.attributes)) {
    const name = attribute.local.toLowerCase();
    if (name.startsWith("on")) {
      return `must not contain a <${tag.name} ${attribute.name}> event handler attribute`;
    }
    if (name === "href" && isJavascriptUrl(attribute.value)) {
      return `must not contain a javascript: URL in <${tag.name} ${attribute.name}>`;
    }
  }
  return null;
}

function declaredIconProblem(tag: SaxesTagNS): string | null {
  if (tag.uri !== "" && tag.uri !== SVG_NAMESPACE) {
    return `contains a <${tag.name}> element outside the SVG namespace`;
  }
  if (FORBIDDEN_ICON_ELEMENTS.has(tag.local.toLowerCase())) {
    return `must not contain a <${tag.local}> element`;
  }
  for (const attribute of Object.values(tag.attributes)) {
    const name = attribute.local.toLowerCase();
    if (name.startsWith("on")) {
      return `must not contain a <${tag.local} ${attribute.name}> event handler attribute`;
    }
    if (name === "href" && !attribute.value.startsWith("#")) {
      return `must not reference ${JSON.stringify(attribute.value)} through <${tag.local} ${attribute.name}>; only same-document "#" references are allowed`;
    }
    if (attribute.value.includes("\\")) {
      return `must not contain a CSS escape in <${tag.local} ${attribute.name}>`;
    }
    if (hasExternalUrlFunction(attribute.value)) {
      return `must not reference ${JSON.stringify(attribute.value)} through <${tag.local} ${attribute.name}>; only same-document "url(#…)" references are allowed`;
    }
    if (
      name === "attributename" &&
      isForbiddenAnimatedAttribute(attribute.value)
    ) {
      return `must not animate ${JSON.stringify(attribute.value)} through <${tag.local} ${attribute.name}>`;
    }
    if (name === "base" && attribute.uri === XML_NAMESPACE) {
      return `must not contain a <${tag.local} ${attribute.name}> attribute`;
    }
  }
  return null;
}

interface SvgRules {
  structure: boolean;
  elementProblem: ((tag: SaxesTagNS) => string | null) | null;
}

const COMPACT_ICON_RULES: SvgRules = { structure: true, elementProblem: null };

const LOGO_RULES: SvgRules = {
  structure: false,
  elementProblem: scriptVectorProblem,
};

const DECLARED_ICON_RULES: SvgRules = {
  structure: true,
  elementProblem: declaredIconProblem,
};

function assertValidPluginSvg(
  bytes: Uint8Array,
  subject: string,
  rules: SvgRules,
): void {
  let source: string;
  if (rules.structure) {
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${subject} must contain valid UTF-8 SVG bytes`);
    }
  } else {
    source = new TextDecoder("utf-8").decode(bytes);
  }

  const roots: Array<{ local: string; uri: string }> = [];
  let parseError: string | null = null;
  let hasDoctype = false;
  let hasProcessingInstruction = false;
  let problem: string | null = null;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    if (roots.length === 0) roots.push({ local: tag.local, uri: tag.uri });
    if (rules.elementProblem !== null) {
      problem ??= rules.elementProblem(tag);
    }
  });
  parser.on("doctype", () => {
    hasDoctype = true;
  });
  parser.on("processinginstruction", () => {
    hasProcessingInstruction = true;
  });
  parser.on("error", (error) => {
    parseError ??= error.message;
  });
  parser.write(source).close();

  if (rules.structure) {
    if (hasDoctype) {
      throw new Error(`${subject} must not contain a doctype declaration`);
    }
    if (hasProcessingInstruction) {
      throw new Error(`${subject} must not contain processing instructions`);
    }
    if (parseError !== null) {
      throw new Error(`${subject} is not valid SVG XML: ${parseError}`);
    }
    const root = roots[0];
    if (
      root === undefined ||
      root.local !== "svg" ||
      (root.uri !== "" && root.uri !== SVG_NAMESPACE)
    ) {
      throw new Error(`${subject} must have an <svg> root element`);
    }
  }
  if (problem !== null) {
    throw new Error(`${subject} ${problem}`);
  }
}

export function assertValidPluginCompactIconSvg(
  bytes: Uint8Array,
  label = "bb.branding.icon",
): void {
  assertValidPluginSvg(bytes, `manifest ${label}`, COMPACT_ICON_RULES);
}

export function assertValidPluginLogoSvg(
  bytes: Uint8Array,
  subject: string,
): void {
  assertValidPluginSvg(bytes, subject, LOGO_RULES);
}

export function assertValidPluginIconSvg(
  bytes: Uint8Array,
  label: string,
): void {
  if (bytes.byteLength > PLUGIN_ICON_MAX_BYTES) {
    throw new Error(
      `manifest ${label} is ${bytes.byteLength} bytes; the limit is ${PLUGIN_ICON_MAX_BYTES}`,
    );
  }
  assertValidPluginSvg(bytes, `manifest ${label}`, DECLARED_ICON_RULES);
}
