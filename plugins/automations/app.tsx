import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { buildAutomationEditThreadPrompt } from "@bb/shared-ui/resource-edit-prompt";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { automationRpcContract } from "./src/rpc.js";
import { toast } from "sonner";
import type {
  AutomationResponse,
  AutomationReadResult,
  AgentExecutionUpdate,
  AutomationRunListResponse,
  AutomationRunResponse,
  AutomationsOverviewResponse,
} from "@/src/rpc-types";
import { AutomationDetailView } from "./detail-view";
import {
  AutomationOverviewView,
  automationProjectLabel,
  CREATE_AUTOMATION_PROMPT,
  type AutomationCollectionMode,
} from "./overview-view";
import { Button } from "@bb/shared-ui/button";
import { DelayedLoading } from "@bb/shared-ui/delayed-loading";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { ResourceListState } from "@bb/shared-ui/resource-list";
import { cn } from "@bb/shared-ui/lib/utils";

const PANEL_PATH = "automations";
const PERSONAL_PROJECT_ID = "proj_personal";
type OverviewEntry = AutomationsOverviewResponse["automations"][number];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DetailRoute {
  projectId: string;
  automationId: string;
}

interface ParsedDetailRoute {
  route: DetailRoute;
  editing: boolean;
}

function parseSubPath(subPath: string): ParsedDetailRoute | null {
  const parts = subPath.split("/").filter((p) => p.length > 0);
  if (parts.length === 2 || (parts.length === 3 && parts[2] === "edit")) {
    return {
      route: { projectId: parts[0], automationId: parts[1] },
      editing: parts[2] === "edit",
    };
  }
  return null;
}

interface AutomationSignal {
  projectId: string;
  kind: "automations-changed" | "automation-runs-changed";
}

function asSignal(payload: unknown): AutomationSignal | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as { projectId?: unknown; kind?: unknown };
  if (
    typeof record.projectId !== "string" ||
    (record.kind !== "automations-changed" &&
      record.kind !== "automation-runs-changed")
  ) {
    return null;
  }
  return { projectId: record.projectId, kind: record.kind };
}

function useOverview(): {
  entries: OverviewEntry[] | null;
  error: string | null;
  refetch: () => void;
} {
  const rpc = useRpc<typeof automationRpcContract>();
  const [state, setState] = useState<{
    entries: OverviewEntry[] | null;
    error: string | null;
  }>({ entries: null, error: null });
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestInFlightRef = useRef(false);
  const trailingRefetchRef = useRef(false);

  const runRefetch = useCallback(
    function requestOverview(showLoading: boolean) {
      if (requestInFlightRef.current) {
        trailingRefetchRef.current = true;
        return;
      }
      requestInFlightRef.current = true;
      if (showLoading) {
        setState({ entries: null, error: null });
      }
      rpc
        .call("automations_overview")
        .then(
          (result) => {
            const data = result as AutomationsOverviewResponse;
            setState({ entries: data.automations, error: null });
          },
          (error: unknown) =>
            setState((current) =>
              !showLoading && current.entries !== null
                ? current
                : { entries: null, error: errorText(error) },
            ),
        )
        .finally(() => {
          requestInFlightRef.current = false;
          if (trailingRefetchRef.current) {
            trailingRefetchRef.current = false;
            requestOverview(false);
          }
        });
    },
    [rpc],
  );
  const refetch = useCallback(() => runRefetch(true), [runRefetch]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useEffect(
    () => () => {
      if (refetchTimerRef.current !== null) {
        clearTimeout(refetchTimerRef.current);
      }
    },
    [],
  );
  const scheduleRefetch = useCallback(() => {
    if (requestInFlightRef.current) {
      trailingRefetchRef.current = true;
      return;
    }
    if (refetchTimerRef.current !== null) return;
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      runRefetch(false);
    }, 75);
  }, [runRefetch]);
  useRealtime("automations", (payload) => {
    if (asSignal(payload) !== null) scheduleRefetch();
  });
  return { ...state, refetch };
}

