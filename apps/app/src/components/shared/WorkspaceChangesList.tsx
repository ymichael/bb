import type { ThreadWorkStatus } from "@beanbag/agent-core";
import { openPathInEditor } from "@/lib/api";
import { getPathCommandForTarget } from "@/lib/open-path-preferences";
import { cn } from "@/lib/utils";
import { formatWorkspaceFileStatus } from "@/lib/workspace-change-summary";

export function WorkspaceChangesList({
  files,
  workspaceRoot,
  maxHeightClassName = "max-h-32",
  emptyMessage = "No changed files detected.",
}: {
  files: ThreadWorkStatus["files"];
  workspaceRoot?: string;
  maxHeightClassName?: string;
  emptyMessage?: string;
}) {
  if (!files || files.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{emptyMessage}</p>
    );
  }

  return (
    <ul className={cn("space-y-0.5 overflow-auto", maxHeightClassName)}>
      {files.map((file) => (
        <li key={`${file.status}:${file.path}`} className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-xs uppercase text-muted-foreground/80">
            {formatWorkspaceFileStatus(file.status)}
          </span>
          {workspaceRoot ? (
            <button
              type="button"
              className="truncate text-left text-xs underline-offset-2 hover:underline"
              title={file.path}
              onClick={() => {
                const normalizedRoot = workspaceRoot.endsWith("/")
                  ? workspaceRoot.slice(0, -1)
                  : workspaceRoot;
                const normalizedPath = file.path.startsWith("./")
                  ? file.path.slice(2)
                  : file.path;
                const absolutePath = normalizedPath.startsWith("/")
                  ? normalizedPath
                  : `${normalizedRoot}/${normalizedPath}`;
                void openPathInEditor(absolutePath, {
                  target: "file",
                  command: getPathCommandForTarget("file"),
                });
              }}
            >
              {file.path}
            </button>
          ) : (
            <span className="truncate text-xs">{file.path}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
