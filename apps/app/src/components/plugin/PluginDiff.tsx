import { useMemo } from "react";
import type { DiffProps } from "@get-bb/plugin-sdk";
import { DiffHost } from "@/components/code/DiffHost";
import { normalizeFilePatch } from "@/components/git-diff/git-diff-parsing";
import { cn } from "@bb/shared-ui/lib/utils";

export function PluginDiff({
  patch,
  path,
  view,
  overflow,
  showLineNumbers,
  experimental_fullFileContents: fullFileContents,
  className,
}: DiffProps) {
  const normalized = useMemo(
    () => normalizeFilePatch({ patch, path }),
    [patch, path],
  );
  if (normalized === null) {
    return (
      <pre
        className={cn(
          "overflow-x-auto px-3 py-2 font-mono text-xs leading-5 text-foreground/80",
          className,
        )}
      >
        {patch}
      </pre>
    );
  }
  return (
    <DiffHost
      file={normalized.file}
      patchText={normalized.patch}
      fullFileContents={fullFileContents ?? null}
      view={view}
      overflow={overflow}
      showLineNumbers={showLineNumbers}
      className={className}
    />
  );
}
