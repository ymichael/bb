import { useEffect, useRef } from "react";
import type { Thread } from "@bb/domain";
import { useMarkThreadRead } from "../hooks/mutations/thread-mutations";

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
    if ((thread.lastReadAt ?? 0) >= thread.updatedAt) {
      return;
    }

    const marker = `${thread.id}:${thread.updatedAt}`;
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
