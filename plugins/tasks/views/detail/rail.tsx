import { useState } from "react";
import type {
  Label,
  Project,
  Task,
  TaskPriority,
  TaskStatus,
  TaskThread,
} from "../../shared/contract.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../shared/contract.js";
import type { Preset } from "../../shared/contract.js";
import { useTasksQuery, useTasksRpc } from "../../shell/data.js";
import {
  PriorityIcon,
  StatusIcon,
  formatDueDate,
  isActiveThread,
} from "./meta.js";
import {
  DUE_DATE_PRESETS,
  localIsoDate,
  PRIORITY_LABELS,
  STATUS_LABELS,
} from "../list/lib.js";
import { DispatchControl } from "./threads.js";
import { DEFAULT_COLOR } from "../manage/shared.js";
import {
  BbProjectLinkPicker,
  bbProjectLinkStateFor,
  emptyBbProjectLinkState,
  resolveBbProjectLink,
  type BbProjectLinkState,
} from "../manage/bb-project-link.js";
import type { BbProjectOption } from "../../shared/contract.js";
import { Button } from "@bb/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@bb/shared-ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

export interface TaskPropertyUpdate {
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  labelIds?: string[];
}

interface TaskPropertiesProps {
  task: Task;
  project: Project | undefined;
  labels: Label[] | undefined;
  threads: TaskThread[];
  onUpdate: (update: TaskPropertyUpdate) => void;
}

function LabelChip({ label }: { label: Label }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-2xs text-muted-foreground">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      {label.name}
    </span>
  );
}

