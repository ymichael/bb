import { type ReactNode } from "react";
import { durationToCompactString } from "@bb/core-ui";
import {
  ExpandablePanel,
  EventCodeBlock,
} from "@bb/ui-core";
import type { ViewOperationMessage, ViewProvisioningMetadata, ViewProvisioningTranscriptEntry } from "@bb/domain";
import { cn } from "@/lib/utils";
import {
  EVENT_DETAIL_MAX_HEIGHT_CLASS,
  ExpandableDetailScrollArea,
  EventTitle,
  getEventHeaderToneClass,
  getStaticEventToneClass,
} from "./shared";
import { useLatestInitialExpanded } from "@/lib/latestInitialExpanded";


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
  return entry.text;
}

function extractPromptSections(detailText: string | undefined): {
  operationDetailText?: string;
  promptText?: string;
} {
  const normalizedDetail = detailText?.trim();
  if (!normalizedDetail) return {};
  const promptLabel = "Prompt:\n";
  const promptStart = normalizedDetail.indexOf(promptLabel);
  if (promptStart === -1) {
    return { operationDetailText: normalizedDetail };
  }

  const operationDetailText = normalizedDetail.slice(0, promptStart).trim();
  const promptText = normalizedDetail.slice(promptStart + promptLabel.length).trim();
  return {
    ...(operationDetailText ? { operationDetailText } : {}),
    ...(promptText ? { promptText } : {}),
  };
}

function isShimmeringOperationStatus(status: string): boolean {
  switch (status) {
    case "requested":
    case "queued":
    case "running":
    case "started":
      return true;
    default:
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

function getOperationTone(message: ViewOperationMessage): "default" | "destructive" {
  return message.status === "error" ? "destructive" : "default";
}

function StaticOperationRow({
  summaryContent,
  tone = "default",
  className,
}: {
  summaryContent: ReactNode;
  tone?: "default" | "destructive";
  className?: string;
}) {
  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
          <div className={cn("py-0.5", getStaticEventToneClass(tone), className)}>
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
}: {
  isExpanded: boolean;
  onToggle: () => void;
  summaryContent: ReactNode;
  tone?: "default" | "destructive";
  summaryContentClassName?: string;
  children: ReactNode;
}) {
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
  maxHeightClassName = EVENT_DETAIL_MAX_HEIGHT_CLASS,
}: {
  lines: string[];
  maxHeightClassName?: string;
}) {
  return (
    <ExpandableDetailScrollArea className="mt-0.5 space-y-0.5" maxHeightClassName={maxHeightClassName}>
      {lines.map((line, index) => (
        <div key={`${line}:${index}`} className="font-mono ui-text-sm text-foreground/80">
          {line}
        </div>
      ))}
    </ExpandableDetailScrollArea>
  );
}

