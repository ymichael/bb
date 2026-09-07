import type { ThreadTimelineResponse } from "@bb/server-contract";
import type { ThreadStatus } from "@bb/domain";
import type { ThreadTimelinePageRequest } from "./timeline-pagination.js";

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_CACHEABLE_ROWS = 200;

interface ThreadTimelineCacheOptions {
  maxEntries?: number;
  maxCacheableRows?: number;
}

interface ThreadTimelineCache {
  getOrBuild(
    key: string,
    build: () => ThreadTimelineResponse,
  ): ThreadTimelineResponse;
  readonly size: number;
}

export function createThreadTimelineCache(
  options: ThreadTimelineCacheOptions = {},
): ThreadTimelineCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxCacheableRows =
    options.maxCacheableRows ?? DEFAULT_MAX_CACHEABLE_ROWS;
  const entries = new Map<string, ThreadTimelineResponse>();

  return {
    getOrBuild(key, build) {
      const cached = entries.get(key);
      if (cached !== undefined) {
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }

      const value = build();
      if (value.rows.length <= maxCacheableRows) {
        entries.set(key, value);
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          entries.delete(oldest);
        }
      }
      return value;
    },
    get size() {
      return entries.size;
    },
  };
}

export interface ThreadTimelineCacheKeyArgs {
  threadId: string;
  maxSeq: number;
  status: ThreadStatus;
  environmentId: string | null;
  providerDisplayName?: string;
  page: ThreadTimelinePageRequest;
  includeNestedRows: boolean;
  summaryOnly: boolean;
  includeProviderUnhandledOperations: boolean;
}

function pageKeyPart(page: ThreadTimelinePageRequest): string {
  return page.kind === "older"
    ? `older:${page.segmentLimit}:${page.beforeCursor.anchorSeq}:${page.beforeCursor.anchorId}`
    : `latest:${page.segmentLimit}`;
}

export function buildThreadTimelineParamsKey(
  args: Omit<ThreadTimelineCacheKeyArgs, "maxSeq">,
): string {
  return [
    args.threadId,
    args.status,
    args.environmentId ?? "-",
    args.providerDisplayName ?? "-",
    pageKeyPart(args.page),
    args.includeNestedRows ? "1" : "0",
    args.summaryOnly ? "1" : "0",
    args.includeProviderUnhandledOperations ? "1" : "0",
  ].join("|");
}

export function buildThreadTimelineCacheKey(
  args: ThreadTimelineCacheKeyArgs,
): string {
  return `${args.maxSeq}|${buildThreadTimelineParamsKey(args)}`;
}
