import { DiffLoadingSkeleton } from "@/components/code/code-loading-skeletons";
import {
  type CSSProperties,
  type RefCallback,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileContents } from "@pierre/diffs";
import type { GitDiffFileChangeKind } from "@bb/server-contract";
import type { ExperimentalDiffFullFileContents } from "@get-bb/plugin-sdk";
import { useIntersectionObserver } from "usehooks-ts";
import { Button } from "@bb/shared-ui/button";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { DiffHost } from "@/components/code/DiffHost";
import type { DiffPresentation } from "@/components/code/code-rendering";
import {
  getWrappedImageIndex,
  ImageLightbox,
  IMAGE_TRANSPARENCY_CHECKER_STYLE,
} from "@/components/ui/image-lightbox.js";
import {
  formatGitDiffFileLabel,
  isPreviewableImagePath,
  isSvgGitDiffFile,
  normalizeGitDiffPath,
  type ParsedGitDiffFile,
} from "./git-diff-parsing";

export type DiffFileContentsResult =
  | { kind: "text"; file: FileContents }
  | { kind: "image"; dataUrl: string; sizeBytes: number };

export type RequestDiffFileContents = (
  path: string,
  side: "old" | "new",
) => Promise<DiffFileContentsResult | null>;

export interface DiffImageSizeStat {
  addedBytes: number | null;
  removedBytes: number | null;
}

export type GitDiffCardSvgDisplayMode = "preview" | "raw";

const GIT_DIFF_CARD_BODY_STYLE: CSSProperties = {
  contain: "layout paint style",
  contentVisibility: "auto",
  containIntrinsicSize: "0 600px",
};

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
  | {
      status: "ready";
      fullFileContents: ExperimentalDiffFullFileContents;
    }
  | {
      status: "ready-image";
      oldImageUrl: string | null;
      newImageUrl: string | null;
      oldSizeBytes: number | null;
      newSizeBytes: number | null;
    }
  | {
      status: "ready-svg";
      fullFileContents: ExperimentalDiffFullFileContents;
      oldImageUrl: string | null;
      newImageUrl: string | null;
    }
  | { status: "unavailable" }
  | { status: "error" };

type DiffContextExpansionStatus =
  | "unavailable"
  | "idle"
  | "loading"
  | "ready"
  | "error";

interface DiffContextExpansionState {
  status: DiffContextExpansionStatus;
  request: () => void;
}

function canExpandContextForChangeKind(
  changeKind: GitDiffFileChangeKind,
): boolean {
  return (
    changeKind === "modified" ||
    changeKind === "renamed" ||
    changeKind === "copied"
  );
}

