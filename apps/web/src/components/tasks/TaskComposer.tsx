import { type FormEvent, type KeyboardEvent } from "react"
import { CornerDownLeft, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface TaskComposerProps {
  titleInputId?: string
  title: string
  description: string
  onTitleChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onSubmit: () => void
  isSubmitting?: boolean
  submitDisabled?: boolean
  submitTitle?: string
  autoFocusTitle?: boolean
  className?: string
}

export function TaskComposer({
  titleInputId,
  title,
  description,
  onTitleChange,
  onDescriptionChange,
  onSubmit,
  isSubmitting = false,
  submitDisabled = false,
  submitTitle = "Create task (Enter)",
  autoFocusTitle = false,
  className,
}: TaskComposerProps) {
  const canSubmit = title.trim().length > 0 && !isSubmitting && !submitDisabled

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    onSubmit()
  }

  const handleDescriptionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
      <div className="border-b border-border/60 px-4 pb-2 pt-3">
        <label
          htmlFor={titleInputId}
          className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
        >
          Title
        </label>
        <input
          id={titleInputId}
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="Describe the task outcome"
          autoFocus={autoFocusTitle}
          className="mt-1 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="px-4 pb-1 pt-2">
        <label
          htmlFor={`${titleInputId ?? "task-composer"}-description`}
          className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
        >
          Description (optional)
        </label>
        <textarea
          id={`${titleInputId ?? "task-composer"}-description`}
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          onKeyDown={handleDescriptionKeyDown}
          rows={3}
          placeholder="Add context, constraints, or acceptance criteria"
          className="mt-1 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex items-center justify-between gap-3 px-3.5 pt-1.5">
        <p className="text-xs text-muted-foreground">
          Create a task for this project.
        </p>
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
    </form>
  )
}
