import { ExpandablePanel, EventCodeBlock, EventMetaItem, EventMetaList } from "@beanbag/ui-core";
import {
  assertNever,
  formatEnvironmentDisplayName,
  type UIOperationMessage,
} from "@beanbag/agent-core";
import { OpenPathButton } from "@/components/shared/OpenPathButton";
import { StatusPill, type StatusPillVariant } from "@/components/shared/StatusPill";
import {
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  COLLAPSIBLE_HEADER_TEXT_CLASS,
  getCollapsibleHeaderToneClass,
} from "@/components/messages/CollapsibleHeader";
import { resolveWorkspaceAbsolutePath } from "@/lib/workspace-path";
import {
  EVENT_DETAIL_MAX_HEIGHT_CLASS,
  renderShimmeringSummary,
  useLatestInitialExpanded,
} from "./shared";

type ThreadOperationIntentPhase = NonNullable<UIOperationMessage["threadOperation"]>["phase"];
type PrimaryCheckoutPhase = NonNullable<UIOperationMessage["primaryCheckout"]>["phase"];

interface ProvisioningSetupAttempt {
  scriptPath?: string;
  workspaceRoot?: string;
  timeout?: string;
  durationMs?: number;
  outputLines: string[];
}

interface ParsedProvisioningDetails {
  environment?: string;
  workspaceRoot?: string;
  setupAttempt?: ProvisioningSetupAttempt;
  additionalLines: string[];
}

function splitNonEmptyLines(value: string | undefined): string[] {
  if (!value) return [];
  return value.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function parseProvisioningDurationMs(part: string): number | undefined {
  const match = part.match(/^Duration\s+(\d+)ms$/i);
  if (!match?.[1]) return undefined;
  const durationMs = Number.parseInt(match[1], 10);
  return Number.isNaN(durationMs) ? undefined : durationMs;
}

function parseProvisioningTimeout(part: string): string | undefined {
  const match = part.match(/^Timeout\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function isWorkspaceRootToken(part: string): boolean {
  return part.startsWith("/") || part.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(part);
}

function parseProvisioningSetupLine(line: string): ProvisioningSetupAttempt | null {
  const parts = line.split("•").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0 || !parts.some((part) => part.includes(".bb-env-setup"))) {
    return null;
  }

  let scriptPath: string | undefined;
  let workspaceRoot: string | undefined;
  let timeout: string | undefined;
  let durationMs: number | undefined;
  const outputLines: string[] = [];

  for (const part of parts) {
    if (!scriptPath && part.includes(".bb-env-setup")) {
      scriptPath = part;
      continue;
    }
    if (!workspaceRoot && isWorkspaceRootToken(part)) {
      workspaceRoot = part;
      continue;
    }
    if (!timeout) {
      const parsedTimeout = parseProvisioningTimeout(part);
      if (parsedTimeout) {
        timeout = parsedTimeout;
        continue;
      }
    }
    if (durationMs === undefined) {
      const parsedDurationMs = parseProvisioningDurationMs(part);
      if (parsedDurationMs !== undefined) {
        durationMs = parsedDurationMs;
        continue;
      }
    }
    outputLines.push(part);
  }

  return { scriptPath, workspaceRoot, timeout, durationMs, outputLines };
}

function isLikelyProvisioningEnvironmentToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && !normalized.startsWith("/") && !normalized.includes(":");
}

function parseProvisioningSummaryLine(
  line: string,
): { environment?: string; workspaceRoot?: string; remainingLine?: string } | null {
  const parts = line.split("•").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  let environment: string | undefined;
  let workspaceRoot: string | undefined;
  const remainingParts: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (!workspaceRoot && isWorkspaceRootToken(part)) {
      workspaceRoot = part;
      continue;
    }
    if (!environment && index === 0 && isLikelyProvisioningEnvironmentToken(part)) {
      environment = part;
      continue;
    }
    remainingParts.push(part);
  }
  if (!environment && !workspaceRoot) return null;
  return {
    environment,
    workspaceRoot,
    remainingLine: remainingParts.length > 0 ? remainingParts.join(" • ") : undefined,
  };
}

function pickBestProvisioningSetupAttempt(
  attempts: ProvisioningSetupAttempt[],
): ProvisioningSetupAttempt | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (!attempt) continue;
    if (attempt.durationMs !== undefined || attempt.outputLines.length > 0) {
      return attempt;
    }
  }
  return attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
}

