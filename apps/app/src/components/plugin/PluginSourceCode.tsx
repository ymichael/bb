import type { SourceCodeProps } from "@get-bb/plugin-sdk";
import { SourceCodeHost } from "@/components/code/SourceCodeHost";

export function PluginSourceCode({
  content,
  path,
  overflow,
  highlightedLines,
  className,
}: SourceCodeProps) {
  return (
    <SourceCodeHost
      content={content}
      path={path}
      overflow={overflow}
      highlightedLines={highlightedLines ?? null}
      className={className}
    />
  );
}
