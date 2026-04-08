import { useEffect, useId, useState, type FormEvent } from "react"
import { FolderOpen } from "lucide-react"
import {
  deriveProjectNameFromPath,
  isAbsoluteProjectPath,
  normalizeProjectPathInput,
} from "@bb/domain"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export type ProjectPathDialogTarget =
  | {
      kind: "create"
    }
  | {
      kind: "update"
      projectId: string
      projectName: string
      currentPath: string
    }

interface ProjectPathDialogProps {
  target: ProjectPathDialogTarget | null
  pending?: boolean
  pickFolder: (() => Promise<string | null>) | null
  onOpenChange: (open: boolean) => void
  onSubmit: (target: ProjectPathDialogTarget, path: string) => void
}

export function ProjectPathDialog({
  target,
  pending = false,
  pickFolder,
  onOpenChange,
  onSubmit,
}: ProjectPathDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <ProjectPathDialogContent
            key={target.kind === "create" ? "create" : target.projectId}
            target={target}
            pending={pending}
            pickFolder={pickFolder}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface ProjectPathDialogContentProps {
  target: ProjectPathDialogTarget
  pending: boolean
  pickFolder: (() => Promise<string | null>) | null
  onSubmit: (target: ProjectPathDialogTarget, path: string) => void
}

function ProjectPathDialogContent({
  target,
  pending,
  pickFolder,
  onSubmit,
}: ProjectPathDialogContentProps) {
  const inputId = useId()
  const [pathValue, setPathValue] = useState(
    target.kind === "update" ? target.currentPath : "",
  )
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  const derivedProjectName = deriveProjectNameFromPath(pathValue)
  const showNativePickerButton = (
    pickFolder != null
    && typeof navigator !== "undefined"
    && /Mac/i.test(navigator.platform)
  )

  useEffect(() => {
    if (validationMessage) {
      setValidationMessage(null)
    }
  }, [pathValue, validationMessage])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return

    const normalizedPath = normalizeProjectPathInput(pathValue)
    if (!isAbsoluteProjectPath(normalizedPath)) {
      setValidationMessage("Project path must be an absolute path.")
      return
    }

    if (target.kind === "create" && !deriveProjectNameFromPath(normalizedPath)) {
      setValidationMessage("Could not derive a project name from that path.")
      return
    }

    onSubmit(target, normalizedPath)
  }

  const handleChooseFolder = async () => {
    if (pending || !pickFolder) return

    const selectedPath = await pickFolder()
    if (!selectedPath) return
    setPathValue(normalizeProjectPathInput(selectedPath))
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {target.kind === "create" ? "Create project" : "Update project path"}
        </DialogTitle>
        <DialogDescription>
          Enter an absolute path to the project folder. You can also use the
          native folder picker when it is available on this host.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Input
            id={inputId}
            aria-label="Project path"
            value={pathValue}
            autoFocus
            disabled={pending}
            placeholder={target.kind === "create" ? "/srv/repos/bb" : target.currentPath || "/srv/repos/bb"}
            onChange={(event) => {
              setPathValue(event.target.value)
            }}
          />
          {target.kind === "create" && derivedProjectName ? (
            <p className="text-sm text-muted-foreground">
              Project name: <span className="font-medium text-foreground">{derivedProjectName}</span>
            </p>
          ) : null}
          {validationMessage ? (
            <p className="text-sm text-destructive">{validationMessage}</p>
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <div>
            {showNativePickerButton ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  void handleChooseFolder()
                }}
              >
                <FolderOpen />
                Choose folder
              </Button>
            ) : null}
          </div>
          <Button type="submit" disabled={pending}>
            {target.kind === "create" ? "Create project" : "Save path"}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}
