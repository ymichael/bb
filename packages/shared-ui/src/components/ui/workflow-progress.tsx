import { useEffect, useRef, useState } from "react";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "./activity-row-styles";
import { Icon } from "./icon";
import { cn } from "../../lib/utils";

export type WorkflowProgressAgentState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

export interface WorkflowProgressAgent {
  id?: string;
  actionable?: boolean;
  index: number;
  label: string;
  state: WorkflowProgressAgentState;
  model: string;
  attempt: number;
  cached: boolean;
  lastProgressAt: number;
  phaseIndex?: number;
  agentType?: string;
  error?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  metadata?: readonly string[];
}

export interface WorkflowProgressPhase {
  index: number;
  title: string;
}

export interface WorkflowProgressSnapshot {
  phases: readonly WorkflowProgressPhase[];
  agents: readonly WorkflowProgressAgent[];
}

type WorkflowAgentDisplayState = WorkflowProgressAgentState | "interrupted";

interface WorkflowPhaseGroup {
  agents: WorkflowProgressAgent[];
  phase: WorkflowProgressPhase | null;
}

const ACTIVE_PHASE_SCROLL_OFFSET = 12;
const PROMPT_STACK_ACTIVE_ROW_CLASS = "shadow-none ring-0";
const PROMPT_STACK_ACTIVE_ICON_CLASS = "text-foreground";
const PROMPT_STACK_ACTIVE_TEXT_CLASS = "font-medium text-foreground";

function isSettledAgentState(state: WorkflowProgressAgentState): boolean {
  return (
    state === "done" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled"
  );
}

function deriveAgentDisplayState(
  agent: WorkflowProgressAgent,
  workflowSettled: boolean,
): WorkflowAgentDisplayState {
  if (workflowSettled && !isSettledAgentState(agent.state)) {
    return "interrupted";
  }
  return agent.state;
}

