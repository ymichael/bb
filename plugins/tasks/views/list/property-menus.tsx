import type { ReactNode } from "react";
import {
  TASK_STATUSES,
  type Label,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import type { TaskEdit } from "./optimistic.js";
import { PriorityIcon, StatusIcon } from "./icons.js";
import {
  DUE_DATE_PRESETS,
  formatDueDate,
  localIsoDate,
  PRIORITY_LABELS,
  STATUS_LABELS,
} from "./lib.js";

export type EditFn = (task: Task, patch: TaskEdit) => void;

export const PRIORITY_MENU_ORDER: readonly TaskPriority[] = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
];

export function statusForShortcut(key: string): TaskStatus | null {
  if (!/^[0-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  return index >= 0 && index < TASK_STATUSES.length
    ? (TASK_STATUSES[index] ?? null)
    : null;
}

export function priorityForShortcut(key: string): TaskPriority | null {
  if (!/^[0-9]$/.test(key)) return null;
  const index = Number(key);
  return index >= 0 && index < PRIORITY_MENU_ORDER.length
    ? (PRIORITY_MENU_ORDER[index] ?? null)
    : null;
}

export function isBareKey(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

function MenuHeading({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <DropdownMenuLabel className="flex items-center gap-2">
      <span className="flex-1">{label}</span>
      {}
      <span className="w-3 text-right text-2xs tabular-nums text-subtle-foreground">
        {shortcut}
      </span>
    </DropdownMenuLabel>
  );
}

function PickerOption({
  icon,
  label,
  active,
  shortcut,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  shortcut: number;
}) {
  return (
    <>
      <span className="flex flex-1 items-center gap-2">
        {icon}
        {label}
        {active ? <span className="sr-only"> (current)</span> : null}
      </span>
      <span
        aria-hidden
        className="flex w-4 items-center justify-center text-subtle-foreground"
      >
        {active ? <Icon name="Check" className="size-3.5" /> : null}
      </span>
      <span
        aria-hidden
        className="w-3 text-right text-2xs tabular-nums text-subtle-foreground"
      >
        {shortcut}
      </span>
    </>
  );
}

const TRIGGER_CLASS =
  "relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-state-active focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-active max-md:pointer-coarse:size-8";

export function StatusEditor({
  task,
  onEdit,
  open,
  onOpenChange,
  className,
}: {
  task: Task;
  onEdit: EditFn;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const select = (status: TaskStatus) => {
    if (status !== task.status) onEdit(task, { status });
  };
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Change status, currently ${STATUS_LABELS[task.status]}`}
          className={cn(TRIGGER_CLASS, className)}
        >
          <StatusIcon status={task.status} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-56"
        mobileTitle="Change status"
        onKeyDown={(event) => {
          const status = statusForShortcut(event.key);
          if (status !== null && isBareKey(event)) {
            event.preventDefault();
            select(status);
            onOpenChange(false);
          }
        }}
      >
        <MenuHeading label="Change status…" shortcut="S" />
        {TASK_STATUSES.map((status, index) => (
          <DropdownMenuItem
            key={status}
            aria-current={status === task.status ? "true" : undefined}
            onSelect={() => select(status)}
          >
            <PickerOption
              icon={<StatusIcon status={status} />}
              label={STATUS_LABELS[status]}
              active={status === task.status}
              shortcut={index + 1}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PriorityEditor({
  task,
  onEdit,
  open,
  onOpenChange,
  className,
}: {
  task: Task;
  onEdit: EditFn;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const select = (priority: TaskPriority) => {
    if (priority !== task.priority) onEdit(task, { priority });
  };
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Set priority, currently ${PRIORITY_LABELS[task.priority]}`}
          className={cn(TRIGGER_CLASS, className)}
        >
          <PriorityIcon priority={task.priority} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-52"
        mobileTitle="Set priority"
        onKeyDown={(event) => {
          const priority = priorityForShortcut(event.key);
          if (priority !== null && isBareKey(event)) {
            event.preventDefault();
            select(priority);
            onOpenChange(false);
          }
        }}
      >
        <MenuHeading label="Set priority to…" shortcut="P" />
        {PRIORITY_MENU_ORDER.map((priority, index) => (
          <DropdownMenuItem
            key={priority}
            aria-current={priority === task.priority ? "true" : undefined}
            onSelect={() => select(priority)}
          >
            <PickerOption
              icon={<PriorityIcon priority={priority} />}
              label={PRIORITY_LABELS[priority]}
              active={priority === task.priority}
              shortcut={index}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TaskContextMenu({
  task,
  onEdit,
  projectLabels,
  children,
}: {
  task: Task;
  onEdit: EditFn;
  projectLabels: readonly Label[];
  children: ReactNode;
}) {
  const toggleLabel = (labelId: string) => {
    const labelIds = task.labelIds.includes(labelId)
      ? task.labelIds.filter((id) => id !== labelId)
      : [...task.labelIds, labelId];
    onEdit(task, { labelIds });
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <StatusIcon status={task.status} />
            <span>Status</span>
            <ContextMenuShortcut>S</ContextMenuShortcut>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-48">
            {TASK_STATUSES.map((status) => (
              <ContextMenuItem
                key={status}
                aria-current={status === task.status ? "true" : undefined}
                onSelect={() => {
                  if (status !== task.status) onEdit(task, { status });
                }}
              >
                <span className="flex flex-1 items-center gap-2">
                  <StatusIcon status={status} />
                  {STATUS_LABELS[status]}
                  {status === task.status ? (
                    <span className="sr-only"> (current)</span>
                  ) : null}
                </span>
                {status === task.status ? (
                  <Icon name="Check" aria-hidden className="size-3.5" />
                ) : null}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <PriorityIcon priority={task.priority} />
            <span>Priority</span>
            <ContextMenuShortcut>P</ContextMenuShortcut>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-44">
            {PRIORITY_MENU_ORDER.map((priority) => (
              <ContextMenuItem
                key={priority}
                aria-current={priority === task.priority ? "true" : undefined}
                onSelect={() => {
                  if (priority !== task.priority) onEdit(task, { priority });
                }}
              >
                <span className="flex flex-1 items-center gap-2">
                  <PriorityIcon priority={priority} />
                  {PRIORITY_LABELS[priority]}
                  {priority === task.priority ? (
                    <span className="sr-only"> (current)</span>
                  ) : null}
                </span>
                {priority === task.priority ? (
                  <Icon name="Check" aria-hidden className="size-3.5" />
                ) : null}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Icon name="Clock" className="size-3.5" />
            <span>Due date</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-44">
            {DUE_DATE_PRESETS.map(([label, days]) => {
              const value = localIsoDate(days);
              return (
                <ContextMenuItem
                  key={label}
                  onSelect={() => onEdit(task, { dueDate: value })}
                >
                  <span>{label}</span>
                  <span className="ml-auto text-2xs text-subtle-foreground">
                    {formatDueDate(value)}
                  </span>
                </ContextMenuItem>
              );
            })}
            {task.dueDate !== null ? (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => onEdit(task, { dueDate: null })}
                >
                  <Icon name="X" className="size-3.5" />
                  <span>No due date</span>
                </ContextMenuItem>
              </>
            ) : null}
          </ContextMenuSubContent>
        </ContextMenuSub>

        {projectLabels.length > 0 ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Icon name="ListTodo" className="size-3.5" />
              <span>Labels</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-48">
              {projectLabels.map((label) => (
                <ContextMenuCheckboxItem
                  key={label.id}
                  checked={task.labelIds.includes(label.id)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggleLabel(label.id)}
                >
                  <span
                    aria-hidden
                    className="mr-2 size-2 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  {label.name}
                </ContextMenuCheckboxItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
