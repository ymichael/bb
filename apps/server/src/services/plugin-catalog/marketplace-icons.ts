import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  listPluginMarketplaceIcons,
  type DbConnection,
  type PluginMarketplaceIconRow,
  type UpsertPluginMarketplaceIconInput,
} from "@bb/db";
import { assertValidPluginCompactIconSvg } from "@bb/plugin-build";
import {
  assertPublicMarketplaceUrl,
  boundedResponseBytes,
  marketplaceErrorMessage,
  MARKETPLACE_FETCH_TIMEOUT_MS,
  type MarketplaceFetch,
} from "./marketplace-http.js";
import { realPathInside } from "../plugins/install-sources.js";
import {
  resolveEntryIcon,
  type MarketplaceEntry,
  type MarketplaceIconBase,
  type MarketplaceIconLocation,
} from "./marketplace-manifest.js";

const MARKETPLACE_ICON_MAX_BYTES = 256 * 1024;

export async function readBoundedMarketplaceIconFile(
  path: string,
): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("icon is not a regular file");
    const buffer = Buffer.allocUnsafe(MARKETPLACE_ICON_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MARKETPLACE_ICON_MAX_BYTES) {
      throw new Error(`icon exceeds ${MARKETPLACE_ICON_MAX_BYTES} bytes`);
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

const MARKETPLACE_ICON_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

const MARKETPLACE_ICON_CONCURRENCY = 6;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWithBytes(bytes: Uint8Array, magic: number[]): boolean {
  return (
    bytes.length >= magic.length &&
    magic.every((byte, index) => bytes[index] === byte)
  );
}

function isWebp(bytes: Uint8Array): boolean {
  const ascii = (offset: number, text: string): boolean =>
    bytes.length >= offset + text.length &&
    text
      .split("")
      .every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  return ascii(0, "RIFF") && ascii(8, "WEBP");
}

export function marketplaceIconContentType(
  iconUrl: string,
  bytes: Uint8Array,
): string {
  return marketplaceIconContentTypeForPath(new URL(iconUrl).pathname, bytes);
}

function marketplaceIconContentTypeForPath(
  filePath: string,
  bytes: Uint8Array,
): string {
  const pathname = filePath.toLowerCase();
  if (bytes.byteLength > MARKETPLACE_ICON_MAX_BYTES) {
    throw new Error(`icon exceeds ${MARKETPLACE_ICON_MAX_BYTES} bytes`);
  }
  if (pathname.endsWith(".svg")) {
    assertValidPluginCompactIconSvg(bytes, "icon");
    return "image/svg+xml";
  }
  if (pathname.endsWith(".png")) {
    if (!startsWithBytes(bytes, PNG_MAGIC)) {
      throw new Error("icon is not a PNG file");
    }
    return "image/png";
  }
  if (pathname.endsWith(".webp")) {
    if (!isWebp(bytes)) throw new Error("icon is not a WebP file");
    return "image/webp";
  }
  throw new Error("icon must be a .svg, .png, or .webp file");
}

export async function fetchMarketplaceIcons(args: {
  db: DbConnection;
  marketplaceName: string;
  base: MarketplaceIconBase;
  entries: readonly MarketplaceEntry[];
  onlyMissing: boolean;
  fetch: MarketplaceFetch;
  warn?: (message: string) => void;
}): Promise<UpsertPluginMarketplaceIconInput[]> {
  const wanted = new Map<string, MarketplaceIconLocation>();
  for (const entry of args.entries) {
    let icon: MarketplaceIconLocation | null;
    try {
      icon = resolveEntryIcon(entry, args.base);
    } catch (error) {
      args.warn?.(
        `marketplace ${args.marketplaceName} entry "${entry.id}": ${marketplaceErrorMessage(error)}`,
      );
      continue;
    }
    if (icon !== null) wanted.set(entry.id, icon);
  }

  const cachedByEntryId = new Map(
    listPluginMarketplaceIcons(args.db, args.marketplaceName).map((icon) => [
      icon.entryId,
      icon,
    ]),
  );
  const resolved = new Map<string, UpsertPluginMarketplaceIconInput>();
  const pending = [...wanted.entries()];
  let totalBytes = 0;
  let budgetError: Error | null = null;

  const keep = (
    entryId: string,
    icon: UpsertPluginMarketplaceIconInput,
  ): void => {
    totalBytes += icon.bytes.byteLength;
    if (totalBytes > MARKETPLACE_ICON_TOTAL_MAX_BYTES) {
      budgetError ??= new Error(
        `marketplace icons exceed the ${MARKETPLACE_ICON_TOTAL_MAX_BYTES} byte total limit`,
      );
      return;
    }
    resolved.set(entryId, icon);
  };

  const runOne = async (
    entryId: string,
    icon: MarketplaceIconLocation,
  ): Promise<void> => {
    const sourceUrl = iconSourceUrl(icon);
    const cached = cachedByEntryId.get(entryId);
    const unchangedUrl = cached?.sourceUrl === sourceUrl;
    if (
      args.onlyMissing &&
      icon.kind === "remote" &&
      cached !== undefined &&
      unchangedUrl
    ) {
      keep(entryId, iconInputFromRow(cached));
      return;
    }
    try {
      const refreshed =
        icon.kind === "local"
          ? await readOneLocalIcon({
              marketplaceName: args.marketplaceName,
              entryId,
              icon,
              base: args.base,
            })
          : await fetchOneIcon({
              marketplaceName: args.marketplaceName,
              entryId,
              iconUrl: icon.url,
              cached,
              fetch: args.fetch,
            });
      if (refreshed !== null) {
        keep(entryId, refreshed);
      } else if (cached !== undefined && unchangedUrl) {
        keep(entryId, iconInputFromRow(cached));
      }
    } catch (error) {
      args.warn?.(
        `marketplace ${args.marketplaceName} entry "${entryId}" icon ${sourceUrl} was rejected: ${marketplaceErrorMessage(error)}`,
      );
      if (cached !== undefined && unchangedUrl) {
        keep(entryId, iconInputFromRow(cached));
      }
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (budgetError !== null) return;
      const next = pending.shift();
      if (next === undefined) return;
      await runOne(next[0], next[1]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MARKETPLACE_ICON_CONCURRENCY, pending.length) },
      worker,
    ),
  );
  if (budgetError !== null) throw budgetError;

  return [...wanted.keys()]
    .map((entryId) => resolved.get(entryId))
    .filter(
      (icon): icon is UpsertPluginMarketplaceIconInput => icon !== undefined,
    );
}

