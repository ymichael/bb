import {
  type CSSProperties,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileContents } from "@pierre/diffs";
import { FileDiff as DiffView } from "@pierre/diffs/react";
import { useIntersectionObserver } from "usehooks-ts";
import { Button } from "@/components/ui/button.js";
import { CopyButton } from "@/components/ui/copy-button.js";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import { FilePathLink } from "@/components/ui/file-path-link.js";
import { Icon } from "@/components/ui/icon.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { TruncateStart } from "@/components/ui/truncate-start.js";
import { cn } from "@/lib/utils";
import {
  formatGitDiffFileLabel,
  getGitDiffFileChangeKind,
  getOpenableGitDiffPath,
  normalizeGitDiffPath,
  summarizeGitDiffFile,
  type GitDiffFileChangeKind,
  type ParsedGitDiffFile,
} from "./git-diff-parsing";

export type RequestDiffFileContents = (
  path: string,
  side: "old" | "new",
) => Promise<FileContents | null>;

export const GIT_DIFF_VIEW_BASE_OPTIONS = {
  overflow: "scroll",
  disableFileHeader: false,
  // Reveal 30 unchanged lines per expand-up / expand-down click. Library
  // default is 100 — too aggressive for our compact diff cards.
  expansionLineCount: 30,
} as const;

const GIT_DIFF_CARD_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
} as CSSProperties;

const GIT_DIFF_CARD_BODY_STYLE: CSSProperties = {
  contain: "layout paint style",
  contentVisibility: "auto",
  containIntrinsicSize: "0 600px",
};

export interface GitDiffCardProps {
  fileDiff: ParsedGitDiffFile;
  diffViewOptions: Record<string, string | boolean | number>;
  onOpenFileInEditor?: (path: string) => void;
  onOpenFilePreview?: (path: string) => void;
  /**
   * When both isCollapsed and onToggleCollapsed are provided, the card renders
   * a chevron in the header and hides its body when collapsed. Omit both to
   * render a card with no collapse affordance (timeline rows do this — they
   * collapse at the row level).
   */
  isCollapsed?: boolean;
  onToggleCollapsed?: () => void;
  /**
   * When true, the header sticks to the scroll container and grows a top
   * border when stuck. Used by the secondary panel; timeline rows leave this
   * off because their scroll container is per-row, not per-panel.
   */
  stickyHeader?: boolean;
  /** When true, replaces the body with a skeleton (for queued render slots). */
  isRendering?: boolean;
  /** Forwarded to the outer card element — used for IntersectionObserver-based scheduling. */
  cardRef?: (element: HTMLDivElement | null) => void;
  /**
   * When provided, the card lazy-fetches `oldFile`/`newFile` the first time
   * it scrolls into view and forwards them to `<DiffView>`. That unlocks
   * `@pierre/diffs`'s built-in expand-context buttons in the gaps between
   * hunks. Without this prop the card renders today's hunk-only view.
   *
   * The callback should resolve to `null` for binary files (the diff
   * renderer needs a UTF-8 string) so the card can leave expand disabled
   * for that file.
   */
  onRequestFileContents?: RequestDiffFileContents;
}

// `parseDiffFromFile` in @pierre/diffs splits file contents on this exact
// regex (positive lookbehind on \n) and tags the resulting arrays onto the
// parsed file as `oldLines` / `newLines`. The hunks renderer reads those
// arrays to know what's "expandable" between hunks. We do the same tagging
// directly on our parsed fileDiff once contents load — no need to make the
// library re-parse from scratch.
const SPLIT_WITH_NEWLINES = /(?<=\n)/u;

interface EnrichedFileDiff extends ParsedGitDiffFile {
  oldLines: string[];
  newLines: string[];
}

type DiffFileContentSource =
  | { kind: "empty"; path: string }
  | { kind: "request"; path: string; side: "old" | "new" };

interface DiffFileContentPlan {
  identity: string;
  old: DiffFileContentSource;
  new: DiffFileContentSource;
}

type DiffFileEnrichmentState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; oldLines: string[]; newLines: string[] }
  | { status: "unavailable" }
  | { status: "error" };

