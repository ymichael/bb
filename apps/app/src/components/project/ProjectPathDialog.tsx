import { useEffect, useId, useState, type FormEvent } from "react"
import { FolderOpen } from "lucide-react"
import {
  deriveProjectNameFromPath,
  getProjectPathValidationMessage,
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

export type ProjectPathDialogFolderPicker = (() => Promise<string | null>) | null
export type ProjectPathDialogSubmitHandler = (
  target: ProjectPathDialogTarget,
  path: string,
) => Promise<void> | void

interface ProjectPathDialogProps {
  target: ProjectPathDialogTarget | null
  pending?: boolean
  pickFolder: ProjectPathDialogFolderPicker
  onOpenChange: (open: boolean) => void
  onSubmit: ProjectPathDialogSubmitHandler
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
  pickFolder: ProjectPathDialogFolderPicker
  onSubmit: ProjectPathDialogSubmitHandler
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
  const showNativePickerButton = pickFolder != null

  useEffect(() => {
    if (validationMessage) {
      setValidationMessage(null)
    }
  }, [pathValue])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return

    const normalizedPath = normalizeProjectPathInput(pathValue)
    const pathValidationMessage = getProjectPathValidationMessage(normalizedPath)
    if (pathValidationMessage) {
      setValidationMessage(pathValidationMessage)
      return
    }

    if (target.kind === "create" && !deriveProjectNameFromPath(normalizedPath)) {
      setValidationMessage("Could not derive a project name from that path.")
      return
    }

    void onSubmit(target, normalizedPath)
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
          Enter a Linux or WSL absolute path to the project folder. You can
          also use the native folder picker when it is available on this host.
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
