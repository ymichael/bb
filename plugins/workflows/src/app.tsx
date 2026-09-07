import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  WorkflowPhaseStrip,
  WorkflowProgress,
  WorkflowStatusPill,
  type WorkflowProgressAgent,
  type WorkflowProgressAgentState,
  type WorkflowProgressSnapshot,
  type WorkflowStatusPillState,
} from "@bb/shared-ui/workflow-progress";
import {
  definePluginApp,
  useBbNavigate,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  WORKFLOW_RUNS_REALTIME_CHANNEL,
  workflowRunsSignalThreadId,
} from "./realtime-channel.js";
import type { workflowUiRpcContract } from "./ui-contract.js";
import type { WorkflowCallView, WorkflowRunView } from "./ui-contract.js";

type RunLoadState =
  | { status: "loading" }
  | {
      status: "ready";
      run: WorkflowRunView | null;
      refreshError: string | null;
    }
  | { status: "error"; message: string };

type ActiveRunsLoadState =
  | { status: "loading" }
  | { status: "ready"; runs: WorkflowRunView[] }
  | { status: "error" };

interface SharedWorkflowView {
  callsById: ReadonlyMap<string, WorkflowCallView>;
  currentPhaseIndex?: number;
  progress: WorkflowProgressSnapshot;
}

const ACTIVE_POLL_INTERVAL_MS = 1_000;
const WORKFLOW_PANEL_ACTION_ID = "workflow-run";
const WORKFLOW_CARD_ROW_HEIGHT = 32;
const WORKFLOW_HEADER_GROUP_CLASS = activityRowClass(
  "active",
  "flex w-full items-stretch rounded-none px-0 py-0",
);
const WORKFLOW_HEADER_BUTTON_CLASS =
  "flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-none bg-transparent px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80";
const WORKFLOW_OPEN_BUTTON_CLASS =
  "flex min-h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-none border-l border-border/35 bg-transparent text-muted-foreground transition-colors hover:text-foreground";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRunId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const runId = value.trim();
  return /^wfr_[0-9a-f-]+$/i.test(runId) ? runId : null;
}

function directiveRunId(
  attributes: Readonly<Record<string, string>>,
): string | null {
  if (Object.keys(attributes).some((key) => key !== "run")) return null;
  return requireRunId(attributes.run);
}

function panelRunId(params: unknown): string | null | undefined {
  if (params === null) return null;
  if (!isRecord(params) || Object.keys(params).some((key) => key !== "runId")) {
    return undefined;
  }
  return requireRunId(params.runId) ?? undefined;
}

function isRunActive(run: WorkflowRunView): boolean {
  return run.status === "queued" || run.status === "running";
}

function runTerminalState(
  run: WorkflowRunView,
): "completed" | "failed" | "cancelled" | undefined {
  switch (run.status) {
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "queued":
    case "running":
      return undefined;
  }
}

function settledAgentCount(agents: readonly WorkflowProgressAgent[]): number {
  return agents.filter(
    (agent) =>
      agent.state === "done" ||
      agent.state === "failed" ||
      agent.state === "skipped" ||
      agent.state === "cancelled",
  ).length;
}

