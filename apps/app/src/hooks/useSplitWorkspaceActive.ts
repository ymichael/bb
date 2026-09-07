import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";

export function useSplitWorkspaceActive(): boolean {
  const isCompactViewport = useIsCompactViewport();
  return !isCompactViewport;
}
