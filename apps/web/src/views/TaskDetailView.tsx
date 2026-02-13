import { useEffect, useMemo, useState } from "react"
import type { TaskCloseReason, TaskStatus, UpdateTaskRequest } from "@beanbag/core"
import { useParams } from "react-router-dom"
import { TaskStatusBadge } from "@/components/shared/TaskStatusBadge"
import { useAssignTask, useTask, useUpdateTask } from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

const STATUS_OPTIONS: TaskStatus[] = ["open", "in_progress", "blocked", "closed"]
const CLOSE_REASON_OPTIONS: TaskCloseReason[] = ["completed", "failed", "canceled"]

function statusLabel(status: TaskStatus): string {
  return status.replace("_", " ")
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

interface TaskDraft {
  title: string
  description: string
  status: TaskStatus
  closeReason: TaskCloseReason
  resultSummary: string
}

function createDraft(
  task: ReturnType<typeof useTask>["data"] | null | undefined
): TaskDraft {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    status: task?.status ?? "open",
    closeReason: task?.closeReason ?? "completed",
    resultSummary: task?.resultSummary ?? "",
  }
}

export function TaskDetailView() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>()
  const { data: task, isLoading, error } = useTask(taskId ?? "")
  const updateTask = useUpdateTask()
  const assignTask = useAssignTask()

  const [draft, setDraft] = useState<TaskDraft>(() => createDraft(null))
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [assignError, setAssignError] = useState<string | null>(null)
  const [assigneeInput, setAssigneeInput] = useState("")

  useEffect(() => {
    setDraft(createDraft(task))
    setUpdateError(null)
    setAssignError(null)
    setAssigneeInput("")
  }, [task?.id])

  const statusOptions = useMemo(
    () => (task?.status === "closed" ? (["closed"] as TaskStatus[]) : STATUS_OPTIONS),
    [task?.status]
  )

  if (!projectId || !taskId) {
    return <p className="py-12 text-center text-sm text-destructive">Not found</p>
  }

  if (isLoading) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Loading task...
      </p>
    )
  }

  if (error || !task || task.projectId !== projectId) {
    return (
      <p className="py-12 text-center text-sm text-destructive">
        {error ? error.message : "Not found"}
      </p>
    )
  }

  const saveTask = async () => {
    if (updateTask.isPending) return
    const nextTitle = draft.title.trim()
    if (!nextTitle) {
      setUpdateError("Title is required.")
      return
    }

    const req: UpdateTaskRequest = {}
    if (nextTitle !== task.title) req.title = nextTitle

    const currentDescription = task.description ?? ""
    if (draft.description !== currentDescription) {
      req.description = draft.description
    }

    if (draft.status !== task.status) {
      req.status = draft.status
    }

    if (draft.status === "closed") {
      if (
        draft.closeReason !== task.closeReason ||
        req.status === "closed"
      ) {
        req.closeReason = draft.closeReason
      }
    }

    const currentSummary = task.resultSummary ?? ""
    if (draft.resultSummary !== currentSummary) {
      req.resultSummary = draft.resultSummary
    }

    if (Object.keys(req).length === 0) return

    setUpdateError(null)
    try {
      const updated = await updateTask.mutateAsync({ id: task.id, req })
      setDraft(createDraft(updated))
    } catch (submitError) {
      setUpdateError(
        submitError instanceof Error ? submitError.message : "Unable to save task updates."
      )
    }
  }

  const assignTaskToActor = async () => {
    if (assignTask.isPending) return
    const assignee = assigneeInput.trim()
    if (!assignee) {
      setAssignError("Assignee is required.")
      return
    }

    setAssignError(null)
    try {
      await assignTask.mutateAsync({ id: task.id, assignee })
      setAssigneeInput("")
    } catch (submitError) {
      setAssignError(
        submitError instanceof Error ? submitError.message : "Unable to assign task."
      )
    }
  }

  return (
    <div className="mx-auto w-full max-w-[860px]">
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Task details</CardTitle>
              <CardDescription>Task {task.id.slice(0, 8)}</CardDescription>
            </div>
            <TaskStatusBadge status={task.status} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm sm:col-span-2">
              <span className="text-muted-foreground">Title</span>
              <Input
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </label>

            <label className="space-y-1 text-sm sm:col-span-2">
              <span className="text-muted-foreground">Description</span>
              <Textarea
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
                placeholder="No description provided."
                className="min-h-24"
              />
            </label>

            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Status</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={draft.status}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    status: event.target.value as TaskStatus,
                  }))
                }
              >
                {statusOptions.map((option) => (
                  <option key={option} value={option}>
                    {statusLabel(option)}
                  </option>
                ))}
              </select>
            </label>

            {draft.status === "closed" ? (
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Close reason</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.closeReason}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      closeReason: event.target.value as TaskCloseReason,
                    }))
                  }
                >
                  {CLOSE_REASON_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="space-y-1 text-sm sm:col-span-2">
              <span className="text-muted-foreground">Result summary</span>
              <Textarea
                value={draft.resultSummary}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    resultSummary: event.target.value,
                  }))
                }
                placeholder="Summarize progress or completion details"
                className="min-h-24"
              />
            </label>
          </div>

          <div className="rounded-md border border-border/80 bg-muted/20 p-3 text-xs text-muted-foreground">
            <p>Created: {formatDate(task.createdAt)}</p>
            <p>Updated: {formatDate(task.updatedAt)}</p>
            {task.closedAt ? <p>Closed: {formatDate(task.closedAt)}</p> : null}
          </div>

          <div className="flex items-center justify-end">
            <Button
              onClick={() => {
                void saveTask()
              }}
              disabled={updateTask.isPending}
            >
              {updateTask.isPending ? "Saving..." : "Save task"}
            </Button>
          </div>
          {updateError ? <p className="text-sm text-destructive">{updateError}</p> : null}

          <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
            <p className="text-sm font-medium">Assignment</p>
            <p className="text-xs text-muted-foreground">
              Current assignee: {task.assignee || "none"}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={assigneeInput}
                onChange={(event) => {
                  setAssigneeInput(event.target.value)
                  if (assignError) setAssignError(null)
                }}
                placeholder="Assignee identity"
              />
              <Button
                variant="outline"
                onClick={() => {
                  void assignTaskToActor()
                }}
                disabled={assignTask.isPending || task.status === "closed"}
              >
                {assignTask.isPending ? "Assigning..." : "Assign"}
              </Button>
            </div>
            {assignError ? <p className="text-sm text-destructive">{assignError}</p> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
