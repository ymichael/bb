import {
  isAbsoluteFilePathWithinRoot,
  normalizeAbsoluteFilePath,
} from "@/lib/absolute-file-path";
import {
  createFilePreviewLineRange,
  type FilePreviewLineRange,
} from "@bb/client-core";

export interface MarkdownPreviewLocalFileLink {
  lineRange: FilePreviewLineRange | null;
  path: string;
}

export type MarkdownPreviewLocalFileLinkHandler = (
  link: MarkdownPreviewLocalFileLink,
) => boolean;

interface MarkdownTrustedAbsoluteLocalFileLinkRouting {
  kind: "trusted-host";
}

interface MarkdownContainedAbsoluteLocalFileLinkRouting {
  kind: "contained";
  rootPath: string;
}

export type MarkdownAbsoluteLocalFileLinkRouting =
  | MarkdownTrustedAbsoluteLocalFileLinkRouting
  | MarkdownContainedAbsoluteLocalFileLinkRouting;

export interface MarkdownRelativeLocalFileLinkRouting {
  baseDir: string;
  rootPath: string;
}

interface LocalFileHrefParts {
  lineRange: FilePreviewLineRange | null;
  path: string;
}

interface LocalFilePathValidationArgs {
  requireLikelyFileBasename: boolean;
  path: string;
}

interface ParseLineRangeArgs {
  endValue: string | undefined;
  startValue: string;
}

interface ResolveRelativeLocalFileHrefArgs extends MarkdownRelativeLocalFileLinkRouting {
  href: string | undefined;
}

interface ParseLocalFileHrefArgs {
  absoluteLinks: MarkdownAbsoluteLocalFileLinkRouting;
  href: string | undefined;
}

interface IsLinkContainedInRootArgs {
  link: MarkdownPreviewLocalFileLink;
  rootPath: string;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parsePositiveInteger(value: string): number | null {
  if (!/^[0-9]+$/u.test(value)) {
    return null;
  }
  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) && parsedValue > 0
    ? parsedValue
    : null;
}

function parseLineRange({
  endValue,
  startValue,
}: ParseLineRangeArgs): FilePreviewLineRange | null {
  const startLineNumber = parsePositiveInteger(startValue);
  if (startLineNumber === null) {
    return null;
  }
  const endLineNumber =
    endValue === undefined ? startLineNumber : parsePositiveInteger(endValue);
  if (endLineNumber === null) {
    return null;
  }
  return createFilePreviewLineRange({
    endLineNumber,
    startLineNumber,
  });
}

function parseLineSuffix(value: string): LocalFileHrefParts | null {
  const hashLineMatch = value.match(
    /#L([0-9]+)(?:C[0-9]+)?(?:-L?([0-9]+)(?:C[0-9]+)?)?$/u,
  );
  if (hashLineMatch) {
    const lineRange = parseLineRange({
      endValue: hashLineMatch[2],
      startValue: hashLineMatch[1] ?? "",
    });
    if (lineRange === null) {
      return null;
    }

    return {
      lineRange,
      path: value.slice(0, hashLineMatch.index),
    };
  }

  const hashIndex = value.indexOf("#");
  if (hashIndex !== -1) {
    const fragment = value.slice(hashIndex + 1);
    if (
      fragment.length === 0 ||
      fragment.includes("/") ||
      fragment.includes("#")
    ) {
      return null;
    }

    return {
      lineRange: null,
      path: value.slice(0, hashIndex),
    };
  }

  const colonLineRangeMatch = value.match(/:([0-9]+)-([0-9]+)$/u);
  if (colonLineRangeMatch) {
    const lineRange = parseLineRange({
      endValue: colonLineRangeMatch[2],
      startValue: colonLineRangeMatch[1] ?? "",
    });
    if (lineRange === null) {
      return null;
    }

    return {
      lineRange,
      path: value.slice(0, colonLineRangeMatch.index),
    };
  }

  const colonLineColumnMatch = value.match(/:([0-9]+):[0-9]+$/u);
  if (colonLineColumnMatch) {
    const lineRange = parseLineRange({
      endValue: undefined,
      startValue: colonLineColumnMatch[1] ?? "",
    });
    if (lineRange === null) {
      return null;
    }

    return {
      lineRange,
      path: value.slice(0, colonLineColumnMatch.index),
    };
  }

  const colonLineMatch = value.match(/:([0-9]+)$/u);
  if (colonLineMatch) {
    const lineRange = parseLineRange({
      endValue: undefined,
      startValue: colonLineMatch[1] ?? "",
    });
    if (lineRange === null) {
      return null;
    }

    return {
      lineRange,
      path: value.slice(0, colonLineMatch.index),
    };
  }

  return {
    lineRange: null,
    path: value,
  };
}

function hasLikelyFileBasename(path: string): boolean {
  const segments = path.split("/");
  const basename = segments[segments.length - 1] ?? "";
  return basename.startsWith(".") || basename.includes(".");
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint < 0x20) {
      return true;
    }
  }

  return false;
}

