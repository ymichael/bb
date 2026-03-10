import {
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  COLLAPSIBLE_HEADER_TEXT_CLASS,
  ExpandablePanel,
  EventCodeBlock,
  EventMetaItem,
  EventMetaList,
  StatusPill,
  type StatusPillVariant,
  getCollapsibleHeaderToneClass,
} from "@beanbag/ui-core";
import {
  assertNever,
  formatEnvironmentDisplayName,
  type UIOperationMessage,
  type UIProvisioningSetupMetadata,
} from "@beanbag/agent-core";
import { OpenPathButton } from "@/components/shared/OpenPathButton";
import { resolveWorkspaceAbsolutePath } from "@/lib/workspace-path";
import { shouldShimmerOperationTitle } from "./operationOngoingState";
import {
  EVENT_DETAIL_MAX_HEIGHT_CLASS,
  renderShimmeringSummary,
  useLatestInitialExpanded,
} from "./shared";
import { TerminalOutputBlock } from "./TerminalOutputBlock";

function splitNonEmptyLines(value: string | undefined): string[] {
  if (!value) return [];
  return value.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function isWorkspaceRootToken(part: string): boolean {
  return part.startsWith("/") || part.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(part);
}

function normalizeProvisioningEnvironmentLabel(environment: string | undefined): string | undefined {
  const value = environment?.trim();
  if (!value) return undefined;
  return formatEnvironmentDisplayName({ id: value, displayName: value });
}

function formatTimeoutLabel(timeoutMs: number | undefined): string | undefined {
  if (timeoutMs === undefined || timeoutMs < 0) return undefined;
  return `${Math.round(timeoutMs / 1000)}s`;
}

function resolveProvisioningSetupScriptPath(
  scriptPath: string | undefined,
  workspaceRoot: string | undefined,
): string | undefined {
  const normalizedScriptPath = scriptPath?.trim();
  if (!normalizedScriptPath) return undefined;
  if (isWorkspaceRootToken(normalizedScriptPath)) return normalizedScriptPath;
  const normalizedWorkspaceRoot = workspaceRoot?.trim();
  if (!normalizedWorkspaceRoot) return undefined;
  return resolveWorkspaceAbsolutePath(normalizedWorkspaceRoot, normalizedScriptPath);
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

function formatDurationLabel(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function getProvisioningSetupStatus(
  setup: UIProvisioningSetupMetadata | undefined,
): "Failed" | "Completed" | "Running" | undefined {
  if (!setup) {
    return undefined;
  }
  switch (setup.status) {
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
    case "started":
    case "running":
      return "Running";
    default:
      return assertNever(setup.status);
  }
}

export function OperationRow({
  message,
  initialExpanded = false,
}: {
  message: UIOperationMessage;
  initialExpanded?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);
  const shimmeringTitle = renderShimmeringSummary(message.title, shouldShimmerOperationTitle(message));

  if (message.opType === "plan-updated") {
    const detailLines = (message.detail ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    if (detailLines.length === 0) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><div className="rounded-md px-2 py-1 text-sm text-muted-foreground"><div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>{message.title}</div></div></div></div>
      );
    }
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandablePanel isExpanded={isExpanded} summaryContent={message.title} summaryContentClassName={isExpanded ? COLLAPSIBLE_HEADER_TEXT_CLASS : "min-w-0"} headerToneClass={headerToneClass} onToggle={onToggle}>
            <div className="mt-0.5 space-y-0.5">{detailLines.map((line, index) => <div key={`${message.id}:${index}`} className="font-mono ui-text-sm text-foreground/80">{line}</div>)}</div>
          </ExpandablePanel>
        </div>
      </div>
    );
  }

  if (message.opType === "provisioning") {
    const additionalDetailsText = message.detail?.trim() || undefined;
    const additionalDetailLines = splitNonEmptyLines(additionalDetailsText);
    const provisioning = message.provisioning;
    const setupMetadata = message.provisioning?.setup;
    const hasStructuredProvisioningDetails = Boolean(
      provisioning?.environmentDisplayName ||
        provisioning?.workspaceRoot ||
        provisioning?.fallbackReason ||
        setupMetadata,
    );
    const hasDetails =
      hasStructuredProvisioningDetails || Boolean(additionalDetailsText);
    const titleKind = (() => {
      if (message.title.startsWith("Provisioned ")) return "provisioned" as const;
      if (message.title.startsWith("Provisioning ")) return "provisioning" as const;
      switch (message.title) {
        case "Environment setup completed":
          return "setup-completed" as const;
        case "Environment setup failed":
          return "setup-failed" as const;
        default:
          return "setup-running" as const;
      }
    })();
    const isCompleted =
      titleKind === "provisioned" || titleKind === "setup-completed";
    const environmentLabel =
      titleKind === "provisioned"
        ? message.title.slice("Provisioned ".length).trim()
        : titleKind === "provisioning"
          ? message.title.slice("Provisioning ".length).replace(/\.\.\.$/, "").trim()
          : "";
    const setupStatus = getProvisioningSetupStatus(setupMetadata);
    const outputText = setupMetadata?.output?.trim() || undefined;
    const timeoutLabel = formatTimeoutLabel(setupMetadata?.timeoutMs);
    const setupTimedOut = Boolean(timeoutLabel && outputText && /\btimed out\b/i.test(outputText));
    const workspacePath = provisioning?.workspaceRoot;
    const setupScriptPath = resolveProvisioningSetupScriptPath(
      setupMetadata?.scriptPath,
      workspacePath,
    );
    const setupScriptLabel = setupMetadata?.scriptPath ?? setupScriptPath;
    const setupCommand = formatProvisioningSetupCommand(setupMetadata?.scriptPath);
    const setupDurationMs = setupMetadata?.durationMs;
    const setupTimeLabel = setupDurationMs !== undefined
      ? `${formatDurationLabel(setupDurationMs)}${setupTimedOut && timeoutLabel ? ` / timeout ${timeoutLabel}` : ""}`
      : setupTimedOut && timeoutLabel
        ? `timeout ${timeoutLabel}`
        : undefined;
    const environmentValue = normalizeProvisioningEnvironmentLabel(
      provisioning?.environmentDisplayName || environmentLabel || undefined,
    );
    const setupStatusVariant: StatusPillVariant =
      setupStatus === "Failed"
        ? "destructive"
        : setupStatus === "Completed"
        ? "emphasis"
        : "outline";
    const collapsedSummaryContent = titleKind === "provisioned" && environmentLabel ? (
      <span className="inline-flex min-w-0 items-center gap-1.5"><span className="shrink-0 text-muted-foreground/90">Provisioned</span><span className="truncate font-semibold text-foreground/95">{environmentLabel}</span></span>
    ) : shimmeringTitle;
    const expandedSummaryContent =
      titleKind === "provisioned"
        ? "Provisioned"
        : titleKind === "provisioning"
          ? renderShimmeringSummary("Provisioning", true)
          : message.title;

    if (!hasDetails) {
      return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><div className="rounded-md px-2 py-1 text-sm text-muted-foreground"><div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>{collapsedSummaryContent}</div></div></div></div>;
    }

    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandablePanel isExpanded={isExpanded} summaryContent={isExpanded ? expandedSummaryContent : collapsedSummaryContent} summaryContentClassName={isExpanded ? COLLAPSIBLE_HEADER_TEXT_CLASS : "min-w-0"} headerToneClass={headerToneClass} onToggle={onToggle}>
            {hasStructuredProvisioningDetails ? (
              <EventMetaList className="mt-0.5">
                {environmentValue ? <EventMetaItem label="Environment"><span>{environmentValue}</span></EventMetaItem> : null}
                {setupScriptLabel ? <EventMetaItem label="Setup script">{setupScriptPath ? <OpenPathButton path={setupScriptPath} target="file" title={setupScriptLabel}>{setupScriptLabel}</OpenPathButton> : <span className="block truncate text-xs text-muted-foreground/90" title={setupScriptLabel}>{setupScriptLabel}</span>}</EventMetaItem> : null}
                {setupStatus ? <EventMetaItem label="Setup status"><StatusPill variant={setupStatusVariant}>{setupStatus}</StatusPill></EventMetaItem> : null}
                {setupTimeLabel ? <EventMetaItem label="Setup time"><span className="font-mono ui-text-sm text-foreground/85">{setupTimeLabel}</span></EventMetaItem> : null}
                {workspacePath ? <EventMetaItem label="Workspace"><OpenPathButton path={workspacePath} target="directory" title={workspacePath}>{workspacePath}</OpenPathButton></EventMetaItem> : null}
                {outputText ? <EventMetaItem label="Output" align="start"><TerminalOutputBlock command={setupCommand} outputText={outputText} isExpanded={isExpanded} /></EventMetaItem> : null}
                {provisioning?.fallbackReason ? <EventMetaItem label="Fallback reason" align="start"><EventCodeBlock maxHeightClassName={EVENT_DETAIL_MAX_HEIGHT_CLASS}>{provisioning.fallbackReason}</EventCodeBlock></EventMetaItem> : null}
                {additionalDetailsText ? <EventMetaItem label="Additional details" align="start"><EventCodeBlock maxHeightClassName={EVENT_DETAIL_MAX_HEIGHT_CLASS}>{additionalDetailsText}</EventCodeBlock></EventMetaItem> : null}
              </EventMetaList>
            ) : (
              <div className="mt-0.5 space-y-0.5">{additionalDetailLines.map((line, index) => <div key={`${message.id}:${index}`} className="font-mono ui-text-sm text-foreground/80">{line}</div>)}</div>
            )}
          </ExpandablePanel>
        </div>
      </div>
    );
  }

  if (message.opType === "thread-operation-intent") {
    const detailText = message.detail?.trim();
    if (!detailText) return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full rounded-md px-2 py-1 text-sm text-muted-foreground"><div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>{shimmeringTitle}</div></div></div>;
    const promptLabel = "Prompt:\n";
    const promptStart = detailText.indexOf(promptLabel);
    if (promptStart === -1) return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><div className="rounded-md px-2 py-1 text-sm text-muted-foreground"><span className="font-medium text-foreground/80">{shimmeringTitle}</span><span className="ml-2 text-muted-foreground/80">{detailText}</span></div></div></div>;
    const operationDetailText = detailText.slice(0, promptStart).trim();
    const promptText = detailText.slice(promptStart + promptLabel.length).trim();
    if (!promptText) return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><div className="rounded-md px-2 py-1 text-sm text-muted-foreground"><span className="font-medium text-foreground/80">{shimmeringTitle}</span>{operationDetailText ? <span className="ml-2 text-muted-foreground/80">{operationDetailText}</span> : null}</div></div></div>;
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandablePanel isExpanded={isExpanded} summaryContent={shimmeringTitle} summaryContentClassName="min-w-0" headerToneClass={headerToneClass} onToggle={onToggle}>
            <EventCodeBlock className="mt-0.5" maxHeightClassName={EVENT_DETAIL_MAX_HEIGHT_CLASS}>{promptText}</EventCodeBlock>
          </ExpandablePanel>
        </div>
      </div>
    );
  }

  if (message.opType === "worktree-commit") {
    const detailLines = (message.detail ?? "").split("•").map((line) => line.trim()).filter(Boolean);
    const commitHash = detailLines.find((line) => /^[0-9a-f]{7,40}$/i.test(line)) ?? detailLines[detailLines.length - 1];
    const collapsedSummaryContent = message.title === "Committed changes" ? <span className="inline-flex min-w-0 items-center gap-1.5"><span className="shrink-0 text-muted-foreground/90">Committed</span><span className="truncate font-semibold text-foreground/95">changes</span></span> : message.title;
    if (!commitHash) return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><div className="rounded-md px-2 py-1 text-sm text-muted-foreground"><div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>{collapsedSummaryContent}</div></div></div></div>;
    return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><ExpandablePanel isExpanded={isExpanded} summaryContent={collapsedSummaryContent} summaryContentClassName="min-w-0" headerToneClass={headerToneClass} onToggle={onToggle}><div className="mt-0.5"><div className="font-mono ui-text-sm text-foreground/80">{commitHash}</div></div></ExpandablePanel></div></div>;
  }

  if (message.opType === "worktree-squash-merge") {
    const detailLines = (message.detail ?? "").split("•").map((line) => line.trim()).filter(Boolean);
    const mergedBranchMatch = message.detail?.match(/\b(?:into|to)\s+[`'"]?([A-Za-z0-9._/-]+)[`'"]?/i);
    const mergedBranch = mergedBranchMatch?.[1];
    const collapsedSummaryContent = message.title === "Squash merged" && mergedBranch ? <span className="inline-flex min-w-0 items-center gap-1.5"><span className="shrink-0 text-muted-foreground/90">Squash merged into</span><em className="truncate font-semibold text-foreground/95">{mergedBranch}</em></span> : message.title;
    if ((message.title === "Squash merged" && mergedBranch) || detailLines.length === 0) return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><div className="rounded-md px-2 py-1 text-sm text-muted-foreground"><div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>{collapsedSummaryContent}</div></div></div></div>;
    return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><ExpandablePanel isExpanded={isExpanded} summaryContent={collapsedSummaryContent} summaryContentClassName="min-w-0" headerToneClass={headerToneClass} onToggle={onToggle}><div className="mt-0.5 space-y-0.5">{detailLines.map((line, index) => <div key={`${message.id}:${index}`} className="font-mono ui-text-sm text-foreground/80">{line}</div>)}</div></ExpandablePanel></div></div>;
  }

  if (message.opType === "primary-checkout") {
    const detailLines = (message.detail ?? "").split("•").map((line) => line.trim()).filter(Boolean);
    const shouldUseSubtlePrimaryCheckoutTitle = message.title === "Promoted to primary checkout" || message.title === "Demoted from primary checkout" || message.title === "Promoted then demoted as primary checkout";
    const primaryCheckoutTitleClassName = shouldUseSubtlePrimaryCheckoutTitle ? "text-muted-foreground/70" : undefined;
    const primaryCheckoutSummaryContentClassName = primaryCheckoutTitleClassName ? `min-w-0 ${primaryCheckoutTitleClassName}` : "min-w-0";
    const primaryCheckoutStaticTitleClassName = primaryCheckoutTitleClassName ? `py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS} ${primaryCheckoutTitleClassName}` : `py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`;
    if (detailLines.length === 0) return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><div className="rounded-md px-2 py-1 text-sm text-muted-foreground"><div className={primaryCheckoutStaticTitleClassName}>{shimmeringTitle}</div></div></div></div>;
    return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><ExpandablePanel isExpanded={isExpanded} summaryContent={shimmeringTitle} summaryContentClassName={primaryCheckoutSummaryContentClassName} headerToneClass={headerToneClass} onToggle={onToggle}><div className="mt-0.5 space-y-0.5">{detailLines.map((line, index) => <div key={`${message.id}:${index}`} className="font-mono ui-text-sm text-foreground/80">{line}</div>)}</div></ExpandablePanel></div></div>;
  }

  return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><div className="rounded-md px-2 py-1 text-sm text-muted-foreground"><span className="font-medium text-foreground/80">{shimmeringTitle}</span>{message.detail ? <span className="ml-2 text-muted-foreground/80">{message.detail}</span> : null}</div></div></div>;
}