function iconSourceUrl(icon: MarketplaceIconLocation): string {
  return icon.kind === "remote" ? icon.url : `file:${icon.relativePath}`;
}

async function readOneLocalIcon(args: {
  marketplaceName: string;
  entryId: string;
  icon: Extract<MarketplaceIconLocation, { kind: "local" }>;
  base: MarketplaceIconBase;
}): Promise<UpsertPluginMarketplaceIconInput> {
  if (args.base.kind !== "dir") {
    throw new Error("local icons require a directory base");
  }
  const path = await realPathInside(
    args.base.root,
    args.icon.path,
    `entry "${args.entryId}" icon`,
  );
  const bytes = await readBoundedMarketplaceIconFile(path);
  return {
    marketplaceName: args.marketplaceName,
    entryId: args.entryId,
    sourceUrl: iconSourceUrl(args.icon),
    contentType: marketplaceIconContentTypeForPath(
      args.icon.relativePath,
      bytes,
    ),
    etag: null,
    contentHash: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
    bytes: Buffer.from(bytes),
  };
}

function iconInputFromRow(
  row: PluginMarketplaceIconRow,
): UpsertPluginMarketplaceIconInput {
  const { updatedAt: _updatedAt, ...input } = row;
  return input;
}

async function fetchOneIcon(args: {
  marketplaceName: string;
  entryId: string;
  iconUrl: string;
  cached: PluginMarketplaceIconRow | undefined;
  fetch: MarketplaceFetch;
}): Promise<UpsertPluginMarketplaceIconInput | null> {
  assertPublicMarketplaceUrl(args.iconUrl);
  const cached = args.cached;
  const unchangedUrl =
    cached !== undefined && cached.sourceUrl === args.iconUrl;
  const headers = new Headers({ accept: "image/*" });
  if (unchangedUrl && cached.etag !== null) {
    headers.set("if-none-match", cached.etag);
  }
  const response = await args.fetch(args.iconUrl, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
  });
  if (response.status === 304 && unchangedUrl) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`request failed with HTTP ${response.status}`);
  }
  const bytes = await boundedResponseBytes(
    response,
    MARKETPLACE_ICON_MAX_BYTES,
    "icon",
  );
  const contentType = marketplaceIconContentType(args.iconUrl, bytes);
  return {
    marketplaceName: args.marketplaceName,
    entryId: args.entryId,
    sourceUrl: args.iconUrl,
    contentType,
    etag: response.headers.get("etag"),
    contentHash: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
    bytes: Buffer.from(bytes),
  };
}
