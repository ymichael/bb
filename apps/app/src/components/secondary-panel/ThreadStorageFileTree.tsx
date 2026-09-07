import { useMemo, type CSSProperties } from "react";
import {
  FileTree as FileTreeModel,
  type FileTreeSelectionChangeListener,
} from "@pierre/trees";
import { FileTree } from "@pierre/trees/react";
import { usePreferredTheme } from "@/hooks/useTheme";

export type ThreadStorageTreeModel = FileTreeModel;

export function createThreadStorageTreeModel(
  onSelectionChange: FileTreeSelectionChangeListener,
): ThreadStorageTreeModel {
  return new FileTreeModel({
    density: "compact",
    initialExpansion: "closed",
    onSelectionChange,
    paths: [],
    search: false,
  });
}

interface FileTreeHostStyle extends CSSProperties {
  "--trees-accent-override": string;
  "--trees-bg-muted-override": string;
  "--trees-bg-override": string;
  "--trees-border-color-override": string;
  "--trees-fg-muted-override": string;
  "--trees-fg-override": string;
  "--trees-focus-ring-color-override": string;
  "--trees-font-family-override": string;
  "--trees-font-size-override": string;
  "--trees-icon-width-override": string;
  "--trees-item-margin-x-override": string;
  "--trees-padding-inline-override": string;
  "--trees-scrollbar-thumb-override": string;
  "--trees-selected-bg-override": string;
  "--trees-selected-fg-override": string;
  "--trees-selected-focused-border-color-override": string;
}

const FILE_TREE_BASE_HOST_STYLE: FileTreeHostStyle = {
  "--trees-accent-override": "var(--ring)",
  "--trees-bg-muted-override":
    "color-mix(in srgb, var(--muted) 45%, transparent)",
  "--trees-bg-override": "transparent",
  "--trees-border-color-override": "var(--border)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "var(--text-xs)",
  "--trees-icon-width-override": "14px",
  "--trees-item-margin-x-override": "0",
  "--trees-padding-inline-override": "0",
  "--trees-scrollbar-thumb-override":
    "color-mix(in srgb, var(--muted-foreground) 35%, transparent)",
  "--trees-selected-bg-override":
    "color-mix(in srgb, var(--accent) 65%, transparent)",
  "--trees-selected-fg-override": "var(--foreground)",
  "--trees-selected-focused-border-color-override": "var(--ring)",
  height: "100%",
};

export function ThreadStorageFileTree({
  model,
}: {
  model: ThreadStorageTreeModel;
}) {
  const preferredTheme = usePreferredTheme();
  const fileTreeHostStyle = useMemo<FileTreeHostStyle>(
    () => ({
      ...FILE_TREE_BASE_HOST_STYLE,
      colorScheme: preferredTheme,
    }),
    [preferredTheme],
  );
  return (
    <FileTree
      aria-label="Thread storage file tree"
      className="block h-full min-h-0"
      model={model}
      style={fileTreeHostStyle}
    />
  );
}
