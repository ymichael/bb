import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { formatHomePathForDisplay } from "@bb/shared-ui/lib/utils";
import { ResourceInfiniteScrollSentinel } from "@bb/shared-ui/resource-pagination";
import {
  ResourceDefinitionSection,
  ResourceDetailCollection,
  ResourceDetailIncludesSection,
  ResourceDetailPage,
  ResourceDetailPanel,
  ResourceDetailStack,
} from "@bb/shared-ui/resource-list";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { FilePreview } from "@/components/secondary-panel/FilePreview.js";
import { ProvenancePill } from "@/components/tools/ProvenancePill";
import { useClipboardCopy } from "@/lib/clipboard";

type SkillDetailTitleBadge = {
  label: string;
  tooltip: ReactNode;
  accessibleLabel?: string;
};

type SkillDetailContentState =
  | { kind: "loading" }
  | { kind: "error"; message: string; onRetry: () => void }
  | { kind: "ready"; content: string };

interface SkillDetailViewProps {
  leading?: ReactNode;
  title: string;
  path: string;
  pathHref?: string;
  titleBadge?: SkillDetailTitleBadge;
  headerActions?: ReactNode;
  overflowMenu?: ReactNode;
  files: readonly string[];
  selectedPath: string;
  onSelectFile: (path: string) => void;
  contentState: SkillDetailContentState;
  footer?: ReactNode;
}

function SkillPath({ path, href }: { path: string; href?: string }) {
  const { copied, copy } = useClipboardCopy({
    text: path,
    errorMessage: "Failed to copy path.",
  });
  const displayPath = formatHomePathForDisplay(path);

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${path} in a new tab`}
              className="group -ml-1.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs text-subtle-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="truncate font-mono">{displayPath}</span>
              <Icon
                name="ExternalLink"
                className="size-3 shrink-0"
                aria-hidden
              />
            </a>
          ) : (
            <button
              type="button"
              aria-label={`Copy skill path: ${path}`}
              onClick={() => void copy()}
              className="group -ml-1.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs text-subtle-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="truncate font-mono">{displayPath}</span>
              <Icon
                name={copied ? "Check" : "Copy"}
                className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                aria-hidden
              />
            </button>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {href ? "Open on skills.sh" : copied ? "Copied" : "Copy path"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function getSkillDirectoryPath(path: string): string {
  return path.replace(/[\\/]SKILL\.md$/i, "");
}

function SkillFileList({
  files,
  selectedPath,
  onSelectFile,
}: {
  files: readonly string[];
  selectedPath: string;
  onSelectFile: (path: string) => void;
}) {
  return (
    <ResourceDetailCollection className="max-h-48 overflow-auto">
      {files.map((path) => (
        <button
          key={path}
          type="button"
          aria-pressed={path === selectedPath}
          onClick={() => onSelectFile(path)}
          className="flex w-full min-w-0 items-center px-3 py-2 text-left font-mono text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground aria-pressed:bg-surface-recessed/45 aria-pressed:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate">
            {formatHomePathForDisplay(path)}
          </span>
        </button>
      ))}
    </ResourceDetailCollection>
  );
}

const SKILL_CONTENT_CHUNK_LINES = 120;

export function splitMarkdownIntoChunks(content: string): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of lines) {
    current.push(line);
    if (/^\s*(```|~~~)/u.test(line)) {
      inFence = !inFence;
    }
    if (
      !inFence &&
      current.length >= SKILL_CONTENT_CHUNK_LINES &&
      line.trim() === ""
    ) {
      chunks.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

function ScrollingSkillContent({
  path,
  content,
  markdown,
}: {
  path: string;
  content: string;
  markdown: boolean;
}) {
  const chunks = useMemo(
    () => (markdown ? splitMarkdownIntoChunks(content) : [content]),
    [content, markdown],
  );
  const [visibleChunkCount, setVisibleChunkCount] = useState(1);
  const shownChunks = chunks.slice(0, visibleChunkCount);
  return (
    <ResourceDetailPanel surface="recessed" className="shadow-none">
      <div
        data-skill-content-viewport
        data-infinite-scroll-root
        className="max-h-[60dvh] overflow-y-auto overscroll-contain"
      >
        {shownChunks.map((chunk, index) => (
          <FilePreview
            key={index}
            path={path}
            headerMode="none"
            state={{
              kind: "ready",
              file: {
                name: path.split("/").at(-1) ?? path,
                contents: chunk,
              },
              lineRange: null,
              textPreviewKind: markdown ? "markdown" : null,
            }}
          />
        ))}
        <ResourceInfiniteScrollSentinel
          hasMore={visibleChunkCount < chunks.length}
          onLoadMore={() =>
            setVisibleChunkCount((current) =>
              Math.min(current + 1, chunks.length),
            )
          }
        />
      </div>
    </ResourceDetailPanel>
  );
}

export function SkillDetailView({
  leading,
  title,
  path,
  pathHref,
  titleBadge,
  headerActions,
  overflowMenu,
  files,
  selectedPath,
  onSelectFile,
  contentState,
  footer,
}: SkillDetailViewProps) {
  const directoryPath = getSkillDirectoryPath(path);
  const selectedDisplayPath = formatHomePathForDisplay(selectedPath);
  const selectedFileIsMarkdown = selectedPath.toLowerCase().endsWith(".md");
  const titleMeta =
    titleBadge === undefined ? undefined : (
      <ProvenancePill
        label={titleBadge.label}
        tooltip={titleBadge.tooltip}
        accessibleLabel={titleBadge.accessibleLabel}
      />
    );
  return (
    <ResourceDetailPage
      leading={leading}
      title={title}
      titleMeta={titleMeta}
      metadata={<SkillPath path={directoryPath} href={pathHref} />}
      overflowMenu={overflowMenu}
      actions={headerActions}
    >
      <ResourceDetailStack>
        {files.length > 1 ? (
          <ResourceDetailIncludesSection label="Files">
            <SkillFileList
              files={files}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          </ResourceDetailIncludesSection>
        ) : null}

        <ResourceDefinitionSection label={selectedDisplayPath}>
          {contentState.kind === "loading" ? (
            <ResourceDetailPanel
              surface="recessed"
              className="px-3 py-10 text-center text-sm text-muted-foreground"
            >
              Loading {selectedDisplayPath}…
            </ResourceDetailPanel>
          ) : contentState.kind === "error" ? (
            <ResourceDetailPanel
              surface="recessed"
              className="px-3 py-10 text-center text-sm"
            >
              <div
                role="alert"
                className="flex items-start justify-center gap-2 text-foreground"
              >
                <Icon
                  name="CircleX"
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden
                />
                <p>{contentState.message}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={contentState.onRetry}
              >
                Retry
              </Button>
            </ResourceDetailPanel>
          ) : (
            <ScrollingSkillContent
              key={`${selectedPath}:${contentState.content}`}
              path={selectedPath}
              content={contentState.content}
              markdown={selectedFileIsMarkdown}
            />
          )}
        </ResourceDefinitionSection>
      </ResourceDetailStack>
      {footer}
    </ResourceDetailPage>
  );
}