function buildDiffFileContentPlan(
  fileDiff: ParsedGitDiffFile,
  changeKind: GitDiffFileChangeKind,
): DiffFileContentPlan {
  const currentPath = normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name;
  const previousPath = normalizeGitDiffPath(fileDiff.prevName) ?? currentPath;

  const oldSource: DiffFileContentSource =
    changeKind === "added"
      ? { kind: "empty", path: currentPath }
      : {
          kind: "request",
          path: changeKind === "renamed" ? previousPath : currentPath,
          side: "old",
        };
  const newSource: DiffFileContentSource =
    changeKind === "deleted"
      ? { kind: "empty", path: currentPath }
      : { kind: "request", path: currentPath, side: "new" };
  const hunkIdentity = fileDiff.hunks
    .map(
      (hunk) =>
        `${hunk.hunkSpecs ?? ""}:${hunk.additionStart}:${hunk.additionCount}:${hunk.deletionStart}:${hunk.deletionCount}`,
    )
    .join("|");

  return {
    identity: [
      changeKind,
      describeDiffFileContentSource(oldSource),
      describeDiffFileContentSource(newSource),
      hunkIdentity,
    ].join(":"),
    old: oldSource,
    new: newSource,
  };
}

function describeDiffFileContentSource(source: DiffFileContentSource): string {
  return source.kind === "empty"
    ? `empty:${source.path}`
    : `request:${source.side}:${source.path}`;
}

function resolveDiffFileContentSource(
  source: DiffFileContentSource,
  fetcher: RequestDiffFileContents,
): Promise<FileContents | null> {
  if (source.kind === "empty") {
    return Promise.resolve({ name: source.path, contents: "" });
  }
  return fetcher(source.path, source.side);
}

function splitFileContentsForDiffContext(file: FileContents): string[] {
  if (file.contents.length === 0) return [];
  return file.contents.split(SPLIT_WITH_NEWLINES);
}