function runPillState(
  status: WorkflowRunView["status"],
): WorkflowStatusPillState | null {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return null;
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function runActivityState(run: WorkflowRunView): ActivityRowState {
  switch (run.status) {
    case "queued":
    case "running":
      return "active";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "muted";
  }
}

function formatDuration(startedAt: number | null, finishedAt: number | null) {
  if (startedAt === null) return null;
  const durationMs = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    seconds > 0 ? `${seconds}s` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function WorkflowDuration({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    setElapsed(Date.now() - startedAt);
    const interval = window.setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  if (elapsed <= 1_000) return null;
  return <>{formatDuration(0, elapsed)}</>;
}

function WorkflowDetailScroll({
  currentPhaseIndex,
  progress,
}: {
  currentPhaseIndex?: number;
  progress: WorkflowProgressSnapshot;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ above: false, below: false });
  const contentKey = progress.agents
    .map((agent) => `${agent.index}:${agent.state}:${agent.lastProgressAt}`)
    .join("|");
  const updateOverflow = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const nextOverflow = {
      above: element.scrollTop > 1,
      below:
        element.scrollTop + element.clientHeight < element.scrollHeight - 1,
    };
    setOverflow((currentOverflow) =>
      currentOverflow.above === nextOverflow.above &&
      currentOverflow.below === nextOverflow.below
        ? currentOverflow
        : nextOverflow,
    );
  }, []);

  useEffect(() => {
    updateOverflow();
    const element = scrollRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [contentKey, updateOverflow]);

  return (
    <div className="relative isolate min-w-0" data-detail-scroll="base">
      <div
        ref={scrollRef}
        onScroll={updateOverflow}
        data-detail-scroll-area="base"
        className="max-h-[288px] min-w-0 overflow-x-auto overflow-y-auto px-2.5 py-2"
      >
        <div aria-hidden className="-mb-px h-px w-full" />
        <WorkflowProgress
          progress={progress}
          settled={false}
          collapsiblePhases
          currentPhaseIndex={currentPhaseIndex}
        />
        <div aria-hidden className="h-px w-full" />
      </div>
      {overflow.above ? (
        <div
          aria-hidden
          data-detail-scroll-fade="above"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent"
        />
      ) : null}
      {overflow.below ? (
        <div
          aria-hidden
          data-detail-scroll-fade="below"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-background to-transparent"
        />
      ) : null}
    </div>
  );
}

function shortModelName(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function workflowAgentState(
  status: WorkflowCallView["status"],
): WorkflowProgressAgentState {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function buildSharedWorkflowView(run: WorkflowRunView): SharedWorkflowView {
  const phases = run.phases.map((phase, index) => ({
    index: index + 1,
    title: phase.title,
  }));
  const otherWorkIndex =
    run.unphasedCalls.length === 0 ? null : phases.length + 1;
  const phaseIndexByTitle = new Map(
    phases.map((phase) => [phase.title, phase.index] as const),
  );
  if (otherWorkIndex !== null) {
    phases.push({ index: otherWorkIndex, title: "Other work" });
  }
  const calls = [
    ...run.phases.flatMap((phase) => phase.calls),
    ...run.unphasedCalls,
  ].sort((left, right) => left.index - right.index);
  const callsById = new Map(calls.map((call) => [call.id, call] as const));
  const agents: WorkflowProgressAgent[] = calls.map((call) => ({
    id: call.id,
    actionable: call.childThreadId !== null,
    index: call.index + 1,
    label: call.label,
    state: workflowAgentState(call.status),
    model: call.model,
    attempt: call.providerRetryAttempts + call.repairAttempts + 1,
    cached: call.cached,
    lastProgressAt: call.finishedAt ?? call.startedAt ?? call.createdAt,
    phaseIndex:
      call.phase === null
        ? (otherWorkIndex ?? undefined)
        : phaseIndexByTitle.get(call.phase),
    error: call.error ?? undefined,
    durationMs:
      call.startedAt !== null && call.finishedAt !== null
        ? Math.max(0, call.finishedAt - call.startedAt)
        : undefined,
    metadata: [call.provider, shortModelName(call.model), call.reasoningLevel],
  }));
  return {
    callsById,
    currentPhaseIndex:
      run.currentPhase === null
        ? undefined
        : phaseIndexByTitle.get(run.currentPhase),
    progress: { phases, agents },
  };
}

function useWorkflowRun(
  threadId: string,
  runId: string | null,
): { state: RunLoadState; refresh: () => Promise<void> } {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [state, setState] = useState<RunLoadState>({ status: "loading" });
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const result = await rpc.call("workflowRunView", { threadId, runId });
      if (sequence === requestSequence.current) {
        setState({ status: "ready", run: result.run, refreshError: null });
      }
    } catch (error) {
      if (sequence === requestSequence.current) {
        const message = error instanceof Error ? error.message : String(error);
        setState((current) =>
          current.status === "ready" && current.run !== null
            ? { ...current, refreshError: message }
            : { status: "error", message },
        );
      }
    }
  }, [rpc, runId, threadId]);

  useEffect(() => {
    setState({ status: "loading" });
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);

  const shouldPoll =
    state.status === "error" ||
    (state.status === "ready" && state.run !== null && isRunActive(state.run));
  useVisibleActivePolling(refresh, shouldPoll);

  return { state, refresh };
}

function subscribeDocumentVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function readDocumentVisible(): boolean {
  return document.visibilityState !== "hidden";
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeDocumentVisibility,
    readDocumentVisible,
    () => true,
  );
}

