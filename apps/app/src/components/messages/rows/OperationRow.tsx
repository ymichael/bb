import { type ReactNode } from "react";
import {
  ExpandablePanel,
  EventCodeBlock,
} from "@bb/ui-core";
import {
  assertNever,
  type UIOperationMessage,
  type UIProvisioningMetadata,
  type UIProvisioningTranscriptEntry,
} from "@bb/core";
import { cn } from "@/lib/utils";
import {
  EVENT_DETAIL_MAX_HEIGHT_CLASS,
  ExpandableDetailScrollArea,
  EventTitle,
  formatCompactDuration,
  formatElapsedSince,
  getEventHeaderToneClass,
  getStaticEventToneClass,
  useLiveNow,
  useLatestInitialExpanded,
} from "./shared";
import { TerminalOutputBlock } from "./TerminalOutputBlock";

type ThreadOperationIntentPhase = NonNullable<UIOperationMessage["threadOperation"]>["phase"];
type PrimaryCheckoutPhase = NonNullable<UIOperationMessage["primaryCheckout"]>["phase"];

function splitNonEmptyLines(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\n|•/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatProvisioningSetupCommand(scriptPath: string | undefined): string | undefined {
  const value = scriptPath?.trim();
  if (!value) return undefined;
  if (
    value.startsWith("./") ||
    value.startsWith("~/") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value)
  ) {
    return `bash -x ${value}`;
  }
  return `bash -x ./${value}`;
}

function formatProvisioningRunningSuffix(
  startedAt: number | undefined,
  now: number | undefined,
): string {
  if (startedAt === undefined || now === undefined || now < startedAt) {
    return "";
  }
  return ` (${formatElapsedSince(startedAt, now)})`;
}

