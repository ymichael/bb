import { type ReactNode } from "react";
import {
  ExpandablePanel,
  EventCodeBlock,
} from "@beanbag/ui-core";
import {
  assertNever,
  formatEnvironmentDisplayName,
  type UIOperationMessage,
  type UIProvisioningMetadata,
} from "@beanbag/agent-core";
import { cn } from "@/lib/utils";
import {
  EVENT_DETAIL_MAX_HEIGHT_CLASS,
  EventTitle,
  formatCompactDuration,
  getEventHeaderToneClass,
  getStaticEventToneClass,
  renderShimmeringSummary,
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

function normalizeProvisioningEnvironmentLabel(
  provisioning: UIProvisioningMetadata | undefined,
): string | undefined {
  const value = provisioning?.environmentDisplayName?.trim();
  if (!value) return undefined;
  return formatEnvironmentDisplayName({ id: value, displayName: value });
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

function OperationDetailLines({ lines }: { lines: string[] }) {
  return (
    <div className="mt-0.5 space-y-0.5">
      {lines.map((line, index) => (
        <div key={`${line}:${index}`} className="font-mono ui-text-sm text-foreground/80">
          {line}
        </div>
      ))}
    </div>
  );
}

function buildProvisioningSummary(
  message: UIOperationMessage,
  tone: "default" | "destructive",
): ReactNode {
  const environmentLabel = normalizeProvisioningEnvironmentLabel(message.provisioning);
  const isPending = isPendingOperation(message);

  const summaryContent = (() => {
    switch (message.title) {
      case "Environment setup completed":
        return <EventTitle prefix="Environment setup" emphasis="completed" tone={tone} />;
      case "Environment setup failed":
        return <EventTitle prefix="Environment setup" emphasis="failed" tone={tone} />;
      case "Environment setup interrupted":
        return <EventTitle prefix="Environment setup" emphasis="interrupted" tone={tone} />;
      case "Provisioning interrupted":
        return <EventTitle prefix="Provisioning" emphasis="interrupted" tone={tone} />;
      default:
        if (message.title.startsWith("Provisioned ")) {
          return (
            <EventTitle
              prefix="Provisioned"
              emphasis={environmentLabel ?? message.title.slice("Provisioned ".length).trim()}
              tone={tone}
            />
          );
        }
        if (message.title.startsWith("Provisioning ")) {
          const label = environmentLabel ?? message.title.slice("Provisioning ".length).replace(/\.\.\.$/, "").trim();
          return <EventTitle prefix="Provisioning" emphasis={label || "environment"} tone={tone} />;
        }
        if (message.title.startsWith("Provisioning ") && tone === "destructive") {
          return <EventTitle prefix="Provisioning" emphasis="failed" tone={tone} />;
        }
        return <span>{message.title}</span>;
    }
  })();

  return renderShimmeringSummary(summaryContent, isPending);
}

function buildProvisioningTranscript(message: UIOperationMessage): {
  lines: string[];
  outputText?: string;
  outputCommand?: string;
} {
  const provisioning = message.provisioning;
  const environmentLabel = normalizeProvisioningEnvironmentLabel(provisioning) ?? "environment";
  const setup = provisioning?.setup;
  const lines = [`provisioning ${environmentLabel}`];
  const isWorktreeEnvironment = provisioning?.environmentId === "worktree";

  if (isWorktreeEnvironment) {
    lines.push("creating worktree");
  }
  if (isWorktreeEnvironment && provisioning?.branchName) {
    lines.push(`creating branch ${provisioning.branchName}`);
  }
  if (setup?.scriptPath) {
    lines.push(`running ${setup.scriptPath}`);
  }
  if (provisioning?.fallbackReason) {
    lines.push(`fallback: ${provisioning.fallbackReason}`);
  }
  if (message.status !== "pending" && message.startedAt !== undefined && message.createdAt >= message.startedAt) {
    lines.push(`provisioning took ${formatCompactDuration(message.createdAt - message.startedAt)}`);
  }

  return {
    lines,
    ...(setup?.output?.trim() ? { outputText: setup.output.trim() } : {}),
    ...(setup?.scriptPath ? { outputCommand: formatProvisioningSetupCommand(setup.scriptPath) } : {}),
  };
}

function buildGenericSummary(
  title: ReactNode,
  message: UIOperationMessage,
): ReactNode {
  return renderShimmeringSummary(title, isPendingOperation(message));
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

  if (message.opType === "plan-updated") {
    const detailLines = splitNonEmptyLines(message.detail);
    const summaryContent = buildGenericSummary(message.title, message);
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
    const { lines, outputText, outputCommand } = buildProvisioningTranscript(message);
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
    const summaryContent = buildGenericSummary(message.title, message);
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
      message.worktreeCommit?.message?.trim() ??
      detailLinesFromMessage.find((line) => line !== commitSha);
    const summaryContent = message.title === "Committed changes"
      ? <EventTitle prefix="Committed" emphasis="changes" tone={tone} />
      : buildGenericSummary(message.title, message);
    const detailLines = [commitMessage, commitSha].filter((value): value is string => Boolean(value));

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
    const summaryContent = isConflict
      ? buildGenericSummary(
          <EventTitle prefix="Squash merge" emphasis="failed" tone={tone} />,
          message,
        )
      : mergeTargetBranch
        ? <EventTitle prefix="Squash merged into" emphasis={mergeTargetBranch} tone={tone} emphasisAs="em" />
        : buildGenericSummary(message.title, message);
    const detailLines = [
      message.worktreeSquashMerge?.message,
      ...(message.worktreeSquashMerge?.conflictFiles?.length
        ? [`Conflicts: ${message.worktreeSquashMerge.conflictFiles.join(", ")}`]
        : []),
      message.worktreeSquashMerge?.prepCommitMessage
        ? `Commit: ${message.worktreeSquashMerge.prepCommitMessage}`
        : undefined,
      message.worktreeSquashMerge?.prepCommitSha
        ? `Hash: ${message.worktreeSquashMerge.prepCommitSha}`
        : undefined,
      ...splitNonEmptyLines(message.detail).filter((line) => line !== message.worktreeSquashMerge?.message),
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
    const summaryContent = buildGenericSummary(message.title, message);

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
  const summaryContent = buildGenericSummary(message.title, message);

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