function useVisibleActivePolling(
  refresh: () => Promise<void>,
  active: boolean,
): void {
  const visible = useDocumentVisible();
  const connection = useRealtimeConnectionState();
  const wasHidden = useRef(false);
  const wasDisconnected = useRef(false);

  useEffect(() => {
    if (!visible) {
      wasHidden.current = true;
      return;
    }
    if (!wasHidden.current) return;
    wasHidden.current = false;
    void refresh();
  }, [refresh, visible]);

  useEffect(() => {
    if (connection !== "connected") {
      wasDisconnected.current = true;
      return;
    }
    if (!wasDisconnected.current) return;
    wasDisconnected.current = false;
    void refresh();
  }, [connection, refresh]);

  const enabled = active && visible;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timeout: number | null = null;
    const schedule = () => {
      timeout = window.setTimeout(() => {
        void refresh().finally(() => {
          if (!cancelled) schedule();
        });
      }, ACTIVE_POLL_INTERVAL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [enabled, refresh]);
}

function useActiveWorkflowRuns(threadId: string): {
  state: ActiveRunsLoadState;
  setRuns: (update: (runs: WorkflowRunView[]) => WorkflowRunView[]) => void;
} {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [state, setState] = useState<ActiveRunsLoadState>({
    status: "loading",
  });
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const result = await rpc.call("workflowActiveRuns", { threadId });
      if (sequence === requestSequence.current) {
        setState({ status: "ready", runs: result.runs });
      }
    } catch {
      if (sequence === requestSequence.current) setState({ status: "error" });
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setState({ status: "loading" });
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);

  useRealtime(WORKFLOW_RUNS_REALTIME_CHANNEL, (payload) => {
    if (workflowRunsSignalThreadId(payload) === threadId) void refresh();
  });

  const shouldPoll =
    state.status === "error" ||
    (state.status === "ready" && state.runs.some(isRunActive));
  useVisibleActivePolling(refresh, shouldPoll);

  const setRuns = useCallback(
    (update: (runs: WorkflowRunView[]) => WorkflowRunView[]) => {
      setState((current) =>
        current.status === "ready"
          ? { status: "ready", runs: update(current.runs) }
          : current,
      );
    },
    [],
  );

  return { state, setRuns };
}

export function EmptyOrError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function LoadingPreview() {
  return (
    <div className="space-y-2" aria-busy="true">
      <Skeleton className="h-3.5 w-44 rounded-sm" />
      <Skeleton className="h-3 w-2/3 rounded-sm" />
      <Skeleton className="h-3 w-1/2 rounded-sm" />
    </div>
  );
}

export function WorkflowRunPanelState({ children }: { children: ReactNode }) {
  return <div className="p-4">{children}</div>;
}

function RefreshWarning({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="rounded-md border border-warning/20 bg-warning/5 px-2.5 py-1.5 text-xs text-warning-text"
    >
      Could not refresh: {message}. Retrying…
    </div>
  );
}

function WorkflowStatusBanner() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;
  return <WorkflowStatusBannerLoaded threadId={view.scope.threadId} />;
}

