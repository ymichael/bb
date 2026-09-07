import { useEffect, useMemo, useRef, useState } from "react";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import { uploadAttachment } from "../detail/attachments.js";
import {
  AttachmentChip,
  stageFiles,
  type StagedAttachment,
} from "../../components/staged-attachments.js";
import {
  listAllTasks,
  useProjects,
  useTasksQuery,
  useTasksRpc,
} from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@bb/shared-ui/command";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { CheckboxField, DEFAULT_COLOR } from "./shared.js";
import { PRIORITY_LABELS, STATUS_LABELS } from "../list/lib.js";

const CHIP_TRIGGER =
  "h-7 w-auto gap-1.5 rounded-md px-2 text-xs text-muted-foreground";

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  defaultStatus?: TaskStatus;
  defaultParentTaskId?: string;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  projectId,
  defaultStatus,
  defaultParentTaskId,
}: NewTaskDialogProps) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const projects = useProjects();
  const subtaskMode = defaultParentTaskId !== undefined;

  const [selectedProjectId, setSelectedProjectId] = useState(projectId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>(defaultStatus ?? "todo");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
  const [parentTaskId, setParentTaskId] = useState<string | null>(
    defaultParentTaskId ?? null,
  );
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelQuery, setLabelQuery] = useState("");
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<StagedAttachment[]>([]);
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedProjectId(projectId);
    setTitle("");
    setDescription("");
    setStatus(defaultStatus ?? "todo");
    setPriority("none");
    setLabelIds([]);
    setDueDate("");
    setParentTaskId(defaultParentTaskId ?? null);
    setLabelQuery("");
    setPendingFiles([]);
    setCreatedTask(null);
    setError(null);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [open]);

  const projectList = projects.data ?? [];
  const effectiveProjectId =
    selectedProjectId ?? projectId ?? projectList[0]?.id ?? null;
  const project =
    projectList.find((entry) => entry.id === effectiveProjectId) ?? null;

  const labels = useTasksQuery(
    async (rpc) =>
      effectiveProjectId
        ? (await rpc.call("listLabels", { projectId: effectiveProjectId }))
            .labels
        : [],
    ["projects:changed"],
    [effectiveProjectId],
  );
  const parentCandidates = useTasksQuery(
    async (rpc) =>
      effectiveProjectId && subtaskMode
        ? listAllTasks(rpc, {
            projectId: effectiveProjectId,
            parentTaskId: null,
          })
        : [],
    ["tasks:changed"],
    [effectiveProjectId, subtaskMode],
  );
  const parentTask =
    (parentCandidates.data ?? []).find((task) => task.id === parentTaskId) ??
    null;

  const changeProject = (id: string) => {
    setSelectedProjectId(id);
    setLabelIds([]);
    if (!subtaskMode) setParentTaskId(null);
  };

  const toggleLabel = (labelId: string) =>
    setLabelIds((current) =>
      current.includes(labelId)
        ? current.filter((id) => id !== labelId)
        : [...current, labelId],
    );

  const createLabelFromQuery = async () => {
    const name = labelQuery.trim();
    if (!name || effectiveProjectId === null || creatingLabel) return;
    setCreatingLabel(true);
    try {
      const { label } = await rpc.call("createLabel", {
        projectId: effectiveProjectId,
        name,
        color: DEFAULT_COLOR,
      });
      labels.refresh();
      setLabelIds((current) => [...current, label.id]);
      setLabelQuery("");
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : String(createError),
      );
    } finally {
      setCreatingLabel(false);
    }
  };

  const stageMore = (files: File[]) => {
    if (files.length === 0 || submitting || createdTask !== null) return;
    setPendingFiles((current) => [...current, ...stageFiles(files)]);
  };

  const removeFile = (id: number) => {
    if (submitting) return;
    setPendingFiles((files) => files.filter((entry) => entry.id !== id));
  };

  const retryingRef = useRef(new Set<number>());
  const retryUpload = async (entry: StagedAttachment) => {
    if (entry.owner === undefined || retryingRef.current.has(entry.id)) return;
    retryingRef.current.add(entry.id);
    setPendingFiles((files) =>
      files.map((candidate) =>
        candidate.id === entry.id ? { ...candidate, busy: true } : candidate,
      ),
    );
    try {
      await uploadAttachment(entry.file, entry.owner);
      setPendingFiles((files) =>
        files.filter((candidate) => candidate.id !== entry.id),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setPendingFiles((files) =>
        files.map((candidate) =>
          candidate.id === entry.id
            ? { ...candidate, busy: false, error: message }
            : candidate,
        ),
      );
    } finally {
      retryingRef.current.delete(entry.id);
    }
  };

  const finish = (task: Task) => {
    onOpenChange(false);
    navigation.go({ kind: "task", taskKey: task.key });
  };

  const requestClose = (next: boolean) => {
    if (!next && createdTask !== null && pendingFiles.length > 0) return;
    onOpenChange(next);
  };

  useEffect(() => {
    if (createdTask && pendingFiles.length === 0) finish(createdTask);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [createdTask, pendingFiles.length]);

  const hasOversized = pendingFiles.some(
    (entry) => entry.status === "oversized",
  );
  const canSubmit =
    effectiveProjectId !== null &&
    title.trim().length > 0 &&
    !submitting &&
    !hasOversized &&
    createdTask === null;

  const submit = async () => {
    if (!canSubmit || effectiveProjectId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await rpc.call("createTask", {
        projectId: effectiveProjectId,
        title: title.trim(),
        description,
        status,
        priority,
        dueDate: dueDate === "" ? null : dueDate,
        parentTaskId,
        labelIds,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const staged = pendingFiles.filter((entry) => entry.status === "staged");
      const failed: StagedAttachment[] = [];
      for (const entry of staged) {
        try {
          await uploadAttachment(entry.file, { taskId: result.task.id });
        } catch (cause) {
          failed.push({
            ...entry,
            status: "failed",
            owner: { taskId: result.task.id },
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      if (failed.length > 0) {
        setPendingFiles((files) =>
          files.flatMap((entry) => {
            const failure = failed.find(
              (candidate) => candidate.id === entry.id,
            );
            if (failure) return [failure];
            return staged.some((candidate) => candidate.id === entry.id)
              ? []
              : [entry];
          }),
        );
        setCreatedTask(result.task);
        return;
      }
      if (createMore) {
        setTitle("");
        setDescription("");
        setLabelIds([]);
        setDueDate("");
        setPendingFiles([]);
        titleRef.current?.focus();
      } else {
        finish(result.task);
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const selectedLabels = useMemo(
    () => (labels.data ?? []).filter((label) => labelIds.includes(label.id)),
    [labels.data, labelIds],
  );
  const failedCount = pendingFiles.filter(
    (entry) => entry.status === "failed",
  ).length;

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        className="max-w-xl gap-0 p-0"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        onPaste={(event) => {
          if (event.defaultPrevented || submitting || createdTask !== null)
            return;
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length === 0) return;
          event.preventDefault();
          stageMore(files);
        }}
      >
        <DialogTitle className="flex items-center gap-2 px-4 pt-4 text-xs font-normal text-muted-foreground">
          {project ? (
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-sm"
              style={{ backgroundColor: project.color }}
            />
          ) : null}
          {subtaskMode ? "New sub-task" : "New task"}
          {project ? ` · ${project.name}` : ""}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Create a task with a title, description, attributes, and attachments.
        </DialogDescription>
        {createdTask ? (
          <div className="px-4 pt-2">
            <p role="alert" className="text-sm">
              Task <span className="font-medium">{createdTask.key}</span> was
              created, but {failedCount} attachment
              {failedCount === 1 ? "" : "s"} failed to upload.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Retry the uploads below, remove a file to skip it, or skip them
              all and open the task.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {pendingFiles.map((entry) => (
                <AttachmentChip
                  key={entry.id}
                  entry={entry}
                  onRemove={() => removeFile(entry.id)}
                  onRetry={
                    entry.status === "failed"
                      ? () => void retryUpload(entry)
                      : undefined
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className={cn("px-4 pt-2", createdTask && "hidden")}>
          <input
            ref={titleRef}
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Task title"
            aria-label="Task title"
            className="w-full bg-transparent text-base font-semibold text-foreground outline-none placeholder:text-muted-foreground"
          />
          <TasksEditor
            variant="comment"
            value={description}
            onChange={setDescription}
            placeholder="Description — rich text, round-trips as markdown for agents"
            className="mt-2 min-h-16"
            onAttachFiles={stageMore}
          />
          {pendingFiles.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {pendingFiles.map((entry) => (
                <AttachmentChip
                  key={entry.id}
                  entry={entry}
                  disabled={submitting}
                  onRemove={() => removeFile(entry.id)}
                />
              ))}
            </div>
          ) : null}
          {hasOversized ? (
            <p className="mt-2 text-xs text-destructive">
              Remove attachments over the 25 MB limit before creating the task.
            </p>
          ) : null}
        </div>
        <div
          className={cn(
            "flex flex-wrap items-center gap-1.5 px-4 pt-3",
            createdTask && "hidden",
          )}
        >
          {!subtaskMode ? (
            <Select
              value={effectiveProjectId ?? undefined}
              onValueChange={changeProject}
            >
              <SelectTrigger
                aria-label="Project"
                className={cn(CHIP_TRIGGER, "max-w-44")}
              >
                <SelectValue placeholder="Project" />
              </SelectTrigger>
              <SelectContent>
                {projectList.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 rounded-sm"
                        style={{ backgroundColor: entry.color }}
                      />
                      {entry.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as TaskStatus)}
          >
            <SelectTrigger aria-label="Status" className={CHIP_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {STATUS_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={priority}
            onValueChange={(value) => setPriority(value as TaskPriority)}
          >
            <SelectTrigger aria-label="Priority" className={CHIP_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_PRIORITIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {PRIORITY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(CHIP_TRIGGER, "border-input font-normal")}
              >
                {selectedLabels.length === 0 ? (
                  <>
                    <Icon name="Plus" className="size-3" />
                    Labels
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-0.5">
                      {selectedLabels.slice(0, 3).map((label) => (
                        <span
                          key={label.id}
                          aria-hidden
                          className="size-2 rounded-full"
                          style={{ backgroundColor: label.color }}
                        />
                      ))}
                    </span>
                    {selectedLabels.length === 1
                      ? selectedLabels[0]!.name
                      : `${selectedLabels.length} labels`}
                  </>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-0" align="start">
              <Command>
                <CommandInput
                  placeholder="Add labels…"
                  value={labelQuery}
                  onValueChange={setLabelQuery}
                />
                <CommandList>
                  <CommandEmpty
                    className={
                      labelQuery.trim() !== "" ? "p-1 text-left" : undefined
                    }
                  >
                    {labelQuery.trim() !== "" ? (
                      <button
                        type="button"
                        disabled={creatingLabel}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                        onClick={() => void createLabelFromQuery()}
                      >
                        <Icon name="Plus" className="size-3.5" />
                        Create “{labelQuery.trim()}”
                      </button>
                    ) : (
                      "No labels in this project."
                    )}
                  </CommandEmpty>
                  <CommandGroup>
                    {(labels.data ?? []).map((label) => (
                      <CommandItem
                        key={label.id}
                        value={label.name}
                        onSelect={() => toggleLabel(label.id)}
                      >
                        <span
                          aria-hidden
                          className="size-2.5 rounded-full"
                          style={{ backgroundColor: label.color }}
                        />
                        <span className="flex-1">{label.name}</span>
                        {labelIds.includes(label.id) ? (
                          <Icon name="Check" className="size-3.5" />
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <input
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            aria-label="Due date"
            className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {subtaskMode ? (
            <Popover open={parentPickerOpen} onOpenChange={setParentPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(CHIP_TRIGGER, "border-input font-normal")}
                >
                  <Icon name="CornerDownRight" className="size-3" />
                  {parentTask ? `Sub-task of ${parentTask.key}` : "Parent task"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Choose parent task…" />
                  <CommandList>
                    <CommandEmpty>No tasks in this project.</CommandEmpty>
                    <CommandGroup>
                      {(parentCandidates.data ?? []).map((task) => (
                        <CommandItem
                          key={task.id}
                          value={`${task.key} ${task.title}`}
                          onSelect={() => {
                            setParentTaskId(task.id);
                            setParentPickerOpen(false);
                          }}
                        >
                          <span className="shrink-0 font-medium text-muted-foreground">
                            {task.key}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {task.title}
                          </span>
                          {task.id === parentTaskId ? (
                            <Icon name="Check" className="size-3.5" />
                          ) : null}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="px-4 pt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter className="mt-4 flex-row items-center border-t border-border-hairline px-4 py-3 sm:justify-between">
          {createdTask ? (
            <>
              <span />
              <Button size="sm" onClick={() => finish(createdTask)}>
                Skip attachments and open task
              </Button>
            </>
          ) : (
            <>
              <CheckboxField
                checked={createMore}
                onCheckedChange={setCreateMore}
                label="Create more"
              />
              <div className="flex items-center gap-1.5">
                {}
                <button
                  type="button"
                  title="Attach files"
                  aria-label="Attach files"
                  disabled={submitting}
                  className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Icon name="Paperclip" className="size-4" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  aria-hidden
                  tabIndex={-1}
                  className="hidden"
                  onChange={(event) => {
                    stageMore([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                <Button
                  size="sm"
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                >
                  {subtaskMode ? "Create sub-task" : "Create task"}
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