function formatProvisioningTranscriptEntry(
  entry: UIProvisioningTranscriptEntry,
  now?: number,
): string | undefined {
  return `${entry.text}${formatProvisioningRunningSuffix(entry.startedAt, now)}`;
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

function extractMergeTargetBranch(message: UIOperationMessage): string | undefined {
  const mergeBaseBranch = message.worktreeSquashMerge?.mergeBaseBranch?.trim();
  if (mergeBaseBranch) return mergeBaseBranch;

  const candidates = [message.worktreeSquashMerge?.message, message.detail];
  for (const candidate of candidates) {
    const match = candidate?.match(/\b(?:into|to)\s+[`'"]?([A-Za-z0-9._/-]+)[`'"]?/i);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function formatCommitDetailLine({
  commitSha,
  commitMessage,
}: {
  commitSha?: string;
  commitMessage?: string;
}): string | undefined {
  const normalizedSha = commitSha?.trim();
  const normalizedMessage = commitMessage?.trim();
  const shortSha = normalizedSha?.slice(0, 7);

  if (shortSha && normalizedMessage) {
    return `[${shortSha}] ${normalizedMessage}`;
  }
  if (shortSha) {
    return `[${shortSha}]`;
  }
  return normalizedMessage;
}

function isShimmeringThreadOperationIntentPhase(phase: ThreadOperationIntentPhase): boolean {
  switch (phase) {
    case "requested":
    case "queued":
    case "running":
      return true;
    case "completed":
    case "failed":
    case "update":
      return false;
    default:
      return assertNever(phase);
  }
}

function isShimmeringPrimaryCheckoutPhase(phase: PrimaryCheckoutPhase): boolean {
  switch (phase) {
    case "started":
      return true;
    case "completed":
    case "failed":
    case "noop":
    case "update":
      return false;
    default:
      return assertNever(phase);
  }
}

function isPendingOperation(message: UIOperationMessage): boolean {
  if (message.status !== undefined) {
    return message.status === "pending";
  }
  if (message.threadOperation) {
    return isShimmeringThreadOperationIntentPhase(message.threadOperation.phase);
  }
  if (message.primaryCheckout) {
    return isShimmeringPrimaryCheckoutPhase(message.primaryCheckout.phase);
  }
  return false;
}

function getOperationTone(message: UIOperationMessage): "default" | "destructive" {
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
  message: UIOperationMessage,
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
  message: UIOperationMessage,
  now?: number,
): {
  lines: string[];
  outputText?: string;
  outputCommand?: string;
} {
  const provisioning = message.provisioning;
  const setup = provisioning?.setup;
  const transcriptLines = provisioning?.transcript
    ?.map((entry) => formatProvisioningTranscriptEntry(entry, now))
    .filter((line): line is string => Boolean(line));
  const lines = transcriptLines && transcriptLines.length > 0 ? transcriptLines : [];
  if (message.status !== "pending" && message.startedAt !== undefined && message.createdAt >= message.startedAt) {
    lines.push(`provisioning took ${formatCompactDuration(message.createdAt - message.startedAt)}`);
  }

  return {
    lines,
    ...(setup?.output?.trim() ? { outputText: setup.output.trim() } : {}),
    ...(setup?.scriptPath ? { outputCommand: formatProvisioningSetupCommand(setup.scriptPath) } : {}),
  };
}

function buildThreadOperationIntentSummary(
  message: UIOperationMessage,
  tone: "default" | "destructive",
): ReactNode {
  const metadata = message.threadOperation;
  if (!metadata) return <span>{message.title}</span>;

  const baseLabel = metadata.action === "commit" ? "Commit" : "Squash merge";
  switch (metadata.phase) {
    case "requested":
      return <EventTitle prefix={baseLabel} detail="requested" tone={tone} />;
    case "queued":
      return <EventTitle prefix={baseLabel} detail="queued" tone={tone} />;
    case "running":
      return (
        <EventTitle
          prefix={metadata.action === "commit" ? "Committing" : "Squash merging"}
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
      return assertNever(metadata.phase);
  }
}

function buildPrimaryCheckoutSummary(
  message: UIOperationMessage,
  tone: "default" | "destructive",
): ReactNode {
  const metadata = message.primaryCheckout;
  if (!metadata) return <span>{message.title}</span>;

  switch (metadata.action) {
    case "promote":
      switch (metadata.phase) {
        case "started":
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
        case "noop":
          return <EventTitle prefix="Primary checkout" detail="already promoted" tone={tone} />;
        case "update":
          return <EventTitle prefix="Primary checkout promotion" detail="update" tone={tone} />;
        default:
          return assertNever(metadata.phase);
      }
    case "demote":
      switch (metadata.phase) {
        case "started":
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
        case "noop":
          return <EventTitle prefix="Primary checkout" detail="already demoted" tone={tone} />;
        case "update":
          return <EventTitle prefix="Primary checkout demotion" detail="update" tone={tone} />;
        default:
          return assertNever(metadata.phase);
      }
    default:
      return assertNever(metadata.action);
  }
}

function buildCompactionSummary(
  message: UIOperationMessage,
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
  message: UIOperationMessage;
  initialExpanded?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const tone = getOperationTone(message);
  const liveNow = useLiveNow(isExpanded && message.opType === "provisioning" && message.status === "pending");

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
    const { lines, outputText, outputCommand } = buildProvisioningTranscript(message, liveNow);
    const additionalDetailLines = splitNonEmptyLines(message.detail).filter(
      (line) => !lines.includes(line),
    );
    const hasDetails = lines.length > 0 || additionalDetailLines.length > 0 || Boolean(outputText);

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
          {outputText ? (
            <TerminalOutputBlock
              command={outputCommand}
              outputText={outputText}
              isExpanded={isExpanded}
            />
          ) : null}
          {additionalDetailLines.length > 0 ? (
            <OperationDetailLines lines={additionalDetailLines} />
          ) : null}
        </div>
      </ExpandableOperationRow>
    );
  }

  if (message.opType === "thread-operation-intent") {
    const { operationDetailText, promptText } = extractPromptSections(message.detail);
    const summaryContent = buildThreadOperationIntentSummary(message, tone);
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

  if (message.opType === "worktree-commit") {
    const detailLinesFromMessage = splitNonEmptyLines(message.detail);
    const commitSha =
      message.worktreeCommit?.commitSha?.trim() ??
      detailLinesFromMessage.find((line) => /^[0-9a-f]{7,40}$/i.test(line));
    const commitMessage =
      message.worktreeCommit?.commitSubject?.trim() ??
      message.worktreeCommit?.message?.trim() ??
      detailLinesFromMessage.find((line) => line !== commitSha);
    const summaryContent = message.title === "Committed changes"
      ? <EventTitle prefix="Committed" detail="changes" tone={tone} />
      : buildGenericSummary(message.title);
    const detailLines = [
      formatCommitDetailLine({ commitSha, commitMessage }),
    ].filter((value): value is string => Boolean(value));

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

  if (message.opType === "worktree-squash-merge") {
    const mergeTargetBranch = extractMergeTargetBranch(message);
    const isConflict = message.worktreeSquashMerge?.status === "conflict" || message.status === "error";
    const squashCommitLine = !isConflict
      ? formatCommitDetailLine({
          commitSha: message.worktreeSquashMerge?.commitSha?.trim(),
          commitMessage:
            message.worktreeSquashMerge?.commitSubject?.trim() ??
            message.worktreeSquashMerge?.message?.trim(),
        })
      : undefined;
    const summaryContent = isConflict
      ? buildGenericSummary(
          <EventTitle prefix="Squash merge" emphasis="failed" tone={tone} />,
        )
      : mergeTargetBranch
        ? <EventTitle prefix="Squash merged into" emphasis={mergeTargetBranch} tone={tone} emphasisAs="em" />
        : buildGenericSummary(message.title);
    const detailLines = [
      squashCommitLine,
      ...(message.worktreeSquashMerge?.conflictFiles?.length
        ? [`Conflicts: ${message.worktreeSquashMerge.conflictFiles.join(", ")}`]
        : []),
      message.worktreeSquashMerge?.prepCommitMessage
        ? `Commit: ${message.worktreeSquashMerge.prepCommitMessage}`
        : undefined,
      message.worktreeSquashMerge?.prepCommitSha
        ? `Hash: ${message.worktreeSquashMerge.prepCommitSha}`
        : undefined,
      ...splitNonEmptyLines(message.detail).filter((line) =>
        line !== message.worktreeSquashMerge?.message &&
        line !== squashCommitLine
      ),
    ].filter((value): value is string => Boolean(value));

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

  if (message.opType === "primary-checkout") {
    const detailLines = splitNonEmptyLines(message.detail);
    const shouldUseSubtleTitle =
      tone !== "destructive" &&
      (message.title === "Promoted to primary checkout" ||
        message.title === "Demoted from primary checkout" ||
        message.title === "Promoted then demoted as primary checkout");
    const summaryContent = buildPrimaryCheckoutSummary(message, tone);

    if (detailLines.length === 0) {
      return (
        <StaticOperationRow
          summaryContent={summaryContent}
          tone={tone}
          className={shouldUseSubtleTitle ? "text-muted-foreground/70" : undefined}
        />
      );
    }

    return (
      <ExpandableOperationRow
        isExpanded={isExpanded}
        onToggle={onToggle}
        summaryContent={summaryContent}
        tone={tone}
        summaryContentClassName={cn("min-w-0", shouldUseSubtleTitle ? "text-muted-foreground/70" : undefined)}
      >
        <OperationDetailLines lines={detailLines} />
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
