import { useEffect, useMemo, useRef, useState } from "react";
import type { Label } from "../../shared/contract.js";
import { useProjects } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { NewTaskDialog } from "../manage/new-task-dialog.js";
import { DetailToasts, useDetailToasts } from "../detail/toast.js";
import { Button } from "@bb/shared-ui/button";
import { DelayedLoading } from "@bb/shared-ui/delayed-loading";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { useLabels, useListTasks, useTaskListMeta } from "./data.js";
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  ListFilterBar,
  type ListFilterState,
} from "./filter-bar.js";
import {
  listPreferenceScope,
  loadListPreference,
  storeListPreference,
  type ListPreference,
} from "./list-preference.js";
import { sortTasks } from "../../shared/sort.js";
import type { TaskSort } from "../../shared/pagination.js";
import { StatusIcon } from "./icons.js";
import {
  listScrollScopeKey,
  useListScrollRestoration,
} from "./scroll-restoration.js";
import {
  groupTasksByStatus,
  labelFilterOptions,
  selectedLabelIds,
  STATUS_LABELS,
} from "./lib.js";
import { editedTasks, matchesFilters } from "./optimistic.js";
import { useListTaskEdits } from "./use-task-edits.js";
import { TaskRow } from "./row.js";

interface ListViewProps {
  projectId: string | null;
  activeOnly?: boolean;
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon name={icon} className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

function LoadingRows() {
  return (
    <DelayedLoading>
      <div className="px-3.5 pt-3">
        <Skeleton className="mb-3 h-4 w-28" />
        {Array.from({ length: 7 }, (_, index) => (
          <div
            key={index}
            className="flex h-[34px] items-center gap-2 border-b border-border-hairline"
          >
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

export function ListView({ projectId, activeOnly = false }: ListViewProps) {
  const navigation = useTasksNavigation();
  const projects = useProjects();
  const { toasts, push, dismiss } = useDetailToasts();
  const preferenceScope = listPreferenceScope(projectId, activeOnly);
  const [preference, setPreference] = useState<ListPreference>(() =>
    loadListPreference(preferenceScope),
  );
  useEffect(() => {
    setPreference(loadListPreference(preferenceScope));
  }, [preferenceScope]);
  const filters = preference.filters;
  const sort = preference.sort;
  const setFilters = (next: ListFilterState) => {
    setPreference((current) => {
      const updated: ListPreference = { filters: next, sort: current.sort };
      storeListPreference(preferenceScope, updated);
      return updated;
    });
  };
  const setSort = (next: TaskSort) => {
    setPreference((current) => {
      const updated: ListPreference = { filters: current.filters, sort: next };
      storeListPreference(preferenceScope, updated);
      return updated;
    });
  };
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  const labelProjectIds = useMemo(
    () =>
      projectId !== null
        ? [projectId]
        : (projects.data ?? []).map((project) => project.id),
    [projectId, projects.data],
  );
  const labels = useLabels(labelProjectIds);
  const labelOptions = useMemo(
    () => labelFilterOptions(labels.data ?? []),
    [labels.data],
  );
  const labelIds = useMemo((): readonly string[] | null => {
    if (filters.labelNames.length === 0) return null;
    if (labels.data === undefined) return null;
    return selectedLabelIds(labelOptions, filters.labelNames);
  }, [filters.labelNames, labelOptions, labels.data]);

  const tasksQuery = useListTasks(projectId, activeOnly, {
    statuses: filters.statuses,
    priorities: filters.priorities,
    labelIds,
  });
  const meta = useTaskListMeta(tasksQuery.data);
  const edits = useListTaskEdits(tasksQuery.data, (message) => push(message));

  const labelsById = useMemo(
    () => new Map((labels.data ?? []).map((label) => [label.id, label])),
    [labels.data],
  );
  const labelsByProject = useMemo(() => {
    const map = new Map<string, Label[]>();
    for (const label of labels.data ?? []) {
      const bucket = map.get(label.projectId);
      if (bucket) bucket.push(label);
      else map.set(label.projectId, [label]);
    }
    return map;
  }, [labels.data]);
  const projectsById = useMemo(
    () =>
      new Map((projects.data ?? []).map((project) => [project.id, project])),
    [projects.data],
  );

  const displayTasks = useMemo(() => {
    if (tasksQuery.data === undefined) return undefined;
    return editedTasks(tasksQuery.data, edits.entries).filter((task) =>
      matchesFilters(
        task,
        filters.statuses,
        filters.priorities,
        labelIds ?? [],
      ),
    );
  }, [
    tasksQuery.data,
    edits.entries,
    filters.statuses,
    filters.priorities,
    labelIds,
  ]);
  const groups = useMemo(
    () => groupTasksByStatus(sortTasks(displayTasks ?? [], sort)),
    [displayTasks, sort],
  );

  const showProject = projectId === null;
  const filtered = hasActiveFilters(filters);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scopeKey = listScrollScopeKey({ projectId, activeOnly, filters, sort });
  const settledScope = useRef(scopeKey);
  const scopeChanged = settledScope.current !== scopeKey;
  useEffect(() => {
    if (!tasksQuery.isLoading) settledScope.current = scopeKey;
  }, [scopeKey, tasksQuery.isLoading, tasksQuery.data]);
  const routeScope = `${projectId ?? "-"}/${activeOnly}`;
  const [settledRouteScope, setSettledRouteScope] = useState(routeScope);
  const routeScopeChanged = settledRouteScope !== routeScope;
  const previousRouteScope = useRef(routeScope);
  useEffect(() => {
    const routeScopeJustChanged = previousRouteScope.current !== routeScope;
    previousRouteScope.current = routeScope;
    if (!routeScopeJustChanged && !tasksQuery.isLoading) {
      setSettledRouteScope(routeScope);
    }
  }, [routeScope, tasksQuery.isLoading, tasksQuery.data]);
  useListScrollRestoration(scrollRef, scopeKey, {
    contentReady: tasksQuery.data !== undefined && tasksQuery.data.length > 0,
    loading: tasksQuery.isLoading || scopeChanged,
    revision: tasksQuery.data?.length ?? 0,
  });

  let body: React.ReactNode;
  if (
    routeScopeChanged ||
    tasksQuery.data === undefined ||
    displayTasks === undefined
  ) {
    body =
      !routeScopeChanged && tasksQuery.error !== null ? (
        <EmptyState
          icon="AlertCircle"
          title="Couldn't load tasks"
          description={tasksQuery.error}
        />
      ) : (
        <LoadingRows />
      );
  } else if (displayTasks.length === 0) {
    if (filtered) {
      body = (
        <EmptyState
          icon="Search"
          title="No tasks match these filters"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters(EMPTY_FILTERS)}
            >
              Clear filters
            </Button>
          }
        />
      );
    } else if (activeOnly) {
      body = (
        <EmptyState
          icon="Zap"
          title="No agents working right now"
          description="Dispatch a task to an agent preset and it will show up here while it runs."
        />
      );
    } else {
      body = (
        <EmptyState
          icon="ListTodo"
          title="No tasks yet"
          description="Create the first task to start tracking work."
          action={
            <Button size="sm" onClick={() => setNewTaskOpen(true)}>
              <Icon name="Plus" className="size-3.5" />
              New task
            </Button>
          }
        />
      );
    }
  } else {
    body = groups.map((group) => (
      <section key={group.status}>
        {}
        <div
          data-status-group-header={group.status}
          className="sticky top-0 z-20 isolate flex items-center gap-2 border-b border-border-hairline bg-background px-3.5 pb-1.5 pt-2.5 text-sm font-semibold"
        >
          <StatusIcon status={group.status} />
          {STATUS_LABELS[group.status]}
          <span className="text-xs font-normal tabular-nums text-subtle-foreground">
            {group.tasks.length}
          </span>
        </div>
        {group.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            meta={meta.data?.get(task.id)}
            project={projectsById.get(task.projectId)}
            showProject={showProject}
            labelsById={labelsById}
            projectLabels={labelsByProject.get(task.projectId) ?? []}
            onEdit={edits.edit}
            onOpen={() => navigation.go({ kind: "task", taskKey: task.key })}
            pending={edits.pending.has(task.id)}
          />
        ))}
      </section>
    ));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ListFilterBar
        filters={filters}
        onChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        labelOptions={labelOptions}
        taskCount={displayTasks?.length}
      />
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto @container"
      >
        {body}
      </div>
      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        projectId={projectId}
      />
      <DetailToasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
