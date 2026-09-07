import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { NavLink } from "react-router-dom";
import {
  assertNever,
  buildPendingInteractionApprovalResolution,
  describePendingInteractionToolUse,
  formatPendingInteractionSubjectDetailLines,
  type PendingInteractionToolUseAsk,
} from "@bb/core-ui";
import { extractShellCommandFromString } from "@bb/thread-view";
import {
  isPluginPendingInteraction,
  type ApprovalPendingInteractionPayload,
  type PendingInteraction,
  type PendingInteractionApprovalDecision,
  type PendingInteractionApprovalSubject,
  type PendingInteractionResolution,
  type PendingInteractionUserQuestionQuestion,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { ExpandableLine } from "@/components/ui/expandable-line.js";
import { Icon } from "@bb/shared-ui/icon";
import { MarkdownPreview } from "@/components/ui/markdown-preview.js";
import { getDetailScrollMaxHeightClass } from "@/components/ui/detail-scroll-size.js";
import { UserQuestionAnswerForm } from "@/components/thread/user-questions/UserQuestionInteractionContent.js";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { PluginPendingInteractionComposer } from "@/components/plugin/PluginPendingInteractionComposer";
import { PromptBannerActionButton } from "@/components/promptbox/banner/prompt-banner-actions";
import {
  classifyInteractionRequest,
  type InteractionRequestView,
} from "./interaction-request";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import {
  presentationIconName,
  presentationTintStyle,
} from "@/components/thread/timeline/presentation-display";
import { PluginCompactIconMask } from "@/components/plugin/PluginIcon";
import { usePluginIconUrl } from "@/lib/plugin-logos";
import { cn } from "@bb/shared-ui/lib/utils";

interface ThreadPendingInteractionSourceThread {
  href: string;
  title: string;
}

interface ThreadPendingInteractionBannerProps {
  interaction: PendingInteraction;
  sourceThread?: ThreadPendingInteractionSourceThread;
  threadId: string;
}

type ApprovalBannerSubject = Extract<
  InteractionRequestView,
  { family: "approval" }
>["subject"];

interface ApprovalPendingInteractionBannerProps {
  interaction: PendingInteraction;
  payload: ApprovalPendingInteractionPayload;
  subject: ApprovalBannerSubject;
  sourceThread?: ThreadPendingInteractionSourceThread;
  threadId: string;
}

interface UserQuestionPendingInteractionBannerProps {
  interaction: PendingInteraction;
  questions: readonly PendingInteractionUserQuestionQuestion[];
  sourceThread?: ThreadPendingInteractionSourceThread;
  threadId: string;
}

interface BannerShellProps {
  label: string;
  title?: string;
  summary?: string | null;
  initiallyExpanded: boolean;
  errorMessage?: string | null;
  footer?: (layout: BannerLayout) => ReactNode;
  children?: (isExpanded: boolean) => ReactNode;
  sourceThread?: ThreadPendingInteractionSourceThread;
  testId: string;
}

type BannerLayout = "strip" | "card";

interface ApprovalSubject {
  title: string;
  summary: string | null;
  body: ReactNode;
}

const COMMAND_PREVIEW_LINE_COUNT = 4;
const APPROVAL_DECISION_ORDER: Record<
  PendingInteractionApprovalDecision,
  number
> = { deny: 0, allow_for_session: 1, allow_once: 2 };

interface BuildApprovalSubjectInput {
  interaction: PendingInteraction;
  payload: ApprovalPendingInteractionPayload;
  subject: ApprovalBannerSubject;
}

export function ThreadPendingInteractionBanner(
  props: ThreadPendingInteractionBannerProps,
) {
  return <PendingInteractionBanner key={props.interaction.id} {...props} />;
}

function PendingInteractionBanner({
  interaction,
  sourceThread,
  threadId,
}: ThreadPendingInteractionBannerProps) {
  const request = classifyInteractionRequest(interaction);
  if (request.family === "approval") {
    return (
      <ApprovalPendingInteractionBanner
        interaction={interaction}
        payload={request.payload}
        subject={request.subject}
        sourceThread={sourceThread}
        threadId={threadId}
      />
    );
  }
  switch (request.kind) {
    case "user_question":
      return (
        <ThreadUserQuestionPendingInteractionBanner
          interaction={interaction}
          questions={request.questions}
          sourceThread={sourceThread}
          threadId={threadId}
        />
      );
    case "plan_review":
      return (
        <PlanReviewRequestBanner
          interaction={interaction}
          request={request}
          sourceThread={sourceThread}
          threadId={threadId}
        />
      );
    default:
      return (
        <div
          data-testid="plugin-request-banner"
          data-request-kind={request.kind}
        >
          {sourceThread ? (
            <NavLink
              to={sourceThread.href}
              className="mb-1 block text-xs text-muted-foreground no-underline hover:underline"
            >
              From child thread: {sourceThread.title}
            </NavLink>
          ) : null}
          <PluginPendingInteractionComposer
            interaction={interaction}
            request={{
              pluginId: request.pluginId,
              rendererId: request.name,
              title: request.title,
              data: request.data,
            }}
            dismissal={
              isPluginPendingInteraction(interaction) ? "cancel" : "stop-turn"
            }
          />
        </div>
      );
  }
}

interface PlanReviewRequestBannerProps {
  interaction: PendingInteraction;
  request: Extract<InteractionRequestView, { kind: "plan_review" }>;
  sourceThread?: ThreadPendingInteractionSourceThread;
  threadId: string;
}

function PlanReviewRequestBanner({
  interaction,
  request,
  sourceThread,
  threadId,
}: PlanReviewRequestBannerProps) {
  const resolvePendingInteraction = useResolveThreadPendingInteraction();
  const isResolving = interaction.status === "resolving";
  const submittedDecision = approvalResolutionDecision(interaction.resolution);
  const mutationErrorMessage = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Failed to resolve plan review",
        lifecycleOperation: "resolve_interaction",
      })
    : null;
  const submitDisabled = resolvePendingInteraction.isPending || isResolving;
  const { approval } = request;
  const submitDecision = (
    decision: PendingInteractionApprovalDecision,
  ): void => {
    const resolution = buildPendingInteractionApprovalResolution(
      interaction,
      decision,
    );
    void resolvePendingInteraction
      .mutateAsync({ threadId, interactionId: interaction.id, resolution })
      .catch(() => {});
  };
  const { plan, planFilePath } = request.review;
  return (
    <BannerShell
      label="Plan review"
      title={approval.reason ?? "Ready to code?"}
      summary={planFilePath ?? firstLine(plan)}
      initiallyExpanded={false}
      errorMessage={mutationErrorMessage}
      sourceThread={sourceThread}
      testId="plan-review-banner"
      footer={(layout) => (
        <ApprovalDecisionButtons
          decisions={approval.availableDecisions}
          disabled={submitDisabled}
          layout={layout}
          loadingDecision={isResolving ? submittedDecision : null}
          onDecide={submitDecision}
          subjectKind="plan"
        />
      )}
    >
      {() => (
        <div
          className="overflow-hidden rounded-lg border border-border bg-card"
          data-testid="plan-review-request"
        >
          <div
            className={cn(
              getDetailScrollMaxHeightClass("base"),
              "overflow-auto px-3 py-2",
            )}
          >
            <MarkdownPreview content={plan} className="text-xs" />
          </div>
          {planFilePath ? (
            <p className="truncate border-t border-border px-3 py-2 font-mono text-xs text-muted-foreground">
              {planFilePath}
            </p>
          ) : null}
        </div>
      )}
    </BannerShell>
  );
}

