import type { ThreadTimelineLocalFileLink } from "./types.js";

const LOCAL_FILE_LINK_LINE_SUFFIX_PATTERN = /^(\/.+):(\d+)$/u;

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

export function parseThreadTimelineLocalFileLink(
  href: string | undefined,
): ThreadTimelineLocalFileLink | null {
  if (!href) {
    return null;
  }

  const trimmedHref = href.trim();
  if (
    trimmedHref.length === 0 ||
    trimmedHref !== href ||
    !trimmedHref.startsWith("/") ||
    trimmedHref.startsWith("//")
  ) {
    return null;
  }

  const decodedHref = decodeHref(trimmedHref);
  if (
    decodedHref === "/" ||
    decodedHref.endsWith("/") ||
    decodedHref.includes("\n") ||
    decodedHref.includes("\r") ||
    decodedHref.includes("?") ||
    decodedHref.includes("#")
  ) {
    return null;
  }

  const lineMatch = decodedHref.match(LOCAL_FILE_LINK_LINE_SUFFIX_PATTERN);
  const path = lineMatch?.[1] ?? decodedHref;
  const lineNumber = lineMatch?.[2] ? Number(lineMatch[2]) : null;

  if (path.length === 0 || path === "/" || lineNumber === 0) {
    return null;
  }

  return {
    lineNumber,
    path,
  };
}