function parseProvisioningDetails(detail: string | undefined): ParsedProvisioningDetails | null {
  const lines = splitNonEmptyLines(detail);
  if (lines.length === 0) return null;
  let environment: string | undefined;
  let workspaceRoot: string | undefined;
  const attempts: ProvisioningSetupAttempt[] = [];
  let currentAttempt: ProvisioningSetupAttempt | undefined;
  const additionalLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("Environment:")) {
      const nextEnvironment = line.slice("Environment:".length).trim();
      if (nextEnvironment.length > 0) environment = nextEnvironment;
      continue;
    }
    const parsedAttempt = parseProvisioningSetupLine(line);
    if (parsedAttempt) {
      attempts.push(parsedAttempt);
      currentAttempt = parsedAttempt;
      continue;
    }
    if (!currentAttempt) {
      const parsedSummary = parseProvisioningSummaryLine(line);
      if (parsedSummary) {
        if (!environment && parsedSummary.environment) environment = parsedSummary.environment;
        if (!workspaceRoot && parsedSummary.workspaceRoot) workspaceRoot = parsedSummary.workspaceRoot;
        if (parsedSummary.remainingLine) additionalLines.push(parsedSummary.remainingLine);
        continue;
      }
    }
    if (currentAttempt) {
      const parsedSummary = parseProvisioningSummaryLine(line);
      if (parsedSummary) {
        if (!environment && parsedSummary.environment) environment = parsedSummary.environment;
        if (!workspaceRoot && parsedSummary.workspaceRoot) workspaceRoot = parsedSummary.workspaceRoot;
        if (parsedSummary.remainingLine) additionalLines.push(parsedSummary.remainingLine);
        continue;
      }
      if (line.includes("•") && !line.includes(".bb-env-setup")) {
        additionalLines.push(line);
        continue;
      }
      currentAttempt.outputLines.push(line);
      continue;
    }
    additionalLines.push(line);
  }

  const setupAttempt = pickBestProvisioningSetupAttempt(attempts);
  if (!environment && !setupAttempt && additionalLines.length === 0) return null;
  return { environment, workspaceRoot, setupAttempt, additionalLines };
}

function normalizeProvisioningEnvironmentLabel(environment: string | undefined): string | undefined {
  const value = environment?.trim();
  if (!value) return undefined;
  return formatEnvironmentDisplayName({ id: value, displayName: value });
}

function provisioningSetupTimedOut(setupAttempt: ProvisioningSetupAttempt | undefined): boolean {
  if (!setupAttempt?.timeout) return false;
  return setupAttempt.outputLines.some((line) => /\btimed out\b/i.test(line));
}

