import { useState, type ReactNode } from "react";
import type { WorkspaceFile } from "@bb/server-contract";
import { DetailCard } from "@/components/ui/detail-card.js";
import { ThreadStorageRow } from "./ThreadMetadataContent";
import { useThreadStorageBrowser } from "./useThreadStorageBrowser";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "right-panel/Thread storage",
};

function PanelStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[360px] w-full max-w-[460px] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background px-4 py-3">
      <DetailCard className="h-full min-h-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0">
        {children}
      </DetailCard>
    </div>
  );
}

function makeFile(path: string): WorkspaceFile {
  const segments = path.split("/");
  return { path, name: segments[segments.length - 1] ?? path };
}

const FILES: WorkspaceFile[] = [
  makeFile("notes/current-work.md"),
  makeFile("plans/kickoff.md"),
  makeFile("reports/status.md"),
];

function InteractiveRow({
  files,
  filesError,
  isFilesLoading,
}: {
  files?: readonly WorkspaceFile[];
  filesError?: Error | null;
  isFilesLoading: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const controller = useThreadStorageBrowser({
    files,
    onSelectPath: setSelectedPath,
    selectedPath,
  });
  return (
    <ThreadStorageRow
      controller={controller}
      filesError={filesError ?? null}
      isFilesLoading={isFilesLoading}
    />
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="default"
        hint="Flat list of thread-storage files; click a row to select it"
      >
        <PanelStage>
          <InteractiveRow files={FILES} isFilesLoading={false} />
        </PanelStage>
      </StoryRow>
      <StoryRow label="loading" hint="Initial fetch with no prior data">
        <PanelStage>
          <InteractiveRow isFilesLoading={true} />
        </PanelStage>
      </StoryRow>
      <StoryRow label="error" hint="File-list request failed">
        <PanelStage>
          <InteractiveRow
            isFilesLoading={false}
            filesError={new Error("Failed to load file list.")}
          />
        </PanelStage>
      </StoryRow>
      <StoryRow label="empty" hint="Thread has no storage files yet">
        <PanelStage>
          <InteractiveRow files={[]} isFilesLoading={false} />
        </PanelStage>
      </StoryRow>
    </StoryCard>
  );
}
