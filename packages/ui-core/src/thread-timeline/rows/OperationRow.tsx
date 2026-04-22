import { type ReactNode, type Ref, type UIEvent } from "react";
import { durationToCompactString } from "@bb/core-ui";
import {
  getDetailScrollMaxHeightClass,
  type DetailScrollSize,
} from "../../detail-scroll-size.js";
import { ExpandablePanel } from "../../disclosure.js";
import { EventCodeBlock } from "../../event-content.js";
import type {
  ViewPermissionGrantLifecycleMessage,
  ViewOperationMessage,
  ViewProvisioningTranscriptEntry,
  ViewThreadOperationStatus,
} from "@bb/domain";
import { cx } from "../../utils.js";
import { ExpandableLine } from "./ExpandableLine.js";
import {
  ExpandableDetailScrollArea,
  EventTitle,
  getEventHeaderToneClass,
  getStaticEventToneClass,
  useStickyBottomAutoScroll,
} from "./shared.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";

type OperationTone = "default" | "destructive";

interface ExtractPromptSectionsResult {
  operationDetailText?: string;
  promptText?: string;
}

interface StaticOperationRowProps {
  className?: string;
  summaryContent: ReactNode;
  tone?: OperationTone;
}

interface ExpandableOperationRowProps {
  children: ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  summaryContent: ReactNode;
  summaryContentClassName?: string;
  tone?: OperationTone;
}

interface OperationDetailLinesProps {
  lines: string[];
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  scrollRef?: Ref<HTMLDivElement>;
  size?: DetailScrollSize;
  truncateLines?: boolean;
}

interface ProvisioningTranscript {
  lines: string[];
}

interface OperationRowProps {
  initialExpanded?: boolean;
  message: ViewOperationMessage;
}

interface PermissionGrantLifecycleRowProps {
  initialExpanded?: boolean;
  message: ViewPermissionGrantLifecycleMessage;
}

function splitNonEmptyLines(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\n|•/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatProvisioningTranscriptEntry(
  entry: ViewProvisioningTranscriptEntry,
): string | undefined {
  const durationMs =
    typeof entry.metadata?.durationMs === "number"
      ? entry.metadata.durationMs
      : undefined;
  if (
    durationMs !== undefined &&
    (entry.status === "completed" || entry.status === "failed")
  ) {
    return `${entry.text} (${durationToCompactString(durationMs)})`;
  }
  return entry.text;
}

function extractPromptSections(
  detailText: string | undefined,
): ExtractPromptSectionsResult {
  const normalizedDetail = detailText?.trim();
  if (!normalizedDetail) return {};
  const promptLabel = "Prompt:\n";
  const promptStart = normalizedDetail.indexOf(promptLabel);
  if (promptStart === -1) {
    return { operationDetailText: normalizedDetail };
  }

  const operationDetailText = normalizedDetail.slice(0, promptStart).trim();
  const promptText = normalizedDetail
    .slice(promptStart + promptLabel.length)
    .trim();
  return {
    ...(operationDetailText ? { operationDetailText } : {}),
    ...(promptText ? { promptText } : {}),
  };
}

function assertNeverOperationKind(value: never): never {
  throw new Error(`Unexpected thread operation kind: ${String(value)}`);
}

function isShimmeringOperationStatus(
  status: ViewThreadOperationStatus,
): boolean {
  switch (status) {
    case "requested":
    case "queued":
    case "running":
    case "started":
      return true;
    case "completed":
    case "failed":
    case "noop":
    case "other":
      return false;
  }
}

function isPendingOperation(message: ViewOperationMessage): boolean {
  if (message.status !== undefined) {
    return message.status === "pending";
  }
  if (message.threadOperation) {
    return isShimmeringOperationStatus(message.threadOperation.status);
  }
  return false;
}

function getOperationTone(
  message: ViewOperationMessage,
): OperationTone {
  return message.status === "error" ? "destructive" : "default";
}

function StaticOperationRow({
  summaryContent,
  tone = "default",
  className,
}: StaticOperationRowProps) {
  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
          <div
            className={cx("py-0.5", getStaticEventToneClass(tone), className)}
          >
            {summaryContent}
          </div>
        </div>
      </div>
    </div>
  );
}

function ExpandableOperationRow({
  isExpanded,
  onToggle,
  summaryContent,
  tone = "default",
  summaryContentClassName = "min-w-0",
  children,
}: ExpandableOperationRowProps) {
  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          summaryContentClassName={summaryContentClassName}
          headerToneClass={getEventHeaderToneClass(isExpanded, tone)}
          onToggle={onToggle}
        >
          {children}
        </ExpandablePanel>
      </div>
    </div>
  );
}

