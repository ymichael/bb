import { z } from "zod";
import {
  boundedResponseBytes,
  MARKETPLACE_FETCH_TIMEOUT_MS,
  type MarketplaceFetch,
} from "./marketplace-http.js";

const MARKETPLACE_STATS_FILENAME = "stats.json";

const MARKETPLACE_STATS_MAX_BYTES = 512 * 1024;

const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

const marketplaceStatsSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  plugins: z.record(
    z.string(),
    z.object({ installs: z.number().int().nonnegative() }),
  ),
});

export type MarketplaceStats = z.infer<typeof marketplaceStatsSchema>;

export function parseMarketplaceStatsJson(
  raw: string,
  location: string,
): MarketplaceStats {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid ${location}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = marketplaceStatsSchema.safeParse(document);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(
      `invalid ${location}: ${issue === undefined ? "unexpected shape" : `${issue.path.join(".") || "/"} ${issue.message}`}`,
    );
  }
  return {
    ...parsed.data,
    plugins: Object.fromEntries(
      Object.entries(parsed.data.plugins).filter(([id]) =>
        ENTRY_ID_PATTERN.test(id),
      ),
    ),
  };
}

export function installCountsFromStatsJson(
  statsJson: string | null,
  onInvalid?: (message: string) => void,
): ReadonlyMap<string, number> {
  if (statsJson === null) return new Map();
  try {
    const stats = parseMarketplaceStatsJson(statsJson, "stored install counts");
    return new Map(
      Object.entries(stats.plugins).map(([id, entry]) => [id, entry.installs]),
    );
  } catch (error) {
    onInvalid?.(error instanceof Error ? error.message : String(error));
    return new Map();
  }
}

export function marketplaceStatsUrl(manifestUrl: string): string {
  return new URL(MARKETPLACE_STATS_FILENAME, manifestUrl).toString();
}

export async function fetchMarketplaceStats(args: {
  manifestUrl: string;
  fetch: MarketplaceFetch;
}): Promise<MarketplaceStats | null> {
  const url = marketplaceStatsUrl(args.manifestUrl);
  const response = await args.fetch(url, {
    method: "GET",
    headers: new Headers({ accept: "application/json" }),
    redirect: "error",
    signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`request failed with HTTP ${response.status}`);
  }
  const raw = new TextDecoder().decode(
    await boundedResponseBytes(
      response,
      MARKETPLACE_STATS_MAX_BYTES,
      "marketplace install counts",
    ),
  );
  return parseMarketplaceStatsJson(raw, "marketplace install counts");
}