function useAutomation(route: DetailRoute): {
  automation: AutomationReadResult | null;
  error: string | null;
  missing: boolean;
  refetch: () => void;
} {
  const rpc = useRpc<typeof automationRpcContract>();
  const { projectId, automationId } = route;
  const [state, setState] = useState<{
    automation: AutomationReadResult | null;
    error: string | null;
    missing: boolean;
  }>({ automation: null, error: null, missing: false });
  const requestRef = useRef(0);

  const refetch = useCallback(() => {
    const requestId = ++requestRef.current;
    setState((current) => ({ ...current, error: null, missing: false }));
    rpc.call("automations_get", { projectId, automationId }).then(
      (result) => {
        if (requestRef.current !== requestId) return;
        const automation = result as AutomationReadResult | null;
        setState({
          automation: automation ?? null,
          error: null,
          missing: automation === null,
        });
      },
      (error: unknown) => {
        if (requestRef.current !== requestId) return;
        setState({ automation: null, error: errorText(error), missing: false });
      },
    );
  }, [rpc, projectId, automationId]);

  useEffect(() => {
    setState({ automation: null, error: null, missing: false });
    refetch();
    return () => {
      requestRef.current += 1;
    };
  }, [refetch]);
  useRealtime("automations", (payload) => {
    const signal = asSignal(payload);
    if (signal !== null && signal.projectId === projectId) refetch();
  });
  return { ...state, refetch };
}