function BannerShell({
  label,
  title,
  summary,
  initiallyExpanded,
  errorMessage,
  footer,
  children,
  sourceThread,
  testId,
}: BannerShellProps) {
  const [isExpanded, setIsExpanded] = useState(initiallyExpanded);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const shouldRestoreToggleFocusRef = useRef(false);
  const collapsesOnEscape = !initiallyExpanded;
  useLayoutEffect(() => {
    if (!shouldRestoreToggleFocusRef.current) return;
    shouldRestoreToggleFocusRef.current = false;
    toggleRef.current?.focus();
  }, [isExpanded]);
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key === "Escape" &&
      isExpanded &&
      collapsesOnEscape &&
      !event.defaultPrevented
    ) {
      event.preventDefault();
      event.stopPropagation();
      shouldRestoreToggleFocusRef.current = true;
      setIsExpanded(false);
    }
  };
  const toggle = (
    <button
      ref={toggleRef}
      type="button"
      aria-expanded={isExpanded}
      aria-label={isExpanded ? "Hide details" : "Show details"}
      onClick={(event) => {
        shouldRestoreToggleFocusRef.current =
          document.activeElement === event.currentTarget;
        setIsExpanded((value) => !value);
      }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon
        name="ChevronDown"
        className={cn(
          "size-3.5 transition-transform duration-200",
          isExpanded ? "rotate-180" : undefined,
        )}
      />
    </button>
  );
  const errorNode = errorMessage ? (
    <div className="mx-3 mb-3 rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text">
      {errorMessage}
    </div>
  ) : null;
  const sourceThreadLink = sourceThread ? (
    <NavLink
      to={sourceThread.href}
      title={sourceThread.title}
      className="min-w-24 shrink-[3] truncate text-xs text-subtle-foreground no-underline hover:underline"
    >
      From {sourceThread.title}
    </NavLink>
  ) : null;

  return (
    <section
      aria-label={label}
      data-testid={testId}
      data-expanded={isExpanded ? "" : undefined}
      onKeyDown={handleKeyDown}
      className="@container mb-2 min-w-0 max-w-full rounded-lg border border-attention/40 bg-surface-raised-solid text-xs text-muted-foreground ring-[3px] ring-surface-attention"
    >
      {isExpanded ? (
        <div className="flex items-center gap-2 border-b border-border-hairline py-1.5 pl-3 pr-1.5">
          <AttentionDot />
          <span className="shrink-0 text-sm font-semibold text-foreground">
            {label}
          </span>
          {sourceThreadLink}
          <span className="flex-1" />
          {toggle}
        </div>
      ) : (
        <div className="flex min-h-9 flex-wrap items-center gap-2 py-1 pl-3 pr-1.5 @2xl:flex-nowrap">
          <AttentionDot />
          <span
            className="min-w-24 shrink truncate text-sm font-medium text-foreground"
            title={title ?? label}
          >
            {title ?? label}
          </span>
          {summary ? (
            <span
              className="min-w-20 shrink-[2] truncate font-mono text-xs text-muted-foreground"
              title={summary}
            >
              {summary}
            </span>
          ) : null}
          {sourceThreadLink}
          <span className="flex-1" />
          {footer ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {footer("strip")}
            </div>
          ) : null}
          {toggle}
        </div>
      )}
      <div hidden={!isExpanded} className="px-3 pb-3 pt-2.5">
        {title ? (
          <h3 className="min-w-0 text-sm font-medium text-foreground">
            <ExpandableLine fullText={title} collapsedClassName="line-clamp-2">
              {title}
            </ExpandableLine>
          </h3>
        ) : null}
        {children ? (
          <div className={title ? "mt-2" : undefined}>
            {children(isExpanded)}
          </div>
        ) : null}
        {footer ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {footer("card")}
          </div>
        ) : null}
      </div>
      {errorNode}
    </section>
  );
}

