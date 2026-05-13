export interface MarkdownPreviewLocalFileLink {
  lineNumber: number | null;
  /**
   * Absolute local path. Callers own workspace containment checks so
   * MarkdownPreview can stay reusable.
   */
  path: string;
}

/**
 * Return `true` when the link was handled and anchor navigation should be
 * prevented. Return `false` to leave the link as a normal anchor.
 */
export type MarkdownPreviewLocalFileLinkHandler = (
  link: MarkdownPreviewLocalFileLink,
) => boolean;

interface LocalFileHrefParts {
  lineNumber: number | null;
  path: string;
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

function parseLineSuffix(value: string): LocalFileHrefParts | null {
  const hashLineMatch = value.match(/#L([0-9]+)$/u);
  if (hashLineMatch) {
    const lineNumber = parsePositiveInteger(hashLineMatch[1] ?? "");
    if (lineNumber === null) {
      return null;
    }

    return {
      lineNumber,
      path: value.slice(0, hashLineMatch.index),
    };
  }

  if (value.includes("#")) {
    return null;
  }

  const colonLineMatch = value.match(/:([0-9]+)$/u);
  if (colonLineMatch) {
    const lineNumber = parsePositiveInteger(colonLineMatch[1] ?? "");
    if (lineNumber === null) {
      return null;
    }

    return {
      lineNumber,
      path: value.slice(0, colonLineMatch.index),
    };
  }

  return {
    lineNumber: null,
    path: value,
  };
}

function hasLikelyFileBasename(path: string): boolean {
  const segments = path.split("/");
  const basename = segments[segments.length - 1] ?? "";
  return basename.startsWith(".") || basename.includes(".");
}

function isValidAbsoluteLocalFilePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    path !== "/" &&
    !path.endsWith("/") &&
    !path.includes("\n") &&
    !path.includes("\r") &&
    !path.includes("?") &&
    !path.includes("#")
  );
}

function parseAbsoluteLocalFileHref(
  href: string,
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
  if (!parsed || !isValidAbsoluteLocalFilePath(parsed.path)) {
    return null;
  }

  return parsed;
}

export function parseLocalFileHref(
  href: string | undefined,
): MarkdownPreviewLocalFileLink | null {
  if (!href) {
    return null;
  }

  if (href.startsWith("file://")) {
    try {
      const url = new URL(href);
      if (url.search.length > 0) {
        return null;
      }
      return parseAbsoluteLocalFileHref(url.pathname + url.hash);
    } catch {
      return null;
    }
  }

  return parseAbsoluteLocalFileHref(href);
}

function encodeFileUrlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function shouldRenderFileHref(link: MarkdownPreviewLocalFileLink): boolean {
  return (
    link.path.startsWith("/") &&
    (link.lineNumber !== null || hasLikelyFileBasename(link.path))
  );
}

export function buildLocalFileAnchorHref(
  link: MarkdownPreviewLocalFileLink | null,
  originalHref: string | undefined,
): string | undefined {
  if (!link || !shouldRenderFileHref(link)) {
    return originalHref;
  }

  return `file://${encodeFileUrlPath(link.path)}${
    link.lineNumber === null ? "" : `#L${link.lineNumber}`
  }`;
}