function OperationDetailLines({
  lines,
  truncateLines = false,
  scrollRef,
  onScroll,
  size = "regular",
}: OperationDetailLinesProps) {
  const baseLineClassName = "font-mono text-xs text-foreground/80";
  return (
    <ExpandableDetailScrollArea
      className="mt-0.5 space-y-0.5"
      scrollRef={scrollRef}
      onScroll={onScroll}
      size={size}
    >
      {lines.map((line, index) => {
        const key = `${line}:${index}`;
        if (truncateLines) {
          return (
            <ExpandableLine
              key={key}
              fullText={line}
              className={baseLineClassName}
              collapsedClassName="truncate"
            >
              {line}
            </ExpandableLine>
          );
        }
        return (
          <div key={key} className={baseLineClassName}>
            {line}
          </div>
        );
      })}
    </ExpandableDetailScrollArea>
  );
}

function buildProvisioningSummary(
  message: ViewOperationMessage,
  tone: OperationTone,
): ReactNode {
  const isPending = isPendingOperation(message);
  switch (message.title) {
    case "Environment setup completed":
      return (
        <EventTitle
          prefix="Environment setup"
          emphasis="completed"
          tone={tone}
        />
      );
    case "Environment setup failed":
      return (
        <EventTitle prefix="Environment setup" emphasis="failed" tone={tone} />
      );
    case "Environment setup interrupted":
      return (
        <EventTitle
          prefix="Environment setup"
          emphasis="interrupted"
          tone={tone}
        />
      );
    case "Environment setup started":
    case "Environment setup running":
    case "Environment setup...":
      return (
        <EventTitle
          prefix="Environment setup"
          tone={tone}
          shimmerPrefix={isPending}
        />
      );
    default:
      switch (message.status) {
        case "completed":
          return (
            <EventTitle prefix="Provisioned" detail="thread" tone={tone} />
          );
        case "error":
          return (
            <EventTitle
              prefix="Provisioning"
              detail="thread"
              emphasis="failed"
              tone={tone}
            />
          );
        case "interrupted":
          return (
            <EventTitle
              prefix="Provisioning"
              detail="thread"
              emphasis="interrupted"
              tone={tone}
            />
          );
        case "pending":
          return (
            <EventTitle
              prefix="Provisioning"
              detail="thread"
              tone={tone}
              shimmerPrefix={isPending}
            />
          );
        default:
          return <span>{message.title}</span>;
      }
  }
}