function WorkflowComposerCard({ run }: { run: WorkflowRunView }) {
  const navigate = useBbNavigate();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const toggleId = useId();
  const shared = buildSharedWorkflowView(run);
  const settledAgents = settledAgentCount(shared.progress.agents);
  const agentCount = shared.progress.agents.length;

  return (
    <section
      aria-label="Workflow"
      className="overflow-hidden rounded-lg border border-border bg-surface-raised-solid"
      style={{ minHeight: WORKFLOW_CARD_ROW_HEIGHT }}
    >
      <div
        role="group"
        aria-label={`Workflow controls: ${run.name}`}
        className={WORKFLOW_HEADER_GROUP_CLASS}
      >
        <button
          type="button"
          id={toggleId}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`Workflow: ${run.name}`}
          onClick={() => setExpanded((value) => !value)}
          className={WORKFLOW_HEADER_BUTTON_CLASS}
        >
          <Icon
            name="Workflow"
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span
              className={activityTextClass("active", "min-w-0 truncate")}
              title={run.name}
            >
              {run.name}
            </span>
            {agentCount === 0 ? null : (
              <span
                className={activityMetaClass(
                  "active",
                  "shrink-0 text-2xs tabular-nums",
                )}
              >
                {settledAgents}/{agentCount} agents
              </span>
            )}
            {run.startedAt === null ? null : (
              <span
                className={activityMetaClass(
                  "active",
                  "shrink-0 text-2xs tabular-nums",
                )}
              >
                <WorkflowDuration startedAt={run.startedAt} />
              </span>
            )}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              activityIconClass("active"),
              "size-3.5 shrink-0 transition-transform duration-200",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        <button
          type="button"
          aria-label={`Open workflow ${run.name} in side panel`}
          onClick={() =>
            navigate.openThreadPanel({
              actionId: WORKFLOW_PANEL_ACTION_ID,
              title: run.name,
              params: { runId: run.id },
            })
          }
          className={WORKFLOW_OPEN_BUTTON_CLASS}
        >
          <Icon name="ArrowRight" className="size-3.5" aria-hidden />
        </button>
      </div>
      <WorkflowPhaseStrip
        progress={shared.progress}
        currentPhaseIndex={shared.currentPhaseIndex}
        settled={false}
        className="px-3 pb-2"
      />
      <section
        id={bodyId}
        role="region"
        aria-labelledby={toggleId}
        aria-hidden={!expanded}
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
          expanded
            ? "grid-rows-[1fr] border-t border-border opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden bg-popover">
          <WorkflowDetailScroll
            progress={shared.progress}
            currentPhaseIndex={shared.currentPhaseIndex}
          />
        </div>
      </section>
    </section>
  );
}

function WorkflowStatusBannerLoaded({ threadId }: { threadId: string }) {
  const { state } = useActiveWorkflowRuns(threadId);

  if (state.status !== "ready" || state.runs.length === 0) return null;

  return (
    <section aria-label="Active workflows" className="space-y-2">
      {state.runs.map((run) => (
        <WorkflowComposerCard key={run.id} run={run} />
      ))}
    </section>
  );
}

function WorkflowPreviewDirective({
  attributes,
  source,
  message,
}: PluginMessageDirectiveProps) {
  const runId = directiveRunId(attributes);
  if (runId === null) {
    return (
      <EmptyOrError>
        workflow-preview requires exactly one valid run attribute, e.g.{" "}
        <code>::workflow-preview{'{run="wfr_…"}'}</code>
      </EmptyOrError>
    );
  }
  return (
    <WorkflowPreviewLoaded
      runId={runId}
      threadId={message.threadId}
      source={source}
    />
  );
}