function AttentionDot() {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full bg-attention ring-[3px] ring-surface-attention"
    />
  );
}

function unwrapBacktickedCommand(command: string): string {
  const trimmed = command.trim();
  return trimmed.length > 2 &&
    trimmed.startsWith("`") &&
    trimmed.endsWith("`") &&
    !trimmed.slice(1, -1).includes("`")
    ? trimmed.slice(1, -1)
    : command;
}

function firstLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return line ?? null;
}

function ApprovalPendingInteractionBanner({
  interaction,
  payload,
  subject,
  sourceThread,
  threadId,
}: ApprovalPendingInteractionBannerProps) {
  const resolvePendingInteraction = useResolveThreadPendingInteraction();
  const isResolving = interaction.status === "resolving";
  const submittedDecision = approvalResolutionDecision(interaction.resolution);
  const view = useMemo(
    () => buildApprovalSubject({ interaction, payload, subject }),
    [interaction, payload, subject],
  );
  const mutationErrorMessage = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Failed to resolve pending interaction",
        lifecycleOperation: "resolve_interaction",
      })
    : null;
  const submitDisabled = resolvePendingInteraction.isPending || isResolving;

  const submitDecision = (
    decision: PendingInteractionApprovalDecision,
  ): void => {
    const resolution = buildPendingInteractionApprovalResolution(
      interaction,
      decision,
    );
    void resolvePendingInteraction
      .mutateAsync({
        threadId,
        interactionId: interaction.id,
        resolution,
      })
      .catch(() => {});
  };

  return (
    <BannerShell
      label="Approval needed"
      title={view.title}
      summary={view.summary}
      initiallyExpanded={false}
      errorMessage={mutationErrorMessage}
      sourceThread={sourceThread}
      testId="approval-banner"
      footer={(layout) => (
        <ApprovalDecisionButtons
          decisions={payload.availableDecisions}
          disabled={submitDisabled}
          layout={layout}
          loadingDecision={isResolving ? submittedDecision : null}
          onDecide={submitDecision}
          subjectKind={subject.kind}
        />
      )}
    >
      {() => view.body}
    </BannerShell>
  );
}