function buildProvisioningTranscript(
  message: ViewOperationMessage,
): ProvisioningTranscript {
  const provisioning = message.provisioning;
  const transcriptLines = provisioning?.transcript
    ?.map((entry) => formatProvisioningTranscriptEntry(entry))
    .filter((line): line is string => Boolean(line));
  const lines =
    transcriptLines && transcriptLines.length > 0 ? transcriptLines : [];
  // Operation rows advance createdAt as provisioning transcript updates arrive,
  // so createdAt - startedAt reflects the elapsed provisioning time.
  if (
    message.status !== "pending" &&
    message.startedAt !== undefined &&
    message.createdAt >= message.startedAt
  ) {
    const label =
      message.status === "completed"
        ? "Provisioned thread"
        : message.status === "error"
          ? "Provisioning thread failed"
          : "Provisioning thread interrupted";
    lines.push(
      `${label} (${durationToCompactString(message.createdAt - message.startedAt)})`,
    );
  }

  return { lines };
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildOperationSummary(
  message: ViewOperationMessage,
  tone: OperationTone,
): ReactNode {
  const metadata = message.threadOperation;
  if (!metadata) return <span>{message.title}</span>;
  const metadataAction =
    typeof metadata.metadata?.action === "string"
      ? metadata.metadata.action
      : undefined;

  switch (metadata.operation) {
    case "ownership_change": {
      const action = metadataAction ?? "transfer";
      switch (metadata.status) {
        case "completed":
          return (
            <EventTitle
              prefix={`Ownership ${action}`}
              detail="completed"
              tone={tone}
            />
          );
        case "failed":
          return (
            <EventTitle
              prefix={`Ownership ${action}`}
              emphasis="failed"
              tone={tone}
            />
          );
        case "started":
        case "running":
          return (
            <EventTitle
              prefix={`Ownership ${action}`}
              detail="in progress"
              tone={tone}
              shimmerPrefix
            />
          );
        default:
          return (
            <EventTitle
              prefix={`Ownership ${action}`}
              detail={metadata.rawStatus}
              tone={tone}
            />
          );
      }
    }
    case "other": {
      const label = capitalizeFirst(metadata.rawOperation.replace(/_/g, " "));
      return (
        <EventTitle prefix={label} detail={metadata.rawStatus} tone={tone} />
      );
    }
  }

  const unreachableKind: never = metadata.operation;
  return assertNeverOperationKind(unreachableKind);
}

function buildCompactionSummary(
  message: ViewOperationMessage,
  tone: "default" | "destructive",
): ReactNode {
  if (message.status === "pending") {
    return (
      <EventTitle
        prefix="Compacting"
        detail="context"
        tone={tone}
        shimmerPrefix
      />
    );
  }
  if (message.status === "interrupted") {
    return (
      <EventTitle
        prefix="Context compaction"
        emphasis="interrupted"
        tone={tone}
      />
    );
  }
  return <span>{message.title}</span>;
}

function buildGenericSummary(title: ReactNode): ReactNode {
  return title;
}

export function OperationRow({
  message,
  initialExpanded = false,
}: OperationRowProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const {
    elementRef: provisioningScrollRef,
    handleScroll: handleProvisioningScroll,
  } = useStickyBottomAutoScroll<HTMLDivElement>({
    isExpanded,
    scrollDep:
      message.opType === "thread-provisioning"
        ? message.provisioning?.transcript
        : undefined,
  });
  const tone = getOperationTone(message);
  if (message.opType === "plan-updated") {
    const detailLines = splitNonEmptyLines(message.detail);
    const summaryContent = buildGenericSummary(message.title);
    if (detailLines.length === 0) {
      return <StaticOperationRow summaryContent={summaryContent} tone={tone} />;
    }
    return (
      <ExpandableOperationRow
        isExpanded={isExpanded}
        onToggle={onToggle}
        summaryContent={summaryContent}
        tone={tone}
      >
        <OperationDetailLines lines={detailLines} />
      </ExpandableOperationRow>
    );
  }

  if (message.opType === "thread-provisioning") {
    const summaryContent = buildProvisioningSummary(message, tone);
    const { lines } = buildProvisioningTranscript(message);
    const additionalDetailLines = splitNonEmptyLines(message.detail).filter(
      (line) => !lines.includes(line),
    );
    const hasDetails = lines.length > 0 || additionalDetailLines.length > 0;

    if (!hasDetails) {
      return <StaticOperationRow summaryContent={summaryContent} tone={tone} />;
    }

    return (
      <ExpandableOperationRow
        isExpanded={isExpanded}
        onToggle={onToggle}
        summaryContent={summaryContent}
        tone={tone}
      >
        <div className="mt-0.5 space-y-2">
          <OperationDetailLines
            lines={lines}
            truncateLines
            scrollRef={provisioningScrollRef}
            onScroll={handleProvisioningScroll}
          />
          {additionalDetailLines.length > 0 ? (
            <OperationDetailLines lines={additionalDetailLines} />
          ) : null}
        </div>
      </ExpandableOperationRow>
    );
  }

  if (message.opType === "operation") {
    const { operationDetailText, promptText } = extractPromptSections(
      message.detail,
    );
    const summaryContent = buildOperationSummary(message, tone);
    if (!operationDetailText && !promptText) {
      return <StaticOperationRow summaryContent={summaryContent} tone={tone} />;
    }

    return (
      <ExpandableOperationRow
        isExpanded={isExpanded}
        onToggle={onToggle}
        summaryContent={summaryContent}
        tone={tone}
      >
        <div className="mt-0.5 space-y-2">
          {operationDetailText ? (
            <OperationDetailLines
              lines={splitNonEmptyLines(operationDetailText)}
            />
          ) : null}
          {promptText ? (
            <EventCodeBlock
              maxHeightClassName={getDetailScrollMaxHeightClass("regular")}
            >
              {promptText}
            </EventCodeBlock>
          ) : null}
        </div>
      </ExpandableOperationRow>
    );
  }

  const detailLines = splitNonEmptyLines(message.detail);
  const summaryContent =
    message.opType === "compaction"
      ? buildCompactionSummary(message, tone)
      : buildGenericSummary(message.title);

  if (detailLines.length === 0) {
    return <StaticOperationRow summaryContent={summaryContent} tone={tone} />;
  }

  return (
    <ExpandableOperationRow
      isExpanded={isExpanded}
      onToggle={onToggle}
      summaryContent={summaryContent}
      tone={tone}
    >
      <OperationDetailLines lines={detailLines} />
    </ExpandableOperationRow>
  );
}

export function PermissionGrantLifecycleRow({
  message,
  initialExpanded = false,
}: PermissionGrantLifecycleRowProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const tone = message.status === "error" ? "destructive" : "default";
  const detailLines = [
    "Permission grant approval",
    `Item: ${message.approvalTarget.itemId}`,
    ...(message.approvalTarget.toolName
      ? [`Tool: ${message.approvalTarget.toolName}`]
      : []),
  ];

  return (
    <ExpandableOperationRow
      isExpanded={isExpanded}
      onToggle={onToggle}
      summaryContent={<span>{message.title}</span>}
      tone={tone}
    >
      <OperationDetailLines lines={detailLines} />
    </ExpandableOperationRow>
  );
}