export const GitDiffCard = memo(function GitDiffCard({
  fileDiff,
  diffViewOptions,
  onOpenFileInEditor,
  onOpenFilePreview,
  isCollapsed,
  onToggleCollapsed,
  stickyHeader = false,
  isRendering = false,
  cardRef,
  onRequestFileContents,
}: GitDiffCardProps) {
  const fileDiffStats = useMemo(
    () => summarizeGitDiffFile(fileDiff),
    [fileDiff],
  );
  const fileDiffLabel = useMemo(
    () => formatGitDiffFileLabel(fileDiff),
    [fileDiff],
  );
  const fileDiffChangeKind = useMemo(
    () => getGitDiffFileChangeKind(fileDiff),
    [fileDiff],
  );
  const isAddedFile = fileDiffChangeKind === "added";
  const isDeletedFile = fileDiffChangeKind === "deleted";
  const headerInsertions = isDeletedFile ? 0 : fileDiffStats.insertions;
  const headerDeletions = isAddedFile ? 0 : fileDiffStats.deletions;
  const hideEmptyHeaderStats = isAddedFile || isDeletedFile;
  const renameInfo = useMemo(() => {
    const name = normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name;
    const prevName = normalizeGitDiffPath(fileDiff.prevName);
    if (prevName && prevName !== name) {
      return { from: prevName, to: name };
    }
    return null;
  }, [fileDiff]);
  const openablePath = useMemo(
    () => getOpenableGitDiffPath(fileDiff),
    [fileDiff],
  );
  const canOpenFile = Boolean(openablePath);
  // Pure renames + identical content land here with zero hunks; nothing for
  // the body to show, so force-collapse and disable the chevron.
  const hasChanges = fileDiff.hunks.length > 0;
  const supportsCollapse =
    isCollapsed !== undefined && onToggleCollapsed !== undefined;
  const isBodyHidden = !hasChanges || (supportsCollapse && isCollapsed);
  const fileDiffOptions = useMemo(
    () => ({ ...diffViewOptions, disableFileHeader: true }),
    [diffViewOptions],
  );
  const { ref: stickySentinelRef, isIntersecting } = useIntersectionObserver({
    initialIsIntersecting: true,
    threshold: 1,
  });
  const isHeaderStuck = stickyHeader && !isIntersecting;

  // Lazy-enrich the parsed fileDiff with old/new file contents the first
  // time the card body crosses the viewport. The lib's hunks renderer
  // checks `ast.newLines.length > 0 && ast.oldLines.length > 0` to decide
  // whether to draw expand-context buttons in the gaps between hunks; once
  // we tag those arrays the library renders the buttons on its next pass.
  const fileContentPlan = useMemo(
    () => buildDiffFileContentPlan(fileDiff, fileDiffChangeKind),
    [fileDiff, fileDiffChangeKind],
  );
  const { ref: bodySentinelRef, isIntersecting: isBodyVisible } =
    useIntersectionObserver({
      initialIsIntersecting: false,
      rootMargin: "200px",
    });
  // The parent's `onRequestFileContents` may be a fresh function reference
  // on every render. We keep the latest in a ref so the fetch effect doesn't
  // re-run every panel re-render — a re-run would cancel the in-flight
  // promise via its cleanup before `setEnrichment` could apply.
  const fetcherRef = useRef(onRequestFileContents);
  useEffect(() => {
    fetcherRef.current = onRequestFileContents;
  });
  const [enrichment, setEnrichment] = useState<DiffFileEnrichmentState>({
    status: "idle",
  });
  const enrichmentStatusRef = useRef<DiffFileEnrichmentState["status"]>(
    "idle",
  );
  const [hasBodyEnteredViewport, setHasBodyEnteredViewport] = useState(false);
  const [hasLoadedDeletedDiff, setHasLoadedDeletedDiff] = useState(false);
  // Reset cached enrichment when the card swaps to a different file.
  useEffect(() => {
    enrichmentStatusRef.current = "idle";
    setEnrichment({ status: "idle" });
    setHasBodyEnteredViewport(false);
    setHasLoadedDeletedDiff(false);
  }, [fileContentPlan.identity]);
  useEffect(() => {
    if (!isBodyHidden && isBodyVisible) {
      setHasBodyEnteredViewport(true);
    }
  }, [isBodyHidden, isBodyVisible]);
  const shouldGateDeletedDiff = isDeletedFile && !hasLoadedDeletedDiff;
  const shouldRenderDiffView =
    hasBodyEnteredViewport && !isRendering && !shouldGateDeletedDiff;
  // Fire the fetch once the diff view is actually renderable. Effect deps
  // deliberately exclude `onRequestFileContents` (we read the latest via the
  // ref) so stable visibility doesn't re-trigger when the panel re-renders.
  useEffect(() => {
    if (!shouldRenderDiffView || enrichmentStatusRef.current !== "idle") {
      return;
    }
    const fetcher = fetcherRef.current;
    if (!fetcher) return;

    let cancelled = false;
    enrichmentStatusRef.current = "loading";
    setEnrichment({ status: "loading" });

    void Promise.all([
      resolveDiffFileContentSource(fileContentPlan.old, fetcher),
      resolveDiffFileContentSource(fileContentPlan.new, fetcher),
    ])
      .then(([oldFile, newFile]) => {
        if (cancelled) return;
        if (!oldFile || !newFile) {
          enrichmentStatusRef.current = "unavailable";
          setEnrichment({ status: "unavailable" });
          return;
        }
        enrichmentStatusRef.current = "ready";
        setEnrichment({
          status: "ready",
          oldLines: splitFileContentsForDiffContext(oldFile),
          newLines: splitFileContentsForDiffContext(newFile),
        });
      })
      .catch(() => {
        if (cancelled) return;
        enrichmentStatusRef.current = "error";
        setEnrichment({ status: "error" });
      });

    return () => {
      cancelled = true;
      if (enrichmentStatusRef.current === "loading") {
        enrichmentStatusRef.current = "idle";
      }
    };
  }, [fileContentPlan, shouldRenderDiffView]);

  const enrichedFileDiff = useMemo<EnrichedFileDiff | ParsedGitDiffFile>(() => {
    if (enrichment.status !== "ready") return fileDiff;
    return {
      ...fileDiff,
      oldLines: enrichment.oldLines,
      newLines: enrichment.newLines,
    };
  }, [fileDiff, enrichment]);

  return (
    <div
      ref={cardRef}
      className="rounded-lg border border-border/70 bg-background"
    >
      {stickyHeader ? <div ref={stickySentinelRef} className="h-0" /> : null}
      <div
        className={cn(
          // Left padding matches the in-diff expand-button's margin-left
          // (`--diffs-gap-inline` defaults to `--diffs-gap-fallback: 8px`
          // in the lib's style.js — `[data-separator='line-info']
          // [data-separator-wrapper] { margin-left: 8px }`). The header's
          // collapse chevron now sits at the same X as the expand chevrons
          // the library renders between hunks below.
          "rounded-lg bg-background py-1.5 pl-2 pr-3 text-xs font-medium text-foreground",
          stickyHeader && "sticky top-0 z-30",
          !isBodyHidden && "rounded-b-none",
          // When stuck, the card's own rounded top border scrolls out of view;
          // add a matching top border on the sticky so it still reads as the
          // top edge of the card instead of a flat-cut slab.
          isHeaderStuck && "rounded-t-none border-t border-border/70",
        )}
      >
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center">
            {supportsCollapse ? (
              <button
                type="button"
                className={cn(
                  // Width matches the in-diff expand-button's 32px slot so
                  // the header chevron occupies the same column as the
                  // expand chevrons the library renders between hunks.
                  "inline-flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors",
                  hasChanges
                    ? "hover:text-foreground"
                    : "cursor-not-allowed opacity-40",
                )}
                onClick={hasChanges ? onToggleCollapsed : undefined}
                disabled={!hasChanges}
                aria-label={
                  hasChanges
                    ? `${isCollapsed ? "Expand" : "Collapse"} ${fileDiffLabel}`
                    : `${fileDiffLabel} has no changes to expand`
                }
                aria-expanded={hasChanges ? !isCollapsed : undefined}
              >
                <Icon
                  name="ChevronRight"
                  className={cn(
                    "size-3.5 shrink-0 transition-transform duration-150",
                    hasChanges && !isCollapsed && "rotate-90",
                  )}
                />
              </button>
            ) : null}
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5",
                // Mirror the diff body's `[data-column-content] {
                // padding-inline: 1ch }` so the file name is offset from
                // the card's left edge by the same gutter the diff body
                // uses between its column boundary and the content text.
                "pl-[1ch]",
              )}
            >
              {renameInfo ? (
                <TruncateStart
                  className="min-w-0 font-mono text-xs leading-5 text-muted-foreground/80"
                  title={renameInfo.from}
                >
                  {renameInfo.from}
                </TruncateStart>
              ) : null}
              {renameInfo ? (
                <Icon
                  name="ArrowRight"
                  aria-hidden="true"
                  className="size-3 shrink-0 text-muted-foreground/60"
                />
              ) : null}
              <FilePathLink
                path={openablePath ?? fileDiff.name}
                displayName={renameInfo ? renameInfo.to : fileDiffLabel}
                onClick={
                  canOpenFile && openablePath && onOpenFilePreview
                    ? () => onOpenFilePreview(openablePath)
                    : undefined
                }
                className="font-mono font-medium text-foreground"
              />
              {openablePath ? (
                <CopyButton
                  text={openablePath}
                  label={`Copy path for ${fileDiffLabel}`}
                  className="rounded-md hover:bg-state-hover"
                />
              ) : null}
              {canOpenFile && openablePath && onOpenFileInEditor ? (
                <button
                  type="button"
                  onClick={() => onOpenFileInEditor(openablePath)}
                  aria-label={`Open ${fileDiffLabel} in editor`}
                  title="Open in editor"
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Icon name="ExternalLink" aria-hidden className="size-3" />
                </button>
              ) : null}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <DiffStatsTally
              insertions={headerInsertions}
              deletions={headerDeletions}
              hideZero={hideEmptyHeaderStats}
              className="text-xs"
            />
          </span>
        </div>
      </div>
      {!isBodyHidden ? (
        <div
          ref={bodySentinelRef}
          className="overflow-hidden rounded-b-lg bg-background"
          style={GIT_DIFF_CARD_BODY_STYLE}
        >
          {shouldGateDeletedDiff ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              <span>This file was deleted.</span>{" "}
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs underline underline-offset-4 hover:underline"
                onClick={() => {
                  setHasLoadedDeletedDiff(true);
                  setHasBodyEnteredViewport(true);
                }}
              >
                Load diff
              </Button>
            </div>
          ) : !shouldRenderDiffView ? (
            <div className="space-y-1.5 px-3 py-3">
              <Skeleton className="h-3 w-full rounded-sm" />
              <Skeleton className="h-3 w-[96%] rounded-sm" />
              <Skeleton className="h-3 w-[93%] rounded-sm" />
              <Skeleton className="h-3 w-[90%] rounded-sm" />
              <Skeleton className="h-3 w-[87%] rounded-sm" />
              <Skeleton className="h-3 w-[84%] rounded-sm" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div
                className="w-full max-w-full"
                style={GIT_DIFF_CARD_VIEW_STYLE}
              >
                <DiffView
                  fileDiff={enrichedFileDiff}
                  options={fileDiffOptions}
                />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});