function ThreadUserQuestionPendingInteractionBanner({
  interaction,
  questions,
  sourceThread,
  threadId,
}: UserQuestionPendingInteractionBannerProps) {
  const isResolving = interaction.status === "resolving";

  return (
    <BannerShell
      label={
        questions.length === 1 ? "Question" : `${questions.length} questions`
      }
      summary={questions[0]?.prompt ?? null}
      initiallyExpanded
      sourceThread={sourceThread}
      testId="user-question-banner"
    >
      {(isExpanded) => (
        <UserQuestionAnswerForm
          interactionId={interaction.id}
          isResolving={isResolving}
          questions={questions}
          shortcutsEnabled={isExpanded}
          threadId={threadId}
        />
      )}
    </BannerShell>
  );
}

interface ApprovalDecisionButtonsProps {
  decisions: readonly PendingInteractionApprovalDecision[];
  disabled: boolean;
  layout: BannerLayout;
  loadingDecision: PendingInteractionApprovalDecision | null;
  onDecide: (decision: PendingInteractionApprovalDecision) => void;
  subjectKind: PendingInteractionApprovalSubject["kind"];
}

function ApprovalDecisionButtons({
  decisions,
  disabled,
  layout,
  loadingDecision,
  onDecide,
  subjectKind,
}: ApprovalDecisionButtonsProps) {
  const denyFirst = [...decisions].sort(
    (left, right) =>
      APPROVAL_DECISION_ORDER[left] - APPROVAL_DECISION_ORDER[right],
  );
  return denyFirst.map((decision, index) => (
    <ApprovalDecisionButton
      key={decision}
      decision={decision}
      disabled={disabled}
      isLoading={loadingDecision === decision}
      layout={layout}
      onClick={() => onDecide(decision)}
      subjectKind={subjectKind}
      className={
        layout === "card" && index === 0 && decision === "deny"
          ? "mr-auto"
          : undefined
      }
    />
  ));
}

interface ApprovalDecisionButtonProps {
  className?: string;
  layout: BannerLayout;
  decision: PendingInteractionApprovalDecision;
  disabled: boolean;
  isLoading: boolean;
  onClick: () => void;
  subjectKind: PendingInteractionApprovalSubject["kind"];
}

function ApprovalDecisionButton({
  className,
  decision,
  disabled,
  isLoading,
  layout,
  onClick,
  subjectKind,
}: ApprovalDecisionButtonProps) {
  const label = labelForApprovalDecision(decision, subjectKind);
  const spinner = isLoading ? (
    <Icon name="Spinner" className="size-3 animate-spin" />
  ) : null;
  if (layout === "strip") {
    return (
      <PromptBannerActionButton
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "gap-1",
          compactApprovalDecisionButtonClass(decision),
          className,
        )}
      >
        {spinner}
        {label}
      </PromptBannerActionButton>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant={approvalDecisionButtonVariant(decision)}
      disabled={disabled}
      onClick={onClick}
      className={className}
    >
      {spinner}
      {label}
    </Button>
  );
}

function compactApprovalDecisionButtonClass(
  decision: PendingInteractionApprovalDecision,
): string | undefined {
  switch (decision) {
    case "allow_once":
      return "border-foreground bg-foreground text-background hover:bg-foreground/90 hover:text-background";
    case "allow_for_session":
      return undefined;
    case "deny":
      return "border-transparent bg-transparent shadow-none";
  }
}

function approvalDecisionButtonVariant(
  decision: PendingInteractionApprovalDecision,
): "default" | "outline" | "ghost" {
  switch (decision) {
    case "allow_once":
      return "default";
    case "allow_for_session":
      return "outline";
    case "deny":
      return "ghost";
  }
}

function approvalResolutionDecision(
  resolution: PendingInteractionResolution | null,
): PendingInteractionApprovalDecision | null {
  if (!resolution || "kind" in resolution) {
    return null;
  }
  return resolution.decision;
}