function resolveProvisioningSetupScriptPath(
  setupAttempt: ProvisioningSetupAttempt | undefined,
): string | undefined {
  const scriptPath = setupAttempt?.scriptPath?.trim();
  if (!scriptPath) return undefined;
  if (isWorkspaceRootToken(scriptPath)) return scriptPath;
  const workspaceRoot = setupAttempt?.workspaceRoot?.trim();
  if (!workspaceRoot) return undefined;
  return resolveWorkspaceAbsolutePath(workspaceRoot, scriptPath);
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
  setupAttempt: ProvisioningSetupAttempt | undefined,
  isProvisioningCompleted: boolean,
): "Failed" | "Completed" | "Running" | undefined {
  if (!setupAttempt) return undefined;
  if (setupAttempt.outputLines.length > 0) return "Failed";
  if (setupAttempt.durationMs !== undefined || isProvisioningCompleted) return "Completed";
  return "Running";
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

function shouldShimmerProvisioningOperation(message: UIOperationMessage): boolean {
  if (message.title.startsWith("Provisioning ")) return true;
  if (message.title.startsWith("Provisioned ")) return false;
  return message.title.endsWith("...");
}

function shouldShimmerThreadOperationIntent(message: UIOperationMessage): boolean {
  if (message.threadOperation) {
    return isShimmeringThreadOperationIntentPhase(message.threadOperation.phase);
  }
  switch (message.title) {
    case "Commit requested":
    case "Commit queued":
    case "Committing changes":
    case "Squash merge requested":
    case "Squash merge queued":
    case "Squash merging changes":
      return true;
    default:
      return false;
  }
}

function shouldShimmerPrimaryCheckoutOperation(message: UIOperationMessage): boolean {
  if (message.primaryCheckout) {
    return isShimmeringPrimaryCheckoutPhase(message.primaryCheckout.phase);
  }
  switch (message.title) {
    case "Promoting primary checkout":
    case "Demoting primary checkout":
      return true;
    default:
      return false;
  }
}

function shouldShimmerOperationTitle(message: UIOperationMessage): boolean {
  switch (message.opType) {
    case "mcp-progress":
      return true;
    case "provisioning":
      return shouldShimmerProvisioningOperation(message);
    case "thread-operation-intent":
      return shouldShimmerThreadOperationIntent(message);
    case "primary-checkout":
      return shouldShimmerPrimaryCheckoutOperation(message);
    default:
      return false;
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
    const parsedDetails = parseProvisioningDetails(message.detail);
    const fallbackDetailLines = splitNonEmptyLines(message.detail);
    const hasParsedDetails = Boolean(parsedDetails);
    const hasDetails = hasParsedDetails || fallbackDetailLines.length > 0;
    const isCompleted = message.title.startsWith("Provisioned ");
    const environmentLabel = isCompleted
      ? message.title.slice("Provisioned ".length).trim()
      : message.title.startsWith("Provisioning ")
        ? message.title.slice("Provisioning ".length).replace(/\.\.\.$/, "").trim()
        : "";
    const actionLabel = isCompleted ? "Provisioned" : "Provisioning";
    const setupAttempt = parsedDetails?.setupAttempt;
    const setupStatus = getProvisioningSetupStatus(setupAttempt, isCompleted);
    const setupTimedOut = provisioningSetupTimedOut(setupAttempt);
    const outputText = setupAttempt?.outputLines.join("\n").trim();
    const additionalDetailsText = parsedDetails?.additionalLines.join("\n").trim();
    const setupScriptPath = resolveProvisioningSetupScriptPath(setupAttempt);
    const setupScriptLabel = setupScriptPath ?? setupAttempt?.scriptPath;
    const workspacePath = setupAttempt?.workspaceRoot ?? parsedDetails?.workspaceRoot;
    const setupTimeLabel = setupAttempt
      ? setupAttempt.durationMs !== undefined
        ? `${formatDurationLabel(setupAttempt.durationMs)}${setupTimedOut && setupAttempt.timeout ? ` / timeout ${setupAttempt.timeout}` : ""}`
        : setupTimedOut && setupAttempt.timeout
          ? `timeout ${setupAttempt.timeout}`
          : undefined
      : undefined;
    const environmentValue = normalizeProvisioningEnvironmentLabel(parsedDetails?.environment || environmentLabel || undefined);
    const setupStatusVariant: StatusPillVariant =
      setupStatus === "Failed"
        ? "destructive"
        : setupStatus === "Completed"
        ? "emphasis"
        : "outline";
    const collapsedSummaryContent = actionLabel === "Provisioned" && environmentLabel ? (
      <span className="inline-flex min-w-0 items-center gap-1.5"><span className="shrink-0 text-muted-foreground/90">Provisioned</span><span className="truncate font-semibold text-foreground/95">{environmentLabel}</span></span>
    ) : shimmeringTitle;
    const expandedSummaryContent = isCompleted ? actionLabel : renderShimmeringSummary(actionLabel, true);

    if (!hasDetails) {
      return <div className="group w-full" style={{ overflowAnchor: "none" }}><div className="mr-auto w-full"><div className="rounded-md px-2 py-1 text-sm text-muted-foreground"><div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>{collapsedSummaryContent}</div></div></div></div>;
    }

    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandablePanel isExpanded={isExpanded} summaryContent={isExpanded ? expandedSummaryContent : collapsedSummaryContent} summaryContentClassName={isExpanded ? COLLAPSIBLE_HEADER_TEXT_CLASS : "min-w-0"} headerToneClass={headerToneClass} onToggle={onToggle}>
            {hasParsedDetails ? (
              <EventMetaList className="mt-0.5">
                {environmentValue ? <EventMetaItem label="Environment"><span>{environmentValue}</span></EventMetaItem> : null}
                {setupScriptLabel ? <EventMetaItem label="Setup script">{setupScriptPath ? <OpenPathButton path={setupScriptPath} target="file" title={setupScriptLabel}>{setupScriptLabel}</OpenPathButton> : <span className="block truncate text-xs text-muted-foreground/90" title={setupScriptLabel}>{setupScriptLabel}</span>}</EventMetaItem> : null}
                {setupStatus ? <EventMetaItem label="Setup status"><StatusPill variant={setupStatusVariant}>{setupStatus}</StatusPill></EventMetaItem> : null}
                {setupTimeLabel ? <EventMetaItem label="Setup time"><span className="font-mono ui-text-sm text-foreground/85">{setupTimeLabel}</span></EventMetaItem> : null}
                {workspacePath ? <EventMetaItem label="Workspace"><OpenPathButton path={workspacePath} target="directory" title={workspacePath}>{workspacePath}</OpenPathButton></EventMetaItem> : null}
                {outputText ? <EventMetaItem label="Output" align="start"><EventCodeBlock maxHeightClassName={EVENT_DETAIL_MAX_HEIGHT_CLASS}>{outputText}</EventCodeBlock></EventMetaItem> : null}
                {additionalDetailsText ? <EventMetaItem label="Additional details" align="start"><EventCodeBlock maxHeightClassName={EVENT_DETAIL_MAX_HEIGHT_CLASS}>{additionalDetailsText}</EventCodeBlock></EventMetaItem> : null}
              </EventMetaList>
            ) : (
              <div className="mt-0.5 space-y-0.5">{fallbackDetailLines.map((line, index) => <div key={`${message.id}:${index}`} className="font-mono ui-text-sm text-foreground/80">{line}</div>)}</div>
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
