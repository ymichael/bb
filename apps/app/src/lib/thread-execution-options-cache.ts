import { resolvedThreadExecutionOptionsSchema } from "@bb/domain";
import { createLastKnownCache } from "@/lib/last-known-cache";

const threadExecutionOptionsCache = createLastKnownCache({
  prefix: "bb.thread-execution-options",
  version: "1",
  schema: resolvedThreadExecutionOptionsSchema,
});

export function threadExecutionOptionsCacheKey(threadId: string): string {
  return threadExecutionOptionsCache.key(threadId);
}

export const readCachedThreadExecutionOptions =
  threadExecutionOptionsCache.read;
export const writeCachedThreadExecutionOptions =
  threadExecutionOptionsCache.write;
