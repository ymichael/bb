import { useEffect, useRef } from "react";
import type { Thread } from "@bb/domain";
import { isThreadRead } from "@/lib/thread-read-state";
import { useMarkThreadRead } from "../hooks/mutations/thread-state-mutations";

interface UseThreadReadTrackingParams {
  markThreadRead: ReturnType<typeof useMarkThreadRead>;
  thread?: Thread;
}

export function useThreadReadTracking({
  markThreadRead,
  thread,
}: UseThreadReadTrackingParams) {
  const markedReadKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!thread) {
      return;
    }
    if (isThreadRead(thread)) {
      return;
    }

    const marker = `${thread.id}:${thread.latestAttentionAt}`;
    if (markedReadKeysRef.current.has(marker)) {
      return;
    }

    markedReadKeysRef.current.add(marker);
    markThreadRead.mutate(thread.id, {
      onError: () => {
        markedReadKeysRef.current.delete(marker);
      },
    });
  }, [markThreadRead, thread]);
}