function ApprovalDetailList({
  className,
  lines,
}: {
  className: string;
  lines: readonly string[];
}) {
  return (
    <ul
      className={cn(
        "min-w-0 max-w-full text-xs text-muted-foreground [overflow-wrap:anywhere]",
        className,
      )}
    >
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function ToolUseAskCard({ ask }: { ask: PendingInteractionToolUseAsk }) {
  const iconUrl = usePluginIconUrl(ask.icon.glyph);
  return (
    <div
      className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card px-3 py-2"
      data-testid="tool-use-ask"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-foreground">
        {iconUrl !== undefined ? (
          <PluginCompactIconMask
            url={iconUrl}
            className="size-3.5"
            style={presentationTintStyle(ask)}
          />
        ) : (
          <Icon
            name={presentationIconName(ask) ?? "Terminal"}
            className="size-3.5 shrink-0"
            style={presentationTintStyle(ask)}
          />
        )}
        <span className="min-w-0 truncate font-mono">
          {ask.headline ?? ask.tool}
        </span>
      </div>
      {ask.headline !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">Tool: {ask.tool}</p>
      ) : null}
      {ask.detail !== null ? (
        <MarkdownPreview
          content={ask.detail}
          className="mt-1 text-xs text-muted-foreground"
          imagePolicy="alt-text"
        />
      ) : null}
    </div>
  );
}

function CommandPreview({
  command,
  detailLines,
}: {
  command: string;
  detailLines: readonly string[];
}) {
  const [showsAllLines, setShowsAllLines] = useState(false);
  const lines = command.split("\n");
  const hiddenLineCount = Math.max(
    0,
    lines.length - COMMAND_PREVIEW_LINE_COUNT,
  );
  const visibleCommand =
    showsAllLines || hiddenLineCount === 0
      ? command
      : lines.slice(0, COMMAND_PREVIEW_LINE_COUNT).join("\n");
  return (
    <div
      className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card"
      data-testid="command-preview"
    >
      <pre
        className={cn(
          getDetailScrollMaxHeightClass("base"),
          "max-w-full overflow-auto whitespace-pre px-3 py-2 font-mono text-xs leading-relaxed text-foreground",
        )}
      >
        $ {visibleCommand}
      </pre>
      {hiddenLineCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowsAllLines((value) => !value)}
          className="block w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          {showsAllLines
            ? "Show less"
            : hiddenLineCount === 1
              ? "Show 1 more line"
              : `Show ${hiddenLineCount} more lines`}
        </button>
      ) : null}
      {detailLines.length > 0 ? (
        <ApprovalDetailList
          className="border-t border-border px-3 py-2"
          lines={detailLines}
        />
      ) : null}
    </div>
  );
}

function buildApprovalSubject({
  interaction,
  payload,
  subject,
}: BuildApprovalSubjectInput): ApprovalSubject {
  switch (subject.kind) {
    case "command": {
      const rawCommand = subject.command;
      const command = rawCommand
        ? unwrapBacktickedCommand(
            extractShellCommandFromString(rawCommand) ?? rawCommand,
          )
        : null;
      const detailLines = formatPendingInteractionSubjectDetailLines(
        interaction,
      )
        .filter(
          (line) =>
            !line.startsWith("Command: ") &&
            line !== `Action: ${rawCommand}` &&
            line !== `Action: ${command}`,
        )
        .map((line) =>
          line.startsWith("Cwd: ") ? line.slice("Cwd: ".length) : line,
        );
      return {
        title: payload.reason ?? "Do you want to run this command?",
        summary: command ? firstLine(command) : null,
        body: command ? (
          <CommandPreview command={command} detailLines={detailLines} />
        ) : null,
      };
    }
    case "file_change": {
      const detailLines =
        formatPendingInteractionSubjectDetailLines(interaction);
      return {
        title: payload.reason ?? "Do you want to make these changes?",
        summary: subject.writeScope,
        body:
          detailLines.length > 0 ? (
            <ApprovalDetailList
              className="rounded-lg border border-border bg-card px-3 py-2"
              lines={detailLines}
            />
          ) : null,
      };
    }
    case "permission_grant": {
      const detailLines =
        formatPendingInteractionSubjectDetailLines(interaction);
      return {
        title: payload.reason ?? "Do you want to grant this permission?",
        summary: subject.toolName ?? detailLines[0] ?? null,
        body:
          detailLines.length > 0 ? (
            <ApprovalDetailList
              className="rounded-lg border border-border bg-card px-3 py-2"
              lines={detailLines}
            />
          ) : null,
      };
    }
    case "tool_use": {
      const ask = describePendingInteractionToolUse({ ...payload, subject });
      return {
        title: ask.title,
        summary: ask.headline ?? ask.tool,
        body: <ToolUseAskCard ask={ask} />,
      };
    }
    default:
      return assertNever(subject);
  }
}

function labelForApprovalDecision(
  decision: PendingInteractionApprovalDecision,
  subjectKind: PendingInteractionApprovalSubject["kind"],
): string {
  if (subjectKind === "plan") {
    return decision === "deny" ? "Keep planning" : "Approve plan";
  }
  switch (decision) {
    case "allow_once":
      return "Allow once";
    case "allow_for_session":
      return "Allow for session";
    case "deny":
      return "Deny";
  }
}