function buildProvisioningSummary(
  message: ViewOperationMessage,
  tone: "default" | "destructive",
): ReactNode {
  const isPending = isPendingOperation(message);
  switch (message.title) {
    case "Environment setup completed":
      return <EventTitle prefix="Environment setup" emphasis="completed" tone={tone} />;
    case "Environment setup failed":
      return <EventTitle prefix="Environment setup" emphasis="failed" tone={tone} />;
    case "Environment setup interrupted":
      return <EventTitle prefix="Environment setup" emphasis="interrupted" tone={tone} />;
    case "Environment setup started":
    case "Environment setup running":
    case "Environment setup...":
      return <EventTitle prefix="Environment setup" tone={tone} shimmerPrefix={isPending} />;
    default:
      switch (message.status) {
        case "completed":
          return <EventTitle prefix="Provisioned" detail="environment" tone={tone} />;
        case "error":
          return <EventTitle prefix="Provisioning" detail="environment" emphasis="failed" tone={tone} />;
        case "interrupted":
          return (
            <EventTitle
              prefix="Provisioning"
              detail="environment"
              emphasis="interrupted"
              tone={tone}
            />
          );
        case "pending":
          return (
            <EventTitle
              prefix="Provisioning"
              detail="environment"
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
): {
  lines: string[];
} {
  const provisioning = message.provisioning;
  const transcriptLines = provisioning?.transcript
    ?.map((entry) => formatProvisioningTranscriptEntry(entry))
    .filter((line): line is string => Boolean(line));
  const lines = transcriptLines && transcriptLines.length > 0 ? transcriptLines : [];
  if (message.status !== "pending" && message.startedAt !== undefined && message.createdAt >= message.startedAt) {
    lines.push(
      `provisioning took ${durationToCompactString(message.createdAt - message.startedAt)}`,
    );
  }

  return { lines };
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildOperationSummary(
  message: ViewOperationMessage,
  tone: "default" | "destructive",
): ReactNode {
  const metadata = message.threadOperation;
  if (!metadata) return <span>{message.title}</span>;

  switch (metadata.operation) {
    case "commit":
    case "squash_merge": {
      const baseLabel = metadata.operation === "commit" ? "Commit" : "Squash merge";
      switch (metadata.status) {
        case "requested":
          return <EventTitle prefix={baseLabel} detail="requested" tone={tone} />;
        case "queued":
          return <EventTitle prefix={baseLabel} detail="queued" tone={tone} />;
        case "running":
          return (
            <EventTitle
              prefix={metadata.operation === "commit" ? "Committing" : "Squash merging"}
              detail="changes"
              tone={tone}
              shimmerPrefix
            />
          );
        case "completed":
          return <EventTitle prefix={baseLabel} detail="completed" tone={tone} />;
        case "failed":
          return <EventTitle prefix={baseLabel} emphasis="failed" tone={tone} />;
        case "update":
          return <EventTitle prefix={baseLabel} detail="update" tone={tone} />;
        default:
          return <EventTitle prefix={baseLabel} detail={metadata.status} tone={tone} />;
      }
    }
    case "primary_checkout": {
      const action = (metadata.metadata?.action as string) ?? "promote";
      switch (action) {
        case "promote":
          switch (metadata.status) {
            case "started":
            case "running":
              return (
                <EventTitle
                  prefix="Promoting"
                  detail="primary checkout"
                  tone={tone}
                  shimmerPrefix
                />
              );
            case "completed":
              return <EventTitle prefix="Promoted" detail="to primary checkout" tone={tone} />;
            case "failed":
              return <EventTitle prefix="Primary checkout promotion" emphasis="failed" tone={tone} />;
            default:
              return <EventTitle prefix="Primary checkout promotion" detail={metadata.status} tone={tone} />;
          }
        case "demote":
          switch (metadata.status) {
            case "started":
            case "running":
              return (
                <EventTitle
                  prefix="Demoting"
                  detail="primary checkout"
                  tone={tone}
                  shimmerPrefix
                />
              );
            case "completed":
              return <EventTitle prefix="Demoted" detail="from primary checkout" tone={tone} />;
            case "failed":
              return <EventTitle prefix="Primary checkout demotion" emphasis="failed" tone={tone} />;
            default:
              return <EventTitle prefix="Primary checkout demotion" detail={metadata.status} tone={tone} />;
          }
        default:
          return <EventTitle prefix="Primary checkout" detail={metadata.status} tone={tone} />;
      }
    }
    case "ownership_change": {
      const action = (metadata.metadata?.action as string) ?? "transfer";
      switch (metadata.status) {
        case "completed":
          return <EventTitle prefix={`Ownership ${action}`} detail="completed" tone={tone} />;
        case "failed":
          return <EventTitle prefix={`Ownership ${action}`} emphasis="failed" tone={tone} />;
        case "started":
        case "running":
          return <EventTitle prefix={`Ownership ${action}`} detail="in progress" tone={tone} shimmerPrefix />;
        default:
          return <EventTitle prefix={`Ownership ${action}`} detail={metadata.status} tone={tone} />;
      }
    }
    default: {
      const label = capitalizeFirst(metadata.operation.replace(/_/g, " "));
      return <EventTitle prefix={label} detail={metadata.status} tone={tone} />;
    }
  }
}

function buildCompactionSummary(
  message: ViewOperationMessage,
  tone: "default" | "destructive",
): ReactNode {
  if (message.status === "pending") {
    return <EventTitle prefix="Compacting" detail="context" tone={tone} shimmerPrefix />;
  }
  if (message.status === "interrupted") {
    return <EventTitle prefix="Context compaction" emphasis="interrupted" tone={tone} />;
  }
  return <span>{message.title}</span>;
}

function buildGenericSummary(title: ReactNode): ReactNode {
  return title;
}

export function OperationRow({
  message,
  initialExpanded = false,
}: {
  message: ViewOperationMessage;
  initialExpanded?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
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

  if (message.opType === "provisioning") {
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
          <OperationDetailLines lines={lines} />
          {additionalDetailLines.length > 0 ? (
            <OperationDetailLines lines={additionalDetailLines} />
          ) : null}
        </div>
      </ExpandableOperationRow>
    );
  }

  if (message.opType === "operation") {
    const { operationDetailText, promptText } = extractPromptSections(message.detail);
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
            <OperationDetailLines lines={splitNonEmptyLines(operationDetailText)} />
          ) : null}
          {promptText ? (
            <EventCodeBlock maxHeightClassName={EVENT_DETAIL_MAX_HEIGHT_CLASS}>
              {promptText}
            </EventCodeBlock>
          ) : null}
        </div>
      </ExpandableOperationRow>
    );
  }

  const detailLines = splitNonEmptyLines(message.detail);
  const summaryContent = message.opType === "compaction"
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