function isValidAbsoluteLocalFilePath({
  path,
  requireLikelyFileBasename,
}: LocalFilePathValidationArgs): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    path !== "/" &&
    !path.endsWith("/") &&
    !path.includes("\n") &&
    !path.includes("\r") &&
    !path.includes("?") &&
    !path.includes("#") &&
    !hasControlCharacter(path) &&
    (!requireLikelyFileBasename || hasLikelyFileBasename(path))
  );
}

function parseAbsoluteLocalFileHref(
  href: string,
  requireLikelyFileBasename: boolean,
): MarkdownPreviewLocalFileLink | null {
  if (
    href.length === 0 ||
    href.trim() !== href ||
    !href.startsWith("/") ||
    href.startsWith("//")
  ) {
    return null;
  }

  const parsed = parseLineSuffix(safeDecodeURIComponent(href));
  if (
    !parsed ||
    !isValidAbsoluteLocalFilePath({
      path: parsed.path,
      requireLikelyFileBasename,
    })
  ) {
    return null;
  }

  return parsed;
}

const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;

const HOME_RELATIVE_PATH_PATTERN = /^~(?:[^/]*\/|$)/u;

export function resolveRelativeLocalFileHref({
  baseDir,
  href,
  rootPath,
}: ResolveRelativeLocalFileHrefArgs): string | null {
  if (!href) {
    return null;
  }

  const decodedHref = safeDecodeURIComponent(href);
  const parsedHref = parseLineSuffix(decodedHref);
  if (
    href.trim() !== href ||
    decodedHref.trim() !== decodedHref ||
    parsedHref === null ||
    parsedHref.path.length === 0 ||
    parsedHref.path.startsWith("/") ||
    HOME_RELATIVE_PATH_PATTERN.test(parsedHref.path) ||
    parsedHref.path.startsWith("#") ||
    parsedHref.path.startsWith("?") ||
    URI_SCHEME_PATTERN.test(parsedHref.path)
  ) {
    return null;
  }

  const normalizedBaseDir = normalizeAbsoluteFilePath({ path: baseDir });
  const normalizedRootPath = normalizeAbsoluteFilePath({ path: rootPath });
  if (
    normalizedBaseDir === null ||
    normalizedRootPath === null ||
    !isAbsoluteFilePathWithinRoot({
      candidatePath: normalizedBaseDir,
      rootPath: normalizedRootPath,
    })
  ) {
    return null;
  }

  const joinedPath =
    normalizedBaseDir === "/"
      ? `/${parsedHref.path}`
      : `${normalizedBaseDir}/${parsedHref.path}`;
  const normalizedHrefPath = normalizeAbsoluteFilePath({ path: joinedPath });
  if (
    normalizedHrefPath === null ||
    !isAbsoluteFilePathWithinRoot({
      candidatePath: normalizedHrefPath,
      rootPath: normalizedRootPath,
    })
  ) {
    return null;
  }

  return `${normalizedHrefPath}${decodedHref.slice(parsedHref.path.length)}`;
}

function isLinkContainedInRoot({
  link,
  rootPath,
}: IsLinkContainedInRootArgs): MarkdownPreviewLocalFileLink | null {
  const normalizedPath = normalizeAbsoluteFilePath({ path: link.path });
  if (normalizedPath === null) {
    return null;
  }

  if (
    !isAbsoluteFilePathWithinRoot({
      candidatePath: normalizedPath,
      rootPath,
    })
  ) {
    return null;
  }

  return {
    ...link,
    path: normalizedPath,
  };
}

export function parseLocalFileHref({
  absoluteLinks,
  href,
}: ParseLocalFileHrefArgs): MarkdownPreviewLocalFileLink | null {
  if (!href) {
    return null;
  }

  const requireLikelyFileBasename =
    absoluteLinks.kind === "trusted-host" && !href.startsWith("file://");
  let link: MarkdownPreviewLocalFileLink | null;
  if (href.startsWith("file://")) {
    try {
      const url = new URL(href);
      if (url.host.length > 0) {
        return null;
      }
      if (url.search.length > 0) {
        return null;
      }
      link = parseAbsoluteLocalFileHref(
        url.pathname + url.hash,
        requireLikelyFileBasename,
      );
    } catch {
      return null;
    }
  } else {
    link = parseAbsoluteLocalFileHref(href, requireLikelyFileBasename);
  }

  if (link === null || absoluteLinks.kind === "trusted-host") {
    return link;
  }

  return isLinkContainedInRoot({
    link,
    rootPath: absoluteLinks.rootPath,
  });
}

function encodeFileUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function buildLineRangeAnchorFragment(
  lineRange: FilePreviewLineRange | null,
): string {
  if (lineRange === null) {
    return "";
  }
  if (lineRange.startLineNumber === lineRange.endLineNumber) {
    return `#L${lineRange.startLineNumber}`;
  }
  return `#L${lineRange.startLineNumber}-L${lineRange.endLineNumber}`;
}

export function buildLocalFileAnchorHref(
  link: MarkdownPreviewLocalFileLink | null,
  originalHref: string | undefined,
): string | undefined {
  if (!link || !link.path.startsWith("/")) {
    return originalHref;
  }

  return `file://${encodeFileUrlPath(link.path)}${buildLineRangeAnchorFragment(
    link.lineRange,
  )}`;
}