function scheduleIdleWork(work: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(work, { timeout: 2_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(work, 200);
  return () => window.clearTimeout(handle);
}

function buildDiffFileContentPlan(
  fileDiff: ParsedGitDiffFile,
  changeKind: GitDiffFileChangeKind,
  patchText: string | undefined,
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
      patchText ?? "",
      fileDiff.deletionLines.join(""),
      fileDiff.additionLines.join(""),
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
): Promise<DiffFileContentsResult | null> {
  if (source.kind === "empty") {
    return Promise.resolve({
      kind: "text",
      file: { name: source.path, contents: "" },
    });
  }
  return fetcher(source.path, source.side);
}

function toDiffFullFileContents(
  oldFile: FileContents,
  newFile: FileContents,
): ExperimentalDiffFullFileContents {
  return {
    old: { path: oldFile.name, content: oldFile.contents },
    new: { path: newFile.name, content: newFile.contents },
  };
}

function isImagePreviewCard(
  fileDiff: ParsedGitDiffFile,
  onRequestFileContents: RequestDiffFileContents | undefined,
): boolean {
  return (
    fileDiff.hunks.length === 0 &&
    fileDiff.type !== "rename-pure" &&
    onRequestFileContents !== undefined &&
    isPreviewableImagePath(fileDiff.name)
  );
}

function isSvgPreviewCard(
  fileDiff: ParsedGitDiffFile,
  onRequestFileContents: RequestDiffFileContents | undefined,
): boolean {
  return (
    fileDiff.type !== "rename-pure" &&
    onRequestFileContents !== undefined &&
    isSvgGitDiffFile(fileDiff)
  );
}

function svgTextToDataUrl(contents: string): string | null {
  const trimmedContents = contents.trim();
  if (trimmedContents.length === 0) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmedContents)}`;
}

interface UseGitDiffCardBodyArgs {
  fileDiff: ParsedGitDiffFile;
  changeKind: GitDiffFileChangeKind;
  isRendering: boolean;
  onRequestFileContents: RequestDiffFileContents | undefined;
  patchText?: string;
}

interface GitDiffCardBodyState {
  bodySentinelRef: RefCallback<HTMLDivElement>;
  enrichment: DiffFileEnrichmentState;
  fileDiff: ParsedGitDiffFile;
  fileDiffLabel: string;
  isImageCard: boolean;
  isSvgPreviewCard: boolean;
  shouldGateDeletedDiff: boolean;
  shouldRenderDiffView: boolean;
  loadDeletedDiff: () => void;
  imageSizeStat: DiffImageSizeStat | null;
  contextExpansion: DiffContextExpansionState;
  fullFileContents: ExperimentalDiffFullFileContents | null;
  patchText: string | undefined;
}

export function useGitDiffCardBody({
  fileDiff,
  changeKind,
  isRendering,
  onRequestFileContents,
  patchText,
}: UseGitDiffCardBodyArgs): GitDiffCardBodyState {
  const isDeletedFile = changeKind === "deleted";
  const isImageCard = isImagePreviewCard(fileDiff, onRequestFileContents);
  const isSvgCard = isSvgPreviewCard(fileDiff, onRequestFileContents);
  const fileDiffLabel = useMemo(
    () => formatGitDiffFileLabel(fileDiff),
    [fileDiff],
  );
  const fileContentPlan = useMemo(
    () => buildDiffFileContentPlan(fileDiff, changeKind, patchText),
    [fileDiff, changeKind, patchText],
  );
  const { ref: bodySentinelRef, isIntersecting: isBodyVisible } =
    useIntersectionObserver({
      initialIsIntersecting: false,
      rootMargin: "200px",
    });
  const fetcherRef = useRef(onRequestFileContents);
  useEffect(() => {
    fetcherRef.current = onRequestFileContents;
  });
  const [enrichment, setEnrichment] = useState<DiffFileEnrichmentState>({
    status: "idle",
  });
  const enrichmentStatusRef = useRef<DiffFileEnrichmentState["status"]>("idle");
  const [hasBodyEnteredViewport, setHasBodyEnteredViewport] = useState(false);
  const [hasLoadedDeletedDiff, setHasLoadedDeletedDiff] = useState(false);
  const [contextRequestVersion, setContextRequestVersion] = useState(0);
  const isPointerCoarse = usePointerCoarse();
  useEffect(() => {
    enrichmentStatusRef.current = "idle";
    setEnrichment({ status: "idle" });
    setHasLoadedDeletedDiff(false);
    setContextRequestVersion(0);
  }, [fileContentPlan.identity, isImageCard, isSvgCard]);
  useEffect(() => {
    if (isBodyVisible) {
      setHasBodyEnteredViewport(true);
    }
  }, [isBodyVisible]);
  const shouldGateDeletedDiff =
    isDeletedFile && !isImageCard && !isSvgCard && !hasLoadedDeletedDiff;
  const shouldRenderDiffView =
    hasBodyEnteredViewport && !isRendering && !shouldGateDeletedDiff;
  const needsContentsToRender = isImageCard || isSvgCard;
  const canExpandContext =
    !needsContentsToRender &&
    onRequestFileContents !== undefined &&
    patchText !== undefined &&
    fileDiff.hunks.length > 0 &&
    canExpandContextForChangeKind(changeKind);
  const shouldFetchContents =
    shouldRenderDiffView &&
    (needsContentsToRender || (canExpandContext && contextRequestVersion > 0));
  useEffect(() => {
    if (
      isPointerCoarse ||
      !shouldRenderDiffView ||
      !canExpandContext ||
      contextRequestVersion > 0
    ) {
      return;
    }
    return scheduleIdleWork(() => {
      setContextRequestVersion((version) => (version === 0 ? 1 : version));
    });
  }, [
    canExpandContext,
    contextRequestVersion,
    isPointerCoarse,
    shouldRenderDiffView,
  ]);
  useEffect(() => {
    if (!shouldFetchContents || enrichmentStatusRef.current !== "idle") {
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
      .then(([oldResult, newResult]) => {
        if (cancelled) return;
        const oldImage = oldResult?.kind === "image" ? oldResult : null;
        const newImage = newResult?.kind === "image" ? newResult : null;
        if (oldImage !== null || newImage !== null) {
          enrichmentStatusRef.current = "ready-image";
          setEnrichment({
            status: "ready-image",
            oldImageUrl: oldImage?.dataUrl ?? null,
            newImageUrl: newImage?.dataUrl ?? null,
            oldSizeBytes: oldImage?.sizeBytes ?? null,
            newSizeBytes: newImage?.sizeBytes ?? null,
          });
          return;
        }
        if (oldResult?.kind !== "text" || newResult?.kind !== "text") {
          enrichmentStatusRef.current = "unavailable";
          setEnrichment({ status: "unavailable" });
          return;
        }
        const fullFileContents = toDiffFullFileContents(
          oldResult.file,
          newResult.file,
        );
        if (isSvgCard) {
          enrichmentStatusRef.current = "ready-svg";
          setEnrichment({
            status: "ready-svg",
            fullFileContents,
            oldImageUrl: svgTextToDataUrl(oldResult.file.contents),
            newImageUrl: svgTextToDataUrl(newResult.file.contents),
          });
          return;
        }
        enrichmentStatusRef.current = "ready";
        setEnrichment({
          status: "ready",
          fullFileContents,
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
  }, [
    contextRequestVersion,
    fileContentPlan,
    fileDiff,
    isSvgCard,
    patchText,
    shouldFetchContents,
  ]);

  const requestContextExpansion = useCallback(() => {
    if (enrichmentStatusRef.current === "error") {
      enrichmentStatusRef.current = "idle";
      setEnrichment({ status: "idle" });
    }
    setContextRequestVersion((version) => version + 1);
  }, []);
  const contextExpansionStatus = getDiffContextExpansionStatus({
    canExpandContext,
    contextRequested: contextRequestVersion > 0,
    enrichmentStatus: enrichment.status,
  });
  const contextExpansion = useMemo<DiffContextExpansionState>(
    () => ({
      status: contextExpansionStatus,
      request: requestContextExpansion,
    }),
    [contextExpansionStatus, requestContextExpansion],
  );

  const fullFileContents =
    enrichment.status === "ready" || enrichment.status === "ready-svg"
      ? enrichment.fullFileContents
      : null;

  const loadDeletedDiff = useCallback(() => {
    setHasLoadedDeletedDiff(true);
    setHasBodyEnteredViewport(true);
  }, []);

  const imageSizeStat =
    isImageCard && enrichment.status === "ready-image"
      ? getGitDiffCardImageSizeStat(enrichment, changeKind)
      : null;

  return {
    bodySentinelRef,
    enrichment,
    fileDiff,
    fileDiffLabel,
    isImageCard,
    isSvgPreviewCard: isSvgCard,
    shouldGateDeletedDiff,
    shouldRenderDiffView,
    loadDeletedDiff,
    imageSizeStat,
    contextExpansion,
    fullFileContents,
    patchText,
  };
}

function getDiffContextExpansionStatus({
  canExpandContext,
  contextRequested,
  enrichmentStatus,
}: {
  canExpandContext: boolean;
  contextRequested: boolean;
  enrichmentStatus: DiffFileEnrichmentState["status"];
}): DiffContextExpansionStatus {
  if (!canExpandContext) return "unavailable";
  switch (enrichmentStatus) {
    case "idle":
      return contextRequested ? "loading" : "idle";
    case "loading":
      return "loading";
    case "ready":
      return "ready";
    case "error":
      return "error";
    case "ready-image":
    case "ready-svg":
    case "unavailable":
      return "unavailable";
    default: {
      const _exhaustive: never = enrichmentStatus;
      return _exhaustive;
    }
  }
}

interface GitDiffCardImageSide {
  url: string;
  caption: string | null;
}

function buildGitDiffCardImageSides(
  oldImageUrl: string | null,
  newImageUrl: string | null,
): GitDiffCardImageSide[] {
  const showSideLabels = oldImageUrl !== null && newImageUrl !== null;
  const sides: GitDiffCardImageSide[] = [];
  if (oldImageUrl !== null) {
    sides.push({ url: oldImageUrl, caption: showSideLabels ? "Old" : null });
  }
  if (newImageUrl !== null) {
    sides.push({ url: newImageUrl, caption: showSideLabels ? "New" : null });
  }
  return sides;
}

function getGitDiffCardImageAlt(
  fileDiffLabel: string,
  side: GitDiffCardImageSide,
): string {
  return side.caption === null
    ? fileDiffLabel
    : `${fileDiffLabel} (${side.caption.toLowerCase()})`;
}

interface GitDiffCardImageBodyProps {
  enrichment: DiffFileEnrichmentState;
  fileDiffLabel: string;
  fitToFrame?: boolean;
}

export interface GitDiffCardImagePreview {
  oldImageUrl: string | null;
  newImageUrl: string | null;
}

function getGitDiffCardImageUrls(
  enrichment: DiffFileEnrichmentState,
): GitDiffCardImagePreview | null {
  if (
    enrichment.status !== "ready-image" &&
    enrichment.status !== "ready-svg"
  ) {
    return null;
  }
  return {
    oldImageUrl: enrichment.oldImageUrl,
    newImageUrl: enrichment.newImageUrl,
  };
}

export function getGitDiffCardImageSizeStat(
  preview: {
    oldSizeBytes: number | null;
    newSizeBytes: number | null;
  },
  changeKind: GitDiffFileChangeKind,
): DiffImageSizeStat | null {
  const addedBytes = changeKind === "deleted" ? null : preview.newSizeBytes;
  const removedBytes = changeKind === "added" ? null : preview.oldSizeBytes;
  if (addedBytes === null && removedBytes === null) return null;
  return { addedBytes, removedBytes };
}

interface GitDiffCardImagePreviewBodyProps {
  preview: GitDiffCardImagePreview;
  fileDiffLabel: string;
  fitToFrame?: boolean;
}

export function GitDiffCardImagePreviewBody({
  preview,
  fileDiffLabel,
  fitToFrame = false,
}: GitDiffCardImagePreviewBodyProps) {
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const imageSides = buildGitDiffCardImageSides(
    preview.oldImageUrl,
    preview.newImageUrl,
  );
  if (imageSides.length === 0) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        No preview available for this image.
      </div>
    );
  }
  const expandedImageSide =
    expandedImageIndex === null ? undefined : imageSides[expandedImageIndex];
  const stepExpandedImage = (direction: "previous" | "next") => {
    setExpandedImageIndex((currentIndex) =>
      currentIndex === null
        ? null
        : getWrappedImageIndex({
            currentIndex,
            direction,
            itemCount: imageSides.length,
          }),
    );
  };
  return (
    <>
      <div
        className={
          fitToFrame
            ? imageSides.length > 1
              ? "grid grid-cols-1 gap-3 px-3 py-3 sm:grid-cols-2"
              : "grid grid-cols-1 gap-3 px-3 py-3"
            : "flex items-start gap-3 px-3 py-3"
        }
      >
        {imageSides.map((side, index) => (
          <figure key={side.url} className="min-w-0">
            <button
              type="button"
              className={
                fitToFrame
                  ? "flex h-64 w-full cursor-zoom-in items-center justify-center rounded-md border border-border bg-surface-recessed p-3"
                  : "block max-w-full cursor-zoom-in"
              }
              onClick={() => setExpandedImageIndex(index)}
            >
              <img
                src={side.url}
                alt={getGitDiffCardImageAlt(fileDiffLabel, side)}
                style={IMAGE_TRANSPARENCY_CHECKER_STYLE}
                className={
                  fitToFrame
                    ? "block h-full w-full object-contain"
                    : "block max-h-80 max-w-full rounded-md border border-border object-contain"
                }
              />
            </button>
            {side.caption !== null ? (
              <figcaption className="mt-1 text-xs text-muted-foreground">
                {side.caption}
              </figcaption>
            ) : null}
          </figure>
        ))}
      </div>
      <ImageLightbox
        title={`${fileDiffLabel} image preview`}
        imageSrc={expandedImageSide?.url ?? null}
        imageAlt={
          expandedImageSide
            ? getGitDiffCardImageAlt(fileDiffLabel, expandedImageSide)
            : fileDiffLabel
        }
        hasMultipleImages={imageSides.length > 1}
        onPrevious={() => stepExpandedImage("previous")}
        onNext={() => stepExpandedImage("next")}
        onClose={() => setExpandedImageIndex(null)}
      />
    </>
  );
}

function GitDiffCardImageBody({
  enrichment,
  fileDiffLabel,
  fitToFrame = false,
}: GitDiffCardImageBodyProps) {
  if (enrichment.status === "idle" || enrichment.status === "loading") {
    return <DiffLoadingSkeleton />;
  }
  const preview = getGitDiffCardImageUrls(enrichment);
  if (preview === null) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        No preview available for this image.
      </div>
    );
  }
  return (
    <GitDiffCardImagePreviewBody
      preview={preview}
      fileDiffLabel={fileDiffLabel}
      fitToFrame={fitToFrame}
    />
  );
}

interface GitDiffCardSvgBodyProps {
  displayMode: GitDiffCardSvgDisplayMode;
  enrichment: DiffFileEnrichmentState;
  fileDiff: ParsedGitDiffFile;
  fileDiffLabel: string;
  patchText: string | undefined;
  fullFileContents: ExperimentalDiffFullFileContents | null;
  presentation: DiffPresentation;
  onSelectionAddToChat?: (text: string) => void;
}

function GitDiffCardSvgBody({
  displayMode,
  enrichment,
  fileDiff,
  fileDiffLabel,
  patchText,
  fullFileContents,
  presentation,
  onSelectionAddToChat,
}: GitDiffCardSvgBodyProps) {
  return displayMode === "preview" ? (
    <GitDiffCardImageBody
      enrichment={enrichment}
      fileDiffLabel={fileDiffLabel}
      fitToFrame
    />
  ) : (
    <DiffHost
      file={fileDiff}
      patchText={patchText}
      fullFileContents={fullFileContents}
      {...presentation}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );
}

interface GitDiffCardBodyProps {
  state: GitDiffCardBodyState;
  presentation: DiffPresentation;
  svgDisplayMode: GitDiffCardSvgDisplayMode;
  reservesCollapseGutter: boolean;
  onSelectionAddToChat?: (text: string) => void;
}

export function GitDiffCardBody({
  state,
  presentation,
  svgDisplayMode,
  reservesCollapseGutter,
  onSelectionAddToChat,
}: GitDiffCardBodyProps) {
  const {
    bodySentinelRef,
    enrichment,
    fileDiff,
    fileDiffLabel,
    isImageCard,
    isSvgPreviewCard,
    shouldGateDeletedDiff,
    shouldRenderDiffView,
    loadDeletedDiff,
    contextExpansion,
    fullFileContents,
    patchText,
  } = state;

  return (
    <div
      ref={bodySentinelRef}
      className="overflow-hidden rounded-b-lg bg-background"
      style={GIT_DIFF_CARD_BODY_STYLE}
    >
      {shouldGateDeletedDiff ? (
        <div className="flex items-center py-3 pl-2 pr-3 text-xs text-muted-foreground">
          {reservesCollapseGutter ? (
            <span aria-hidden className="w-8 shrink-0" />
          ) : null}
          <span className="pl-[1ch]">
            <span>This file was deleted.</span>{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs underline underline-offset-4 hover:underline"
              onClick={loadDeletedDiff}
            >
              Load diff
            </Button>
          </span>
        </div>
      ) : !shouldRenderDiffView ? (
        <DiffLoadingSkeleton />
      ) : isImageCard ? (
        <GitDiffCardImageBody
          enrichment={enrichment}
          fileDiffLabel={fileDiffLabel}
        />
      ) : isSvgPreviewCard ? (
        <GitDiffCardSvgBody
          displayMode={svgDisplayMode}
          enrichment={enrichment}
          fileDiff={fileDiff}
          fileDiffLabel={fileDiffLabel}
          patchText={patchText}
          fullFileContents={fullFileContents}
          presentation={presentation}
          onSelectionAddToChat={onSelectionAddToChat}
        />
      ) : (
        <>
          <DiffHost
            file={fileDiff}
            patchText={patchText}
            fullFileContents={fullFileContents}
            {...presentation}
            fallback={<DiffLoadingSkeleton />}
            onSelectionAddToChat={onSelectionAddToChat}
          />
          <GitDiffCardContextExpansionFooter
            contextExpansion={contextExpansion}
            reservesCollapseGutter={reservesCollapseGutter}
          />
        </>
      )}
    </div>
  );
}

interface GitDiffCardContextExpansionFooterProps {
  contextExpansion: DiffContextExpansionState;
  reservesCollapseGutter: boolean;
}

function GitDiffCardContextExpansionFooter({
  contextExpansion,
  reservesCollapseGutter,
}: GitDiffCardContextExpansionFooterProps) {
  const { status, request } = contextExpansion;
  if (status === "unavailable" || status === "ready") {
    return null;
  }
  return (
    <div className="flex items-center py-2 pl-2 pr-3 text-xs text-muted-foreground">
      {reservesCollapseGutter ? (
        <span aria-hidden className="w-8 shrink-0" />
      ) : null}
      <span className="pl-[1ch]">
        {status === "loading" ? (
          <span role="status">Loading context…</span>
        ) : (
          <>
            {status === "error" ? (
              <>
                <span className="text-destructive">
                  Couldn&apos;t load surrounding context.
                </span>{" "}
              </>
            ) : null}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs underline underline-offset-4 hover:underline"
              onClick={request}
            >
              {status === "error" ? "Retry" : "Expand context"}
            </Button>
          </>
        )}
      </span>
    </div>
  );
}