function StatusMenu({
  task,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName}>
          <StatusIcon status={task.status} />
          {STATUS_LABELS[task.status]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_STATUSES.map((status) => (
          <DropdownMenuItem key={status} onSelect={() => onUpdate({ status })}>
            <StatusIcon status={status} />
            {STATUS_LABELS[status]}
            {status === task.status ? (
              <Icon name="Check" className="ml-auto size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityMenu({
  task,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName}>
          <PriorityIcon priority={task.priority} />
          {PRIORITY_LABELS[task.priority]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_PRIORITIES.map((priority) => (
          <DropdownMenuItem
            key={priority}
            onSelect={() => onUpdate({ priority })}
          >
            <PriorityIcon priority={priority} />
            {PRIORITY_LABELS[priority]}
            {priority === task.priority ? (
              <Icon name="Check" className="ml-auto size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DueDateMenu({
  task,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (dueDate: string | null) => {
    onUpdate({ dueDate });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClassName}>
          <Icon name="Clock" className="size-3.5 shrink-0" />
          {task.dueDate ? formatDueDate(task.dueDate) : "Set due date"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-2">
        <div className="flex flex-col">
          {DUE_DATE_PRESETS.map(([label, days]) => (
            <button
              key={label}
              type="button"
              className="flex items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => pick(localIsoDate(days))}
            >
              {label}
              <span className="text-xs text-muted-foreground">
                {formatDueDate(localIsoDate(days))}
              </span>
            </button>
          ))}
          <input
            type="date"
            aria-label="Due date"
            className="mt-1 h-7 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
            value={task.dueDate ?? ""}
            onChange={(event) => {
              if (event.target.value) pick(event.target.value);
            }}
          />
          {task.dueDate ? (
            <button
              type="button"
              className="mt-1 flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => pick(null)}
            >
              <Icon name="X" className="size-3.5" />
              Remove due date
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LabelsMenu({
  task,
  labels,
  onUpdate,
  children,
}: {
  task: Task;
  labels: Label[] | undefined;
  onUpdate: (update: TaskPropertyUpdate) => void;
  children: React.ReactNode;
}) {
  const rpc = useTasksRpc();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const toggle = (labelId: string) => {
    const next = task.labelIds.includes(labelId)
      ? task.labelIds.filter((id) => id !== labelId)
      : [...task.labelIds, labelId];
    onUpdate({ labelIds: next });
  };

  const createLabel = async (name: string) => {
    if (!name || creating) return;
    setCreating(true);
    try {
      const { label } = await rpc.call("createLabel", {
        projectId: task.projectId,
        name,
        color: DEFAULT_COLOR,
      });
      onUpdate({ labelIds: [...task.labelIds, label.id] });
      setQuery("");
    } finally {
      setCreating(false);
    }
  };

  const labelList = labels ?? [];
  return (
    <Popover onOpenChange={(open) => open || setQuery("")}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Add labels…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty
              className={query.trim() !== "" ? "p-1 text-left" : undefined}
            >
              {query.trim() !== "" ? (
                <button
                  type="button"
                  disabled={creating}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => void createLabel(query.trim())}
                >
                  <Icon name="Plus" className="size-3.5" />
                  Create “{query.trim()}”
                </button>
              ) : (
                "No labels in this project."
              )}
            </CommandEmpty>
            {labels !== undefined && labelList.length === 0 ? (
              <CommandGroup>
                <CommandItem
                  disabled={creating}
                  onSelect={() => {
                    const name = query.trim();
                    if (name) void createLabel(name);
                  }}
                >
                  <Icon name="Plus" className="size-3.5" />
                  New label{query.trim() ? ` “${query.trim()}”` : "…"}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {}
            {labelList.length > 0 ? (
              <CommandGroup>
                {labelList.map((label) => (
                  <CommandItem
                    key={label.id}
                    value={label.name}
                    onSelect={() => toggle(label.id)}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1">{label.name}</span>
                    {task.labelIds.includes(label.id) ? (
                      <Icon name="Check" className="size-3.5" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DispatchTargetMenu({
  project,
  bbProjects,
  onError,
  triggerClassName,
}: {
  project: Project;
  bbProjects: readonly BbProjectOption[];
  onError: (message: string) => void;
  triggerClassName: string;
}) {
  const rpc = useTasksRpc();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BbProjectLinkState>(
    emptyBbProjectLinkState,
  );
  const [saving, setSaving] = useState(false);
  const linkedBbProjectId = project.linkedBbProjectId;
  const linkedName = bbProjects.find(
    (candidate) => candidate.id === linkedBbProjectId,
  )?.name;
  const resolved = resolveBbProjectLink(state);

  const save = async (linkedId: string | null) => {
    if (saving) return;
    setSaving(true);
    try {
      await rpc.call("updateProject", {
        projectId: project.id,
        linkedBbProjectId: linkedId,
      });
      setOpen(false);
    } catch (saveError) {
      onError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setState(bbProjectLinkStateFor(linkedBbProjectId));
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Edit dispatch target"
          className={triggerClassName}
        >
          <Icon name="ArrowUpRight" className="size-3.5 shrink-0" />
          {linkedBbProjectId !== null ? (
            <span className="truncate" title={linkedBbProjectId}>
              {linkedName ?? linkedBbProjectId}
            </span>
          ) : (
            <span className="truncate text-muted-foreground">
              Link a bb project…
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <BbProjectLinkPicker
          state={state}
          onStateChange={setState}
          bbProjects={bbProjects}
          noneLabel={linkedBbProjectId !== null ? "Unlink" : "Not linked"}
        />
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {linkedBbProjectId !== null ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              disabled={saving}
              onClick={() => void save(null)}
            >
              <Icon name="X" className="size-3.5" />
              Unlink
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            className="h-7"
            disabled={saving}
            onClick={() => void save(resolved === "" ? null : resolved)}
          >
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const RAIL_ROW_CLASS =
  "-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-state-hover";

export function PropertiesRail({
  task,
  project,
  labels,
  threads,
  presets,
  onUpdate,
  onError,
  className,
}: TaskPropertiesProps & {
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  className?: string;
}) {
  const taskLabels = (labels ?? []).filter((label) =>
    task.labelIds.includes(label.id),
  );
  const active = threads.filter(isActiveThread);
  const bbProjects = useTasksQuery(
    async (query) => (await query.call("listBbProjects")).bbProjects,
    ["projects:changed"],
  );
  return (
    <aside className={cn("w-56 shrink-0 py-10 pl-2 pr-6", className)}>
      <h2 className="mb-1.5 text-xs font-semibold text-muted-foreground">
        Properties
      </h2>
      <StatusMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={RAIL_ROW_CLASS}
      />
      <PriorityMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={RAIL_ROW_CLASS}
      />
      <DueDateMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={RAIL_ROW_CLASS}
      />

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
        Labels
      </div>
      <div className="flex flex-wrap items-center gap-1 py-0.5">
        {taskLabels.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
        <LabelsMenu task={task} labels={labels} onUpdate={onUpdate}>
          <button
            type="button"
            aria-label="Edit labels"
            className="inline-flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 text-muted-foreground hover:border-input hover:text-foreground"
          >
            <Icon name="Plus" className="size-3" />
          </button>
        </LabelsMenu>
      </div>

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
        Project
      </div>
      <div className="flex items-center gap-2 py-0.5 text-sm">
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-sm"
          style={{ backgroundColor: project?.color }}
        />
        <span className="truncate">{project?.name ?? "…"}</span>
      </div>

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
        Dispatch target
      </div>
      {project !== undefined ? (
        <DispatchTargetMenu
          project={project}
          bbProjects={bbProjects.data ?? []}
          onError={onError}
          triggerClassName={RAIL_ROW_CLASS}
        />
      ) : (
        <div className="py-0.5 text-sm text-muted-foreground">…</div>
      )}

      <div className="mt-2.5 py-0.5">
        <DispatchControl
          taskId={task.id}
          presets={presets}
          onError={onError}
          align="start"
          className="w-full"
        />
      </div>

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
        Agents
      </div>
      <div className="flex flex-col gap-1 py-0.5 text-xs">
        {active.length > 0 ? (
          active.map((thread) => (
            <span
              key={thread.id}
              className="flex items-center gap-1.5 font-medium text-success"
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
              />
              <span className="truncate">
                {thread.presetName}{" "}
                {thread.liveStatus === "starting" ? "starting" : "working"}
              </span>
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">none active</span>
        )}
      </div>
    </aside>
  );
}

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-0.5 text-xs text-foreground hover:border-input";

export function InlineProperties({
  task,
  labels,
  presets,
  onUpdate,
  onError,
  className,
}: Omit<TaskPropertiesProps, "project" | "threads"> & {
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  className?: string;
}) {
  const taskLabels = (labels ?? []).filter((label) =>
    task.labelIds.includes(label.id),
  );
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <StatusMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={CHIP_CLASS}
      />
      <PriorityMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={CHIP_CLASS}
      />
      <DueDateMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={CHIP_CLASS}
      />
      {taskLabels.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
      <LabelsMenu task={task} labels={labels} onUpdate={onUpdate}>
        <button
          type="button"
          aria-label="Edit labels"
          className="inline-flex items-center rounded-md border border-dashed border-border px-2 py-1 text-muted-foreground hover:border-input hover:text-foreground"
        >
          <Icon name="Plus" className="size-3" />
        </button>
      </LabelsMenu>
      <DispatchControl
        taskId={task.id}
        presets={presets}
        onError={onError}
        className="ml-auto max-w-56"
      />
    </div>
  );
}
