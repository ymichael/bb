import { useState, type ReactNode } from "react";
import type { WorkspaceFile } from "@bb/server-contract";
import { DetailCard } from "@/components/ui";
import { ManagerWorkspaceRow } from "./ThreadMetadataContent";
import { useManagerStorageBrowser } from "./useManagerStorageBrowser";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "secondary-panel/Workspace",
};

// Mirrors the DetailCard styling used by ThreadMetadataCard so a row in
// isolation reads the same way as it does inside the full info-tab panel.
function PanelStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[360px] w-full max-w-[460px] min-w-0 flex-col overflow-hidden rounded-md border border-border/70 bg-background px-4 py-3">
      <DetailCard
        className="h-full min-h-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0"
      >
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
  makeFile("ASYNC.md"),
  makeFile("STATUS.md"),
  makeFile("PREFERENCES.md"),
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
  const controller = useManagerStorageBrowser({
    files,
    onSelectPath: setSelectedPath,
    selectedPath,
  });
  return (
    <ManagerWorkspaceRow
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
        hint="Flat list of workspace files; click a row to select it"
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
