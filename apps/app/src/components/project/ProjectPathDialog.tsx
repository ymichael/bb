import { useEffect, useId, useState, type FormEvent } from "react";
import {
  deriveProjectNameFromPath,
  getProjectPathValidationMessage,
  normalizeProjectPathInput,
} from "@bb/domain";
import type { HostPlatform } from "@bb/host-daemon-contract";
import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";
import { Input } from "@/components/ui";

export type ProjectPathDialogTarget =
  | {
      kind: "create";
    }
  | {
      kind: "update";
      projectId: string;
      projectName: string;
      currentPath: string;
    }
  | {
      kind: "add-source";
      projectId: string;
      projectName: string;
    };

export type ProjectPathDialogSubmitHandler = (
  target: ProjectPathDialogTarget,
  path: string,
) => Promise<void> | void;

interface ProjectPathDialogProps {
  target: ProjectPathDialogTarget | null;
  pending?: boolean;
  platform: HostPlatform | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: ProjectPathDialogSubmitHandler;
}

export function ProjectPathDialog({
  target,
  pending = false,
  platform,
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
            platform={platform}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface ProjectPathDialogContentProps {
  target: ProjectPathDialogTarget;
  pending: boolean;
  platform: HostPlatform | null;
  onSubmit: ProjectPathDialogSubmitHandler;
}

interface PlatformCopy {
  description: string;
  placeholder: string;
}

function getDialogTitle(kind: ProjectPathDialogTarget["kind"]): string {
  switch (kind) {
    case "create":
      return "Create project";
    case "update":
      return "Update project path";
    case "add-source":
      return "Add project source";
  }
}

function getDialogSubmitLabel(kind: ProjectPathDialogTarget["kind"]): string {
  switch (kind) {
    case "create":
      return "Create project";
    case "update":
      return "Save path";
    case "add-source":
      return "Add source";
  }
}

function getPlatformCopy(platform: HostPlatform | null): PlatformCopy {
  const placeholder = "/path/to/project";
  if (platform === "wsl") {
    return {
      description:
        "Enter an absolute path to the project folder. Use /mnt/c/... to point at a Windows checkout.",
      placeholder,
    };
  }
  return {
    description: "Enter an absolute path to the project folder.",
    placeholder,
  };
}

function ProjectPathDialogContent({
  target,
  pending,
  platform,
  onSubmit,
}: ProjectPathDialogContentProps) {
  const inputId = useId();
  const [pathValue, setPathValue] = useState(
    target.kind === "update" ? target.currentPath : "",
  );
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  const derivedProjectName = deriveProjectNameFromPath(pathValue);
  const copy = getPlatformCopy(platform);
  const placeholder =
    target.kind === "update"
      ? target.currentPath || copy.placeholder
      : copy.placeholder;

  useEffect(() => {
    setValidationMessage(null);
  }, [pathValue]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    const normalizedPath = normalizeProjectPathInput(pathValue);
    const pathValidationMessage =
      getProjectPathValidationMessage(normalizedPath);
    if (pathValidationMessage) {
      setValidationMessage(pathValidationMessage);
      return;
    }

    if (
      target.kind === "create" &&
      !deriveProjectNameFromPath(normalizedPath)
    ) {
      setValidationMessage("Could not derive a project name from that path.");
      return;
    }

    void onSubmit(target, normalizedPath);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{getDialogTitle(target.kind)}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Input
            id={inputId}
            aria-label="Project path"
            value={pathValue}
            autoFocus
            disabled={pending}
            placeholder={placeholder}
            onChange={(event) => {
              setPathValue(event.target.value);
            }}
          />
          {target.kind === "create" && derivedProjectName ? (
            <p className="text-sm text-muted-foreground">
              Project name:{" "}
              <span className="font-medium text-foreground">
                {derivedProjectName}
              </span>
            </p>
          ) : null}
          {validationMessage ? (
            <p className="text-sm text-destructive">{validationMessage}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {getDialogSubmitLabel(target.kind)}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