interface RunsState {
  runs: AutomationRunResponse[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

function useRuns(
  route: DetailRoute,
): RunsState & { loadMore: () => void; retry: () => void } {
  const rpc = useRpc<typeof automationRpcContract>();
  const { projectId, automationId } = route;
  const [state, setState] = useState<RunsState>({
    runs: [],
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: null,
  });
  const requestRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);

  const loadFirstPage = useCallback(() => {
    const requestId = ++requestRef.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    rpc.call("automations_runs", { projectId, automationId }).then(
      (result) => {
        if (requestRef.current !== requestId) return;
        const page = result as AutomationRunListResponse;
        setState({
          runs: page.runs,
          nextCursor: page.nextCursor,
          loading: false,
          loadingMore: false,
          error: null,
        });
      },
      (error: unknown) => {
        if (requestRef.current !== requestId) return;
        setState({
          runs: [],
          nextCursor: null,
          loading: false,
          loadingMore: false,
          error: errorText(error),
        });
      },
    );
  }, [rpc, projectId, automationId]);

  const loadMore = useCallback(() => {
    if (
      state.nextCursor === null ||
      state.loadingMore ||
      loadMoreInFlightRef.current
    ) {
      return;
    }
    const cursor = state.nextCursor;
    const requestId = requestRef.current;
    loadMoreInFlightRef.current = true;
    setState((prev) => ({ ...prev, loadingMore: true }));
    rpc
      .call("automations_runs", { projectId, automationId, cursor })
      .then(
        (result) => {
          if (requestRef.current !== requestId) return;
          const page = result as AutomationRunListResponse;
          setState((current) => ({
            ...current,
            runs: [...current.runs, ...page.runs],
            nextCursor: page.nextCursor,
            loadingMore: false,
          }));
        },
        (error: unknown) => {
          if (requestRef.current !== requestId) return;
          toast.error(errorText(error));
          setState((current) => ({ ...current, loadingMore: false }));
        },
      )
      .finally(() => {
        loadMoreInFlightRef.current = false;
      });
  }, [rpc, projectId, automationId, state.nextCursor, state.loadingMore]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);
  useRealtime("automations", (payload) => {
    const signal = asSignal(payload);
    if (
      signal !== null &&
      signal.kind === "automation-runs-changed" &&
      signal.projectId === projectId
    ) {
      loadFirstPage();
    }
  });
  return { ...state, loadMore, retry: loadFirstPage };
}

function useMutations() {
  const rpc = useRpc<typeof automationRpcContract>();
  type MutationMethod =
    | "automations_pause"
    | "automations_resume"
    | "automations_run"
    | "automations_delete";
  const call = useCallback(
    (method: MutationMethod, route: DetailRoute) => rpc.call(method, route),
    [rpc],
  );
  return {
    pause: (route: DetailRoute) => call("automations_pause", route),
    resume: (route: DetailRoute) => call("automations_resume", route),
    run: (route: DetailRoute) => call("automations_run", route),
    delete: (route: DetailRoute) => call("automations_delete", route),
    update: (route: DetailRoute, agent: AgentExecutionUpdate) =>
      rpc.call("automations_update", { ...route, agent }),
  };
}

function DeleteAutomationDialog({
  open,
  onOpenChange,
  name,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <>
            <DialogHeader>
              <DialogTitle>Delete automation?</DialogTitle>
              <DialogDescription>
                &ldquo;{name}&rdquo; and its run history will be permanently
                removed.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={onConfirm}
              >
                Delete
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function OverviewView({
  onOpenDetail,
  activeMode,
  onModeChange,
}: {
  onOpenDetail: (route: DetailRoute, options?: { editing?: boolean }) => void;
  activeMode: AutomationCollectionMode;
  onModeChange: (mode: AutomationCollectionMode) => void;
}) {
  const navigate = useBbNavigate();
  const { entries, error, refetch } = useOverview();
  const mutations = useMutations();

  const changeEnabled = useCallback(
    async (enabled: boolean, route: DetailRoute) => {
      const method = enabled ? "resume" : "pause";
      try {
        await mutations[method](route);
      } catch (rpcError: unknown) {
        toast.error(`Failed to ${method} automation: ${errorText(rpcError)}`);
      }
    },
    [mutations],
  );

  const createViaChat = useCallback(
    (prompt?: string) => {
      navigate.toCompose({
        focusPrompt: true,
        initialPrompt: prompt ?? CREATE_AUTOMATION_PROMPT,
      });
    },
    [navigate],
  );

  return (
    <AutomationOverviewView
      entries={entries}
      error={error}
      onRetry={refetch}
      onOpenDetail={onOpenDetail}
      onEnabledChange={changeEnabled}
      onCreateViaChat={createViaChat}
      activeMode={activeMode}
      onModeChange={onModeChange}
    />
  );
}

function DetailView({
  route,
  initialEditing,
  onBack,
}: {
  route: DetailRoute;
  initialEditing: boolean;
  onBack: () => void;
}) {
  const navigate = useBbNavigate();
  const { automation, error, missing, refetch } = useAutomation(route);
  const [editingRequested, setEditingRequested] = useState(initialEditing);
  const overviewState = useOverview();
  const runsState = useRuns(route);
  const mutations = useMutations();
  const [actionPending, setActionPending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const openThread = useCallback(
    (threadId: string) => navigate.toThread(threadId),
    [navigate],
  );

  const editViaThread = useCallback(
    (target: AutomationResponse) => {
      navigate.toCompose({
        focusPrompt: true,
        initialPrompt: buildAutomationEditThreadPrompt({
          name: target.name,
          projectId: route.projectId,
          automationId: route.automationId,
        }),
      });
    },
    [navigate, route],
  );

  const runAction = useCallback(
    (method: "pause" | "resume" | "run") => {
      setActionPending(true);
      mutations[method](route)
        .then(
          () => {
            if (method === "run") toast.success("Run started");
          },
          (rpcError: unknown) =>
            toast.error(
              `Failed to ${method} automation: ${errorText(rpcError)}`,
            ),
        )
        .finally(() => setActionPending(false));
    },
    [mutations, route],
  );

  const openEdit = useCallback(() => {
    if (automation === null || "problem" in automation) return;
    if (automation.execution.mode === "agent") {
      setEditingRequested(true);
      return;
    }
    editViaThread(automation);
  }, [automation, editViaThread]);

  const updateAgent = useCallback(
    async (agent: AgentExecutionUpdate) => {
      setActionPending(true);
      try {
        await mutations.update(route, agent);
        toast.success("Automation updated");
        setEditingRequested(false);
        refetch();
      } catch (rpcError: unknown) {
        toast.error(`Failed to update automation: ${errorText(rpcError)}`);
        throw rpcError;
      } finally {
        setActionPending(false);
      }
    },
    [mutations, refetch, route],
  );

  const confirmDelete = useCallback(() => {
    setDeleting(true);
    mutations
      .delete(route)
      .then(
        () => {
          toast.success("Automation deleted");
          setDeleteOpen(false);
          onBack();
        },
        (rpcError: unknown) =>
          toast.error(`Failed to delete automation: ${errorText(rpcError)}`),
      )
      .finally(() => setDeleting(false));
  }, [mutations, route, onBack]);

  if (error !== null || missing) {
    return (
      <ResourceListState
        state="error"
        message={
          missing
            ? "Automation not found."
            : `Couldn't load automation: ${error}`
        }
        layout="detail"
        onRetry={refetch}
      />
    );
  }

  if (automation === null) {
    return (
      <DelayedLoading>
        <ResourceListState
          state="loading"
          message="Loading automation"
          layout="detail"
        />
      </DelayedLoading>
    );
  }

  const deleteDialog = (
    <DeleteAutomationDialog
      open={deleteOpen}
      onOpenChange={setDeleteOpen}
      name={automation.name}
      pending={deleting}
      onConfirm={confirmDelete}
      onCancel={() => setDeleteOpen(false)}
    />
  );

  if ("problem" in automation && automation.problem === "invalid-stored-data") {
    return (
      <>
        <div className="mx-auto w-full max-w-3xl space-y-3">
          <ResourceListState
            state="error"
            message="The stored automation configuration cannot be read."
            layout="detail"
            onRetry={refetch}
          />
          <div className="flex justify-center">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={() => setDeleteOpen(true)}
            >
              Delete automation
            </Button>
          </div>
        </div>
        {deleteDialog}
      </>
    );
  }

  const requiresPrompt =
    automation.execution.mode === "agent" && automation.execution.prompt === "";
  const readableAutomation: AutomationResponse = automation;

  const overviewEntry = overviewState.entries?.find(
    (entry) =>
      entry.automation.projectId === route.projectId &&
      entry.automation.id === route.automationId,
  );
  const projectLabel =
    overviewEntry !== undefined
      ? automationProjectLabel(overviewEntry.project)
      : route.projectId === PERSONAL_PROJECT_ID
        ? "Local"
        : route.projectId;

  return (
    <AutomationDetailView
      automation={readableAutomation}
      projectLabel={projectLabel}
      runsState={runsState}
      actionPending={actionPending}
      editing={requiresPrompt || editingRequested}
      onToggle={(checked) => runAction(checked ? "resume" : "pause")}
      onEdit={openEdit}
      onCancelEdit={requiresPrompt ? onBack : () => setEditingRequested(false)}
      onUpdateAgent={updateAgent}
      onRunNow={() => runAction("run")}
      onDelete={() => setDeleteOpen(true)}
      onOpenThread={openThread}
      footer={deleteDialog}
    />
  );
}

function AutomationsPageFrame({
  fill,
  children,
}: {
  fill: boolean;
  children: ReactNode;
}) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto box-border min-h-full w-full max-w-5xl px-4 pb-4 pt-3 md:px-5 md:pt-4",
          fill && "h-full",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function AutomationsPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const parsedRoute = useMemo(() => parseSubPath(subPath), [subPath]);
  const collectionMode: AutomationCollectionMode =
    subPath === "browse" ? "browse" : "installed";
  const openDetail = useCallback(
    (next: DetailRoute, options?: { editing?: boolean }) => {
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: `${next.projectId}/${next.automationId}${
          options?.editing ? "/edit" : ""
        }`,
      });
    },
    [navigate],
  );
  const backToList = useCallback(() => {
    navigate.toPluginPanel(PANEL_PATH, { subPath: "" });
  }, [navigate]);
  const changeCollectionMode = useCallback(
    (mode: AutomationCollectionMode) => {
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: mode === "browse" ? "browse" : "",
      });
    },
    [navigate],
  );
  if (parsedRoute !== null) {
    return (
      <AutomationsPageFrame fill={false}>
        <DetailView
          route={parsedRoute.route}
          initialEditing={parsedRoute.editing}
          onBack={backToList}
        />
      </AutomationsPageFrame>
    );
  }
  return (
    <AutomationsPageFrame fill>
      <OverviewView
        onOpenDetail={openDetail}
        activeMode={collectionMode}
        onModeChange={changeCollectionMode}
      />
    </AutomationsPageFrame>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "automations",
    title: "Automations",
    icon: "TimeSchedule",
    path: PANEL_PATH,
    component: AutomationsPanel,
  });
});
