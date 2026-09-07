import { useEffect } from "react";
import type { ThreadOpenFile } from "@bb/server-contract";
import { createFilePreviewLineRange } from "@bb/client-core";
import { wsManager } from "@/lib/ws";
import type { OpenSecondaryPanelTabRequest } from "./useThreadFileTabs";

interface UseThreadOpenFileSignalParams {
  threadId: string | null | undefined;
  environmentId: string | null | undefined;
  openTab: (request: OpenSecondaryPanelTabRequest) => void;
}

function toOpenRequest(file: ThreadOpenFile): OpenSecondaryPanelTabRequest {
  const lineRange =
    file.lineNumber === null
      ? null
      : createFilePreviewLineRange({
          startLineNumber: file.lineNumber,
          endLineNumber: file.lineNumber,
        });
  if (file.source === "workspace") {
    return {
      kind: "workspace-file-preview",
      tab: {
        lineRange,
        path: file.path,
        source: { kind: "working-tree" },
        statusLabel: null,
      },
    };
  }
  return {
    kind: "thread-storage-file-preview",
    tab: { lineRange, path: file.path },
  };
}

export function useThreadOpenFileSignal({
  threadId,
  environmentId,
  openTab,
}: UseThreadOpenFileSignalParams): void {
  useEffect(() => {
    if (threadId == null || environmentId === undefined) {
      return;
    }
    const apply = () => {
      const file = wsManager.consumePendingOpenFile(threadId);
      if (file) {
        openTab(toOpenRequest(file));
      }
    };
    apply();
    return wsManager.onThreadOpen((signal) => {
      if (signal.threadId === threadId) {
        apply();
      }
    });
  }, [threadId, environmentId, openTab]);
}
