import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useState } from "react"
import { CornerDownLeft, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { TaskAssigneeSelector } from "./TaskAssigneeSelector"

interface TaskComposerProps {
  titleInputId?: string
  title: string
  description: string
  onTitleChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  assignee: string
  onAssigneeChange: (value: string) => void
  onSubmit: () => void
  isSubmitting?: boolean
  submitDisabled?: boolean
  submitTitle?: string
  autoFocusTitle?: boolean
  className?: string
}

const TASK_COMPOSER_MIN_HEIGHT = 68
const TASK_COMPOSER_MAX_HEIGHT = 158

function parseTaskBody(value: string): { title: string; description: string } {
  const newlineIndex = value.indexOf("\n")
  if (newlineIndex === -1) {
    return { title: value, description: "" }
  }

  return {
    title: value.slice(0, newlineIndex),
    description: value.slice(newlineIndex + 1),
  }
}

function composeTaskBody(title: string, description: string): string {
  return description.length > 0 ? `${title}\n${description}` : title
}

export function TaskComposer({
  titleInputId,
  title,
  description,
  onTitleChange,
  onDescriptionChange,
  assignee,
  onAssigneeChange,
  onSubmit,
  isSubmitting = false,
  submitDisabled = false,
  submitTitle = "Create task (Enter)",
  autoFocusTitle = false,
  className,
}: TaskComposerProps) {
  const [body, setBody] = useState(() => composeTaskBody(title, description))
  const parsedBody = useMemo(() => parseTaskBody(body), [body])
  const canSubmit =
    parsedBody.title.trim().length > 0 && !isSubmitting && !submitDisabled

  useEffect(() => {
    if (parsedBody.title === title && parsedBody.description === description) {
      return
    }
    setBody(composeTaskBody(title, description))
  }, [title, description, parsedBody.title, parsedBody.description])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    onSubmit()
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    if (!canSubmit) return
    onSubmit()
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        "w-full rounded-lg border border-input bg-background pb-2",
        className
      )}
    >
      <textarea
        id={titleInputId}
        value={body}
        onChange={(event) => {
          const next = event.target.value
          setBody(next)
          const parsed = parseTaskBody(next)
          onTitleChange(parsed.title)
          onDescriptionChange(parsed.description)
        }}
        onKeyDown={handleComposerKeyDown}
        rows={1}
        placeholder="Describe the task. Use multiple lines to include additional description."
        autoFocus={autoFocusTitle}
        className="w-full resize-none overflow-y-auto bg-transparent px-4 pt-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60"
        style={{
          minHeight: `${TASK_COMPOSER_MIN_HEIGHT}px`,
          maxHeight: `${TASK_COMPOSER_MAX_HEIGHT}px`,
        }}
      />
      <div className="flex flex-row items-center gap-3 px-4 pt-1.5">
        <div className="flex min-w-0 flex-1 flex-row items-center gap-1">
          <TaskAssigneeSelector
            value={assignee}
            onChange={onAssigneeChange}
            className="h-auto px-0 text-xs text-muted-foreground/75 hover:text-foreground"
          />
        </div>
        <div className="flex shrink-0 flex-row items-center gap-1">
          <Button
            type="submit"
            size="icon"
            variant="default"
            title={submitTitle}
            disabled={!canSubmit}
            className="size-auto h-8 px-2 transition-all"
          >
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CornerDownLeft className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </form>
  )
}