function WorkflowAgentStateIcon({
  state,
  className: overrideClassName,
}: {
  state: WorkflowAgentDisplayState;
  className?: string;
}) {
  const baseClassName = "size-3.5 shrink-0";
  switch (state) {
    case "done":
      return (
        <Icon
          name="Check"
          className={cn(
            baseClassName,
            "text-muted-foreground/60",
            overrideClassName,
          )}
          aria-hidden="true"
        />
      );
    case "failed":
      return (
        <Icon
          name="X"
          className={cn(
            baseClassName,
            "text-destructive/80",
            overrideClassName,
          )}
          aria-hidden="true"
        />
      );
    case "skipped":
      return (
        <Icon
          name="X"
          className={cn(
            baseClassName,
            "text-muted-foreground/45",
            overrideClassName,
          )}
          aria-hidden="true"
        />
      );
    case "cancelled":
      return (
        <Icon
          name="Pause"
          className={cn(
            baseClassName,
            "text-muted-foreground/45",
            overrideClassName,
          )}
          aria-hidden="true"
        />
      );
    case "running":
      return (
        <Icon
          name="Spinner"
          className={cn(
            baseClassName,
            "animate-spin text-foreground",
            overrideClassName,
          )}
          aria-hidden="true"
        />
      );
    case "queued":
    case "interrupted":
      return (
        <Icon
          name="Circle"
          className={cn(
            baseClassName,
            "text-muted-foreground/45",
            overrideClassName,
          )}
          aria-hidden="true"
        />
      );
  }
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${tokens}`;
}

function formatCompactDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function shortModelName(model: string): string {
  const match = /^claude-([a-z]+)/.exec(model);
  return match?.[1] ?? model;
}

interface WorkflowAgentStats {
  meta: string;
  duration: string | null;
}

function buildAgentStats(
  agent: WorkflowProgressAgent,
  displayState: WorkflowAgentDisplayState,
): WorkflowAgentStats {
  const parts =
    agent.metadata === undefined
      ? [agent.agentType, shortModelName(agent.model)].filter(
          (part): part is string => part !== undefined,
        )
      : [...agent.metadata];
  if (agent.tokens !== undefined && agent.tokens > 0) {
    parts.push(`${formatCompactTokens(agent.tokens)} tok`);
  }
  if (agent.toolCalls !== undefined && agent.toolCalls > 0) {
    parts.push(
      `${agent.toolCalls} ${agent.toolCalls === 1 ? "tool" : "tools"}`,
    );
  }
  if (agent.attempt > 1) parts.push(`attempt ${agent.attempt}`);
  if (agent.cached) parts.push("cached");
  if (displayState === "queued") parts.push("queued");
  if (displayState === "interrupted") parts.push("stopped");
  if (displayState === "cancelled") parts.push("cancelled");
  return {
    meta: parts.join(" · "),
    duration:
      agent.durationMs === undefined
        ? null
        : formatCompactDuration(agent.durationMs),
  };
}

function activityStateForAgent(
  displayState: WorkflowAgentDisplayState,
): ActivityRowState {
  switch (displayState) {
    case "running":
      return "active";
    case "done":
    case "skipped":
      return "completed";
    case "cancelled":
      return "muted";
    case "failed":
      return "failed";
    case "queued":
      return "pending";
    case "interrupted":
      return "muted";
  }
}

function promptStackActivityRowClass(
  state: ActivityRowState,
  className?: string,
): string {
  return activityRowClass(
    state,
    cn(state === "active" && PROMPT_STACK_ACTIVE_ROW_CLASS, className),
  );
}

function promptStackActivityIconClass(
  state: ActivityRowState,
  className?: string,
): string {
  if (state === "active") {
    return cn(PROMPT_STACK_ACTIVE_ICON_CLASS, className);
  }
  return activityIconClass(state, className);
}

function promptStackActivityTextClass(
  state: ActivityRowState,
  className?: string,
): string {
  if (state === "active") {
    return cn(PROMPT_STACK_ACTIVE_TEXT_CLASS, className);
  }
  return activityTextClass(state, className);
}

function WorkflowAgentLine({
  agent,
  onActivate,
  promptStack = false,
  workflowSettled,
}: {
  agent: WorkflowProgressAgent;
  onActivate?: () => void;
  promptStack?: boolean;
  workflowSettled: boolean;
}) {
  const displayState = deriveAgentDisplayState(agent, workflowSettled);
  const activityState = activityStateForAgent(displayState);
  const stats = buildAgentStats(agent, displayState);
  const content = (
    <>
      <WorkflowAgentStateIcon
        state={displayState}
        className={
          promptStack
            ? displayState === "running"
              ? undefined
              : promptStackActivityIconClass(activityState)
            : undefined
        }
      />
      <span
        className={
          promptStack
            ? promptStackActivityTextClass(
                activityState,
                "min-w-0 truncate text-xs no-underline",
              )
            : cn(
                "min-w-0 truncate text-xs",
                displayState === "running"
                  ? "text-foreground"
                  : "text-muted-foreground",
              )
        }
        title={agent.label}
      >
        {agent.label}
      </span>
      {displayState === "failed" && agent.error ? (
        <span className="min-w-0 truncate text-xs text-destructive/80">
          — {agent.error}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-baseline gap-2">
        {stats.meta === "" ? null : (
          <span
            className="whitespace-nowrap font-mono text-2xs text-subtle-foreground/80"
            title={stats.meta}
          >
            {stats.meta}
          </span>
        )}
        {stats.duration === null ? null : (
          <span className="min-w-9 whitespace-nowrap text-right text-xs tabular-nums text-subtle-foreground">
            {stats.duration}
          </span>
        )}
      </span>
    </>
  );
  const className = promptStack
    ? promptStackActivityRowClass(
        activityState,
        cn(
          "flex min-h-7 w-full min-w-0 items-center gap-2 text-left text-xs",
          onActivate && "cursor-pointer hover:bg-state-hover",
        ),
      )
    : cn(
        "flex min-w-0 items-center gap-2 px-2 py-0.5 text-left",
        onActivate && "w-full cursor-pointer rounded hover:bg-state-hover",
      );
  return onActivate ? (
    <button type="button" className={className} onClick={onActivate}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function groupAgentsByPhase(
  phases: readonly WorkflowProgressPhase[],
  agents: readonly WorkflowProgressAgent[],
): WorkflowPhaseGroup[] {
  const groups: WorkflowPhaseGroup[] = [];
  const byIndex = new Map<number, WorkflowPhaseGroup>();
  for (const phase of phases) {
    const group: WorkflowPhaseGroup = { phase, agents: [] };
    groups.push(group);
    byIndex.set(phase.index, group);
  }
  const unphased: WorkflowProgressAgent[] = [];
  for (const agent of agents) {
    const group =
      agent.phaseIndex !== undefined ? byIndex.get(agent.phaseIndex) : null;
    if (group) group.agents.push(agent);
    else unphased.push(agent);
  }
  if (unphased.length > 0) groups.push({ phase: null, agents: unphased });
  return groups;
}

function phaseProgressLabel(agents: readonly WorkflowProgressAgent[]): string {
  if (agents.length === 0) return "not started";
  const settled = agents.filter((agent) =>
    isSettledAgentState(agent.state),
  ).length;
  return `${settled}/${agents.length}`;
}

function groupKey(group: WorkflowPhaseGroup): string {
  return group.phase ? `phase-${group.phase.index}` : "unphased";
}

function activePhaseKey(
  groups: readonly WorkflowPhaseGroup[],
  currentPhaseIndex?: number,
): string | null {
  if (currentPhaseIndex !== undefined) {
    const current = groups.find(
      (group) => group.phase?.index === currentPhaseIndex,
    );
    if (current) return groupKey(current);
  }
  const running = groups.find((group) =>
    group.agents.some((agent) => agent.state === "running"),
  );
  if (running) return groupKey(running);
  const inFlight = groups.find(
    (group) =>
      group.agents.length > 0 &&
      !group.agents.every((agent) => isSettledAgentState(agent.state)),
  );
  if (inFlight) return groupKey(inFlight);
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group && group.agents.length > 0) return groupKey(group);
  }
  return null;
}

function activityStateForPhase({
  group,
  isActive,
  terminalState,
  workflowSettled,
}: {
  group: WorkflowPhaseGroup;
  isActive: boolean;
  terminalState?: "completed" | "failed" | "cancelled";
  workflowSettled: boolean;
}): ActivityRowState {
  if (isActive && !workflowSettled) return "active";
  if (group.agents.some((agent) => agent.state === "failed")) return "failed";
  if (isActive && workflowSettled && terminalState !== undefined) {
    if (terminalState === "completed") return "completed";
    if (terminalState === "failed") return "failed";
    return "muted";
  }
  if (group.agents.some((agent) => agent.state === "cancelled")) {
    return "muted";
  }
  if (
    group.agents.length > 0 &&
    group.agents.every((agent) => isSettledAgentState(agent.state))
  ) {
    return "completed";
  }
  if (group.agents.length === 0) return "muted";
  return "pending";
}

function PhaseCompletedBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <Icon
      name="CircleCheck"
      className="ml-auto size-3.5 shrink-0 text-success/70"
      aria-hidden="true"
    />
  );
}

function isPhaseCompleted(group: WorkflowPhaseGroup): boolean {
  return (
    group.agents.length > 0 &&
    group.agents.every((agent) => agent.state === "done")
  );
}

function StaticPhaseGroup({
  group,
  onAgentActivate,
  workflowSettled,
}: {
  group: WorkflowPhaseGroup;
  onAgentActivate?: (agent: WorkflowProgressAgent) => void;
  workflowSettled: boolean;
}) {
  const agentLines = group.agents.map((agent) => (
    <WorkflowAgentLine
      key={agent.id ?? agent.index}
      agent={agent}
      onActivate={
        onAgentActivate === undefined || !agent.actionable
          ? undefined
          : () => onAgentActivate(agent)
      }
      workflowSettled={workflowSettled}
    />
  ));
  if (!group.phase) return <div>{agentLines}</div>;
  const completed = isPhaseCompleted(group);
  return (
    <div>
      <div className="flex items-center gap-2 px-2 py-0.5">
        <span
          className={cn(
            "text-xs font-medium",
            completed ? "text-subtle-foreground" : "text-foreground",
          )}
        >
          {group.phase.title}
        </span>
        <span className="text-xs tabular-nums text-subtle-foreground">
          {phaseProgressLabel(group.agents)}
        </span>
        <PhaseCompletedBadge visible={completed} />
      </div>
      {agentLines}
    </div>
  );
}

function CollapsiblePhaseSection({
  group,
  expanded,
  isActive,
  onAgentActivate,
  onToggle,
  terminalState,
  workflowSettled,
}: {
  group: WorkflowPhaseGroup;
  expanded: boolean;
  isActive: boolean;
  onAgentActivate?: (agent: WorkflowProgressAgent) => void;
  onToggle: () => void;
  terminalState?: "completed" | "failed" | "cancelled";
  workflowSettled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isActive) return;
    const element = ref.current;
    const scroller = element?.closest("[data-detail-scroll-area]");
    if (element && scroller instanceof HTMLElement) {
      scroller.scrollTop +=
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        ACTIVE_PHASE_SCROLL_OFFSET;
    }
  }, [isActive]);

  const agentLines = group.agents.map((agent) => (
    <WorkflowAgentLine
      key={agent.id ?? agent.index}
      agent={agent}
      onActivate={
        onAgentActivate === undefined || !agent.actionable
          ? undefined
          : () => onAgentActivate(agent)
      }
      promptStack
      workflowSettled={workflowSettled}
    />
  ));
  if (!group.phase) {
    return (
      <div ref={ref} className="flex min-w-0 flex-col">
        {agentLines}
      </div>
    );
  }

  const progress = phaseProgressLabel(group.agents);
  const activityState = activityStateForPhase({
    group,
    isActive,
    terminalState,
    workflowSettled,
  });
  if (group.agents.length === 0) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center gap-1.5",
          promptStackActivityRowClass(activityState),
        )}
      >
        <span className="size-3 shrink-0" aria-hidden="true" />
        <span
          className={promptStackActivityTextClass(
            activityState,
            "text-xs font-medium no-underline",
          )}
        >
          {group.phase.title}
        </span>
        <span
          className={cn(
            "text-xs tabular-nums",
            activityMetaClass(activityState),
          )}
        >
          {progress}
        </span>
        <PhaseCompletedBadge visible={activityState === "completed"} />
      </div>
    );
  }

  return (
    <div ref={ref}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-1.5 text-left transition-colors hover:bg-state-hover",
          promptStackActivityRowClass(activityState),
        )}
      >
        <Icon
          name="ChevronDown"
          className={cn(
            "size-3 shrink-0 text-subtle-foreground transition-transform duration-200",
            !expanded && "-rotate-90",
            promptStackActivityIconClass(activityState),
          )}
          aria-hidden="true"
        />
        <span
          className={promptStackActivityTextClass(
            activityState,
            "text-xs font-medium no-underline",
          )}
        >
          {group.phase.title}
        </span>
        <span
          className={cn(
            "text-xs tabular-nums",
            activityMetaClass(activityState),
          )}
        >
          {progress}
        </span>
        <PhaseCompletedBadge visible={activityState === "completed"} />
      </button>
      {expanded ? (
        <div className="mt-1 flex min-w-0 flex-col">{agentLines}</div>
      ) : null}
    </div>
  );
}

function CollapsiblePhaseGroups({
  currentPhaseIndex,
  groups,
  onAgentActivate,
  terminalState,
  workflowSettled,
}: {
  currentPhaseIndex?: number;
  groups: readonly WorkflowPhaseGroup[];
  onAgentActivate?: (agent: WorkflowProgressAgent) => void;
  terminalState?: "completed" | "failed" | "cancelled";
  workflowSettled: boolean;
}) {
  const activeKey = activePhaseKey(groups, currentPhaseIndex);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const defaultExpanded = (key: string, group: WorkflowPhaseGroup): boolean =>
    workflowSettled
      ? group.agents.some(
          (agent) => agent.state !== "done" && agent.state !== "skipped",
        )
      : group.agents.some(
          (agent) =>
            !isSettledAgentState(agent.state) || agent.state === "failed",
        );
  const isExpanded = (key: string, group: WorkflowPhaseGroup): boolean =>
    overrides.get(key) ?? defaultExpanded(key, group);
  const toggle = (key: string, group: WorkflowPhaseGroup) =>
    setOverrides((current) => {
      const wasExpanded = current.get(key) ?? defaultExpanded(key, group);
      const next = new Map(current);
      next.set(key, !wasExpanded);
      return next;
    });

  return groups.map((group) => {
    const key = groupKey(group);
    return (
      <CollapsiblePhaseSection
        key={key}
        group={group}
        expanded={isExpanded(key, group)}
        isActive={key === activeKey}
        onAgentActivate={onAgentActivate}
        onToggle={() => toggle(key, group)}
        terminalState={terminalState}
        workflowSettled={workflowSettled}
      />
    );
  });
}

export function WorkflowProgress({
  collapsiblePhases = false,
  currentPhaseIndex,
  error,
  onAgentActivate,
  progress,
  settled,
  terminalState,
}: {
  collapsiblePhases?: boolean;
  currentPhaseIndex?: number;
  error?: string | null;
  onAgentActivate?: (agent: WorkflowProgressAgent) => void;
  progress: WorkflowProgressSnapshot;
  settled: boolean;
  terminalState?: "completed" | "failed" | "cancelled";
}) {
  const groups = groupAgentsByPhase(progress.phases, progress.agents);
  return (
    <div
      className={cn(
        "flex flex-col",
        collapsiblePhases ? "gap-1.5" : "gap-1 py-1",
      )}
    >
      {collapsiblePhases ? (
        <CollapsiblePhaseGroups
          currentPhaseIndex={currentPhaseIndex}
          groups={groups}
          onAgentActivate={onAgentActivate}
          terminalState={terminalState}
          workflowSettled={settled}
        />
      ) : (
        groups.map((group) => (
          <StaticPhaseGroup
            key={groupKey(group)}
            group={group}
            onAgentActivate={onAgentActivate}
            workflowSettled={settled}
          />
        ))
      )}
      {error ? (
        <div className="px-2 py-0.5 text-xs text-destructive/80">{error}</div>
      ) : null}
    </div>
  );
}

export type WorkflowStatusPillState =
  | "queued"
  | "completed"
  | "failed"
  | "cancelled";

const STATUS_PILL_LABEL: Record<WorkflowStatusPillState, string> = {
  queued: "Queued",
  completed: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function WorkflowStatusPill({
  state,
  className,
}: {
  state: WorkflowStatusPillState;
  className?: string;
}) {
  const base =
    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium";
  switch (state) {
    case "queued":
      return (
        <span
          className={cn(
            base,
            "bg-surface-recessed text-muted-foreground",
            className,
          )}
        >
          <span
            className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
            aria-hidden="true"
          />
          {STATUS_PILL_LABEL[state]}
        </span>
      );
    case "completed":
      return (
        <span className={cn(base, "bg-success/10 text-success", className)}>
          <Icon name="Check" className="size-3 shrink-0" aria-hidden="true" />
          {STATUS_PILL_LABEL[state]}
        </span>
      );
    case "failed":
      return (
        <span
          className={cn(
            base,
            "bg-destructive/10 text-destructive-text",
            className,
          )}
        >
          <Icon name="X" className="size-3 shrink-0" aria-hidden="true" />
          {STATUS_PILL_LABEL[state]}
        </span>
      );
    case "cancelled":
      return (
        <span
          className={cn(
            base,
            "bg-surface-recessed text-subtle-foreground",
            className,
          )}
        >
          <Icon name="Pause" className="size-3 shrink-0" aria-hidden="true" />
          {STATUS_PILL_LABEL[state]}
        </span>
      );
  }
}

type PhaseStripSegmentState = "done" | "active" | "failed" | "upcoming";

function phaseStripSegmentState(
  group: WorkflowPhaseGroup,
  isCurrent: boolean,
  workflowSettled: boolean,
): PhaseStripSegmentState {
  if (group.agents.some((agent) => agent.state === "failed")) return "failed";
  const total = group.agents.length;
  const settled = group.agents.filter((agent) =>
    isSettledAgentState(agent.state),
  ).length;
  if (total > 0 && settled === total && (workflowSettled || !isCurrent)) {
    return "done";
  }
  if (
    (isCurrent && !workflowSettled) ||
    group.agents.some((agent) => agent.state === "running") ||
    settled > 0
  ) {
    return "active";
  }
  if (workflowSettled && total > 0) return "done";
  return "upcoming";
}

const PHASE_STRIP_SEGMENT_CLASS: Record<PhaseStripSegmentState, string> = {
  done: "bg-success/60",
  active: "animate-pulse bg-foreground",
  failed: "bg-destructive/70",
  upcoming: "bg-muted-foreground/20",
};

export function WorkflowPhaseStrip({
  progress,
  currentPhaseIndex,
  settled,
  className,
}: {
  progress: WorkflowProgressSnapshot;
  currentPhaseIndex?: number;
  settled: boolean;
  className?: string;
}) {
  const groups = groupAgentsByPhase(progress.phases, progress.agents).filter(
    (group): group is WorkflowPhaseGroup & { phase: WorkflowProgressPhase } =>
      group.phase !== null,
  );
  if (groups.length === 0) return null;
  const runningKey = activePhaseKey(groups, currentPhaseIndex);
  return (
    <div
      className={cn("flex gap-1", className)}
      role="presentation"
      aria-hidden="true"
    >
      {groups.map((group) => (
        <span
          key={group.phase.index}
          className={cn(
            "h-[3px] min-w-1 flex-1 rounded-full",
            PHASE_STRIP_SEGMENT_CLASS[
              phaseStripSegmentState(
                group,
                groupKey(group) === runningKey,
                settled,
              )
            ],
          )}
        />
      ))}
    </div>
  );
}