function WorkflowPreviewLoaded({
  runId,
  threadId,
  source,
}: {
  runId: string;
  threadId: string;
  source: string;
}) {
  const navigate = useBbNavigate();
  const { state } = useWorkflowRun(threadId, runId);
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();
  const toggleId = useId();
  if (state.status === "loading") return <LoadingPreview />;
  if (state.status === "error") {
    return <EmptyOrError>{state.message}</EmptyOrError>;
  }
  if (state.run === null) {
    return <EmptyOrError>Workflow run not found.</EmptyOrError>;
  }
  const run = state.run;
  const shared = buildSharedWorkflowView(run);
  const activityState = runActivityState(run);
  const pillState = runPillState(run.status);
  const duration = formatDuration(run.startedAt, run.finishedAt);
  const settledAgents = settledAgentCount(shared.progress.agents);
  return (
    <section
      className="my-2 overflow-hidden rounded-lg border border-border bg-surface-recessed"
      title={source}
      aria-label="Workflow"
    >
      <button
        type="button"
        id={toggleId}
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={`Workflow: ${run.name}`}
        onClick={() => setExpanded((value) => !value)}
        className={activityRowClass(
          activityState,
          "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80",
        )}
      >
        <Icon
          name="Workflow"
          className={activityIconClass(activityState, "size-3.5 shrink-0")}
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span
            className={activityTextClass(
              activityState,
              "min-w-0 truncate no-underline",
            )}
            title={run.name}
          >
            {run.name}
          </span>
          {shared.progress.agents.length > 0 ? (
            <span
              className={activityMetaClass(
                activityState,
                "shrink-0 text-2xs tabular-nums",
              )}
            >
              {settledAgents}/{shared.progress.agents.length} agents
            </span>
          ) : null}
          {duration === null ? null : (
            <span
              className={activityMetaClass(
                activityState,
                "shrink-0 text-2xs tabular-nums",
              )}
            >
              {duration}
            </span>
          )}
        </span>
        {pillState === null ? null : <WorkflowStatusPill state={pillState} />}
        <Icon
          name="ChevronDown"
          className={cn(
            activityIconClass(activityState),
            "size-3.5 shrink-0 transition-transform duration-200",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      <WorkflowPhaseStrip
        progress={shared.progress}
        currentPhaseIndex={shared.currentPhaseIndex}
        settled={!isRunActive(run)}
        className="px-3 pb-2"
      />
      <section
        id={bodyId}
        role="region"
        aria-labelledby={toggleId}
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
          expanded
            ? "grid-rows-[1fr] border-t border-border opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden bg-popover">
          <div
            data-detail-scroll-area="base"
            className="max-h-[288px] overflow-y-auto px-2.5 py-2"
          >
            <WorkflowProgress
              progress={shared.progress}
              settled={!isRunActive(run)}
              error={run.error}
              collapsiblePhases
              currentPhaseIndex={shared.currentPhaseIndex}
              terminalState={runTerminalState(run)}
            />
          </div>
        </div>
      </section>
      {state.refreshError === null ? null : (
        <div className="border-t border-border-seam bg-popover px-3 py-2">
          <RefreshWarning message={state.refreshError} />
        </div>
      )}
      <div className="flex min-h-9 items-center border-t border-border-seam bg-popover px-2">
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() =>
            navigate.openThreadPanel({
              actionId: WORKFLOW_PANEL_ACTION_ID,
              title: run.name,
              params: { runId: run.id },
            })
          }
        >
          Open in right panel
          <Icon name="ArrowRight" className="size-3" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

function WorkflowRunPanel({ threadId, params }: PluginThreadPanelProps) {
  const runId = panelRunId(params);
  return (
    <div className="h-full min-h-0 flex-1 bg-border">
      {runId === undefined ? (
        <WorkflowRunPanelState>
          <EmptyOrError>
            This workflow panel has invalid run parameters.
          </EmptyOrError>
        </WorkflowRunPanelState>
      ) : (
        <WorkflowRunPanelLoaded threadId={threadId} runId={runId} />
      )}
    </div>
  );
}

function WorkflowRunPanelLoaded({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string | null;
}) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const { state, refresh } = useWorkflowRun(threadId, runId);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const run = state.status === "ready" ? state.run : null;
  const shared = useMemo(
    () => (run === null ? null : buildSharedWorkflowView(run)),
    [run],
  );
  if (state.status === "loading") {
    return (
      <WorkflowRunPanelState>
        <LoadingPreview />
      </WorkflowRunPanelState>
    );
  }
  if (state.status === "error") {
    return (
      <WorkflowRunPanelState>
        <EmptyOrError>{state.message}</EmptyOrError>
      </WorkflowRunPanelState>
    );
  }
  if (run === null || shared === null) {
    return (
      <WorkflowRunPanelState>
        <EmptyOrError>
          No workflow runs were found for this thread.
        </EmptyOrError>
      </WorkflowRunPanelState>
    );
  }
  const pillState = runPillState(run.status);
  const duration = formatDuration(run.startedAt, run.finishedAt);
  const settledAgents = settledAgentCount(shared.progress.agents);
  const completedCalls = shared.progress.agents.filter(
    (agent) => agent.state === "done",
  ).length;
  const cachedCalls = shared.progress.agents.filter(
    (agent) => agent.cached,
  ).length;
  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await rpc.call("workflowStopRun", { threadId, runId: run.id });
      await refresh();
    } catch (error) {
      setStopError(error instanceof Error ? error.message : String(error));
    } finally {
      setStopping(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-border">
      <div
        data-detail-scroll-area="workflow-panel"
        className="min-h-0 flex-1 overflow-y-auto p-4"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-foreground">
              {run.name}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {run.description}
            </p>
          </div>
          {pillState === null ? null : <WorkflowStatusPill state={pillState} />}
        </div>
        <div className="mt-2 flex items-center gap-2 text-2xs tabular-nums text-subtle-foreground">
          <span>
            {shared.progress.agents.length > 0
              ? `${settledAgents}/${shared.progress.agents.length} agents · `
              : ""}
            {duration === null
              ? "Not started"
              : `${duration} ${isRunActive(run) ? "elapsed" : "total"}`}
          </span>
          <span className="ml-auto font-mono">{run.id.slice(-8)}</span>
        </div>
        <WorkflowPhaseStrip
          progress={shared.progress}
          currentPhaseIndex={shared.currentPhaseIndex}
          settled={!isRunActive(run)}
          className="mt-3"
        />
        {stopError === null ? null : (
          <div
            role="alert"
            className="mt-3 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive-text"
          >
            {stopError}
          </div>
        )}
        {state.refreshError === null ? null : (
          <div className="mt-3">
            <RefreshWarning message={state.refreshError} />
          </div>
        )}
        <div className="my-4 h-px bg-border-seam" />
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          Phases
        </h3>
        <div className="-mx-2">
          <WorkflowProgress
            progress={shared.progress}
            settled={!isRunActive(run)}
            error={run.error}
            collapsiblePhases
            currentPhaseIndex={shared.currentPhaseIndex}
            terminalState={runTerminalState(run)}
            onAgentActivate={(agent) => {
              const childThreadId =
                agent.id === undefined
                  ? null
                  : (shared.callsById.get(agent.id)?.childThreadId ?? null);
              if (childThreadId !== null) navigate.toThread(childThreadId);
            }}
          />
        </div>
        <div className="my-4 h-px bg-border-seam" />
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          Run details
        </h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-subtle-foreground">Agent calls</dt>
          <dd className="text-right text-muted-foreground">
            {completedCalls} of {shared.progress.agents.length}
          </dd>
          <dt className="text-subtle-foreground">Cache hits</dt>
          <dd className="text-right text-muted-foreground">{cachedCalls}</dd>
          <dt className="text-subtle-foreground">Started</dt>
          <dd className="text-right text-muted-foreground">
            {run.startedAt === null
              ? "—"
              : new Date(run.startedAt).toLocaleTimeString()}
          </dd>
          <dt className="text-subtle-foreground">Result</dt>
          <dd className="text-right text-muted-foreground">
            {run.resultAvailable ? "Available" : "—"}
          </dd>
        </dl>
      </div>
      {isRunActive(run) ? (
        <div className="border-t border-border-seam p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full text-destructive-text"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping…" : "Stop workflow"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "workflow-status",
    scopes: ["thread"],
    banners: [
      { id: "active-runs", chrome: "bare", component: WorkflowStatusBanner },
    ],
  });
  app.slots.messageDirective({
    id: "workflow-preview",
    component: WorkflowPreviewDirective,
  });
  app.slots.threadPanelAction({
    id: WORKFLOW_PANEL_ACTION_ID,
    title: "Workflow run",
    icon: "Workflow",
    component: WorkflowRunPanel,
    layout: "flush",
  });
});
