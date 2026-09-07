import { useEffect, useState } from "react";
import {
  assertNever,
  fileNameFromPath,
  type TimelineImageViewViewWorkRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { EventCodeBlock } from "../../ui/event-code-block.js";
import { ImageLightbox } from "../../ui/image-lightbox.js";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { TerminalOutputBlock } from "./TerminalOutputBlock.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { LazyTimelineFileDiffBlock } from "./LazyTimelineFileDiffBlock.js";
import { ToolCallDetailBlock } from "./ToolCallDetailBlock.js";
import { QuestionWorkRowBody } from "./QuestionWorkRowBody.js";
import { WorkflowWorkRowBody } from "./WorkflowWorkRowBody.js";
import {
  PlanStepsWorkRowBody,
  PresentationDetail,
} from "./PresentationWorkRowBodies.js";
import {
  useTimelineWorkRowFullOutput,
  type TimelinePreviewableWorkRow,
  type TimelineWorkRowFullOutput,
  type TimelineWorkRowFullOutputState,
} from "./useTimelineWorkRowFullOutput.js";
import { buildThreadHostFileContentUrl } from "@/lib/file-content-urls";
import type { ThreadTimelineImageViewSrcResolver } from "./types.js";

interface WorkRowBodyProps {
  resolveImageViewSrc?: ThreadTimelineImageViewSrcResolver;
  row: TimelineViewWorkRow;
  workspaceRootPath: string | undefined;
}

type DetailLine = string | null;

interface ImageViewWorkRowBodyProps {
  resolveImageViewSrc?: ThreadTimelineImageViewSrcResolver;
  row: TimelineImageViewViewWorkRow;
}

interface CommandWorkRowBodyProps {
  row: Extract<TimelineViewWorkRow, { workKind: "command" }>;
}

interface ToolWorkRowBodyProps {
  row: Extract<TimelineViewWorkRow, { workKind: "tool" }>;
}

interface OutputPreviewNoteProps {
  fullOutput: TimelineWorkRowFullOutput;
  row: TimelinePreviewableWorkRow;
}

interface OutputPreviewNoteArgs {
  state: TimelineWorkRowFullOutputState;
  totalChars: number;
}

interface ResolveImageViewSourceArgs {
  resolveImageViewSrc: ThreadTimelineImageViewSrcResolver | undefined;
  row: TimelineImageViewViewWorkRow;
}

function compactDetailLines(lines: readonly DetailLine[]): string[] {
  const compactedLines: string[] = [];
  for (const line of lines) {
    if (line !== null) {
      compactedLines.push(line);
    }
  }
  return compactedLines;
}

function resolveImageViewSource({
  resolveImageViewSrc,
  row,
}: ResolveImageViewSourceArgs): string {
  return resolveImageViewSrc
    ? resolveImageViewSrc({ path: row.path, threadId: row.threadId })
    : buildThreadHostFileContentUrl(row.threadId, row.path);
}

function ImageViewWorkRowBody({
  resolveImageViewSrc,
  row,
}: ImageViewWorkRowBodyProps) {
  const [loadError, setLoadError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const imageSrc = resolveImageViewSource({ resolveImageViewSrc, row });
  const imageName = fileNameFromPath(row.path);
  const imageAlt = `Viewed image: ${imageName}`;

  useEffect(() => {
    setLoadError(false);
    setLightboxOpen(false);
  }, [imageSrc, row.completedAt, row.status]);

  if (loadError) {
    return (
      <EmptyStatePanel className="rounded-lg">
        <div>Image preview unavailable.</div>
        <div className="mt-1 break-all font-mono text-xs">{row.path}</div>
      </EmptyStatePanel>
    );
  }

  return (
    <>
      <button
        type="button"
        className="block w-full max-w-80 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-96"
        onClick={() => setLightboxOpen(true)}
        aria-label={`Open image preview: ${imageName}`}
      >
        <img
          src={imageSrc}
          alt=""
          className="block h-auto w-full object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setLoadError(true)}
        />
      </button>
      <ImageLightbox
        imageAlt={imageAlt}
        imageSrc={lightboxOpen ? imageSrc : null}
        onClose={() => setLightboxOpen(false)}
        title={imageAlt}
      />
    </>
  );
}

function outputPreviewNoteText({
  state,
  totalChars,
}: OutputPreviewNoteArgs): string | null {
  const total = `${totalChars.toLocaleString()} characters`;
  switch (state) {
    case "streaming-preview":
      return `Preview of ${total}. The full output loads when this finishes.`;
    case "loading":
      return `Loading the full output (${total})…`;
    case "error":
      return `Failed to load the full output (${total}).`;
    case "complete":
    case "loaded":
      return null;
    default:
      return assertNever(state);
  }
}

function OutputPreviewNote({ fullOutput, row }: OutputPreviewNoteProps) {
  if (row.outputPreview === undefined) {
    return null;
  }
  const text = outputPreviewNoteText({
    state: fullOutput.state,
    totalChars: row.outputPreview.totalChars,
  });
  if (text === null) {
    return null;
  }
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-testid="timeline-output-preview-note"
    >
      <span>{text}</span>
      {fullOutput.state === "error" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={fullOutput.retry}
          className="h-6 cursor-pointer px-2"
        >
          <Icon name="RotateCcw" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function CommandWorkRowBody({ row }: CommandWorkRowBodyProps) {
  const fullOutput = useTimelineWorkRowFullOutput(row);
  return (
    <div className="space-y-1">
      <TerminalOutputBlock
        commandLine={`$ ${row.command}`}
        metadataLines={compactDetailLines([
          row.source ? `source: ${row.source}` : null,
        ])}
        output={fullOutput.output}
        exitCode={row.exitCode}
        streaming={row.status === "pending"}
      />
      <OutputPreviewNote fullOutput={fullOutput} row={row} />
    </div>
  );
}

function ToolWorkRowBody({ row }: ToolWorkRowBodyProps) {
  const fullOutput = useTimelineWorkRowFullOutput(row);
  return (
    <div className="space-y-1">
      <PresentationDetail presentation={row.presentation} />
      <ToolCallDetailBlock
        toolName={row.toolName}
        args={row.toolArgs}
        output={fullOutput.output}
        streaming={row.status === "pending"}
      />
      <OutputPreviewNote fullOutput={fullOutput} row={row} />
    </div>
  );
}

export function WorkRowBody({
  resolveImageViewSrc,
  row,
  workspaceRootPath,
}: WorkRowBodyProps) {
  switch (row.workKind) {
    case "command":
      return <CommandWorkRowBody row={row} />;
    case "tool":
      return <ToolWorkRowBody row={row} />;
    case "file-change":
      return (
        <div className="space-y-2">
          <LazyTimelineFileDiffBlock
            change={row.change}
            workspaceRootPath={workspaceRootPath}
          />
          {row.stderr ? (
            <TimelineDetailScroll
              size="base"
              contentKey={row.stderr}
              className="rounded-md"
            >
              <EventCodeBlock
                tone="danger"
                className="rounded-none border-0 px-2 py-1.5"
              >
                {row.stderr}
              </EventCodeBlock>
            </TimelineDetailScroll>
          ) : null}
        </div>
      );
    case "delegation":
      return null;
    case "question":
      return <QuestionWorkRowBody row={row} />;
    case "workflow":
      return (
        <div className="space-y-2">
          <PresentationDetail presentation={row.presentation} />
          <WorkflowWorkRowBody row={row} />
        </div>
      );
    case "plan-steps":
      return <PlanStepsWorkRowBody row={row} />;
    case "extension":
      return <PresentationDetail presentation={row.presentation} />;
    case "image-view":
      return (
        <ImageViewWorkRowBody
          row={row}
          resolveImageViewSrc={resolveImageViewSrc}
        />
      );
    case "approval":
    case "web-search":
    case "web-fetch":
    case "file-read":
    case "search":
      return null;
    default:
      return assertNever(row);
  }
}
