import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  getProjectPathValidationMessage,
  normalizeProjectPathInput,
  type ProjectSource,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { RemotePathBrowser } from "@/components/dialogs/RemotePathBrowser";
import { useAddProjectSource } from "@/hooks/mutations/project-mutations";
import {
  isHostPathMissing,
  useHostPathExistence,
} from "@/hooks/queries/host-path-queries";
import { useHostCloneDefaultPath } from "@/hooks/queries/host-queries";
import { BbHttpError } from "@bb/sdk/browser";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

export interface ProjectMachineSetupDialogTarget {
  projectId: string;
  projectName: string;
  gitRemoteUrl: string | null;
  hostId: string;
  hostName: string;
}

export interface ProjectMachineSetupCompletion {
  hostId: string;
  source: ProjectSource;
}

interface ProjectMachineSetupDialogProps {
  target: ProjectMachineSetupDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onComplete: (completion: ProjectMachineSetupCompletion) => void;
}

export function ProjectMachineSetupDialog({
  target,
  onOpenChange,
  onComplete,
}: ProjectMachineSetupDialogProps) {
  const addSource = useAddProjectSource();
  const targetKey = target ? `${target.projectId}:${target.hostId}` : null;
  const resetAddSource = addSource.reset;
  useEffect(() => {
    resetAddSource();
  }, [resetAddSource, targetKey]);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && addSource.isPending) return;
        onOpenChange(open);
      }}
    >
      <DialogContent>
        {target ? (
          <ProjectMachineSetupDialogContent
            key={targetKey}
            target={target}
            addSource={addSource}
            onOpenChange={onOpenChange}
            onComplete={onComplete}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type SetupOption = "clone" | "folder";

interface ProjectMachineSetupDialogContentProps {
  target: ProjectMachineSetupDialogTarget;
  addSource: ReturnType<typeof useAddProjectSource>;
  onOpenChange: (open: boolean) => void;
  onComplete: (completion: ProjectMachineSetupCompletion) => void;
}

function ProjectMachineSetupDialogContent({
  target,
  addSource,
  onOpenChange,
  onComplete,
}: ProjectMachineSetupDialogContentProps) {
  const hasRemote = target.gitRemoteUrl !== null;
  const [option, setOption] = useState<SetupOption>(
    hasRemote ? "clone" : "folder",
  );
  const [customClonePath, setCustomClonePath] = useState<string | null>(null);
  const [isEditingClonePath, setIsEditingClonePath] = useState(false);
  const [clonePathDraft, setClonePathDraft] = useState("");
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const defaultClonePathQuery = useHostCloneDefaultPath(
    target.hostId,
    target.projectId,
    { enabled: hasRemote },
  );
  const clonePath = customClonePath ?? defaultClonePathQuery.data ?? null;

  const folderExistence = useHostPathExistence(
    option === "folder" ? target.hostId : null,
    folderPath !== null ? [folderPath] : [],
  );

  const pending = addSource.isPending;

  const selectOption = (nextOption: SetupOption) => {
    if (pending || option === nextOption) return;
    setOption(nextOption);
    setValidationMessage(null);
    setIsEditingClonePath(false);
    addSource.reset();
  };

  const commitClonePathEdit = () => {
    setIsEditingClonePath(false);
    const normalized = normalizeProjectPathInput(clonePathDraft);
    if (!normalized) return;
    setCustomClonePath(normalized);
    setValidationMessage(null);
    addSource.reset();
  };

  const submit = (request: Parameters<typeof addSource.mutate>[0]) => {
    addSource.mutate(request, {
      onSuccess: (source) => {
        onComplete({ hostId: target.hostId, source });
      },
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setValidationMessage(null);

    if (option === "clone") {
      if (customClonePath !== null) {
        const pathValidationMessage =
          getProjectPathValidationMessage(customClonePath);
        if (pathValidationMessage) {
          setValidationMessage(pathValidationMessage);
          return;
        }
      }
      submit({
        projectId: target.projectId,
        request: {
          type: "clone",
          hostId: target.hostId,
          ...(customClonePath !== null ? { targetPath: customClonePath } : {}),
        },
      });
      return;
    }

    if (folderPath === null) {
      setValidationMessage("Choose a folder.");
      return;
    }
    if (isHostPathMissing(folderExistence, folderPath)) {
      setValidationMessage(
        `That folder no longer exists on ${target.hostName}.`,
      );
      return;
    }
    submit({
      projectId: target.projectId,
      request: { type: "local_path", hostId: target.hostId, path: folderPath },
    });
  };

  const errorMessage = addSource.isError
    ? getMutationErrorMessage({
        error: addSource.error,
        fallbackMessage: `Couldn't set up ${target.projectName} on ${target.hostName}.`,
      })
    : null;
  const isTargetNotEmptyError =
    addSource.error instanceof BbHttpError &&
    addSource.error.code === "target_not_empty";

  const submitDisabled =
    pending || (option === "clone" ? clonePath === null : folderPath === null);

  const cloneDestination: ReactNode = isEditingClonePath ? (
    <div className="flex items-center gap-1">
      <Input
        aria-label="Clone destination"
        className="h-7 flex-1 text-xs"
        value={clonePathDraft}
        disabled={pending}
        autoFocus
        placeholder={defaultClonePathQuery.data ?? "/path/to/checkout"}
        onChange={(event) => setClonePathDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitClonePathEdit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setIsEditingClonePath(false);
          }
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Use this destination"
        disabled={pending}
        onClick={commitClonePathEdit}
      >
        <Icon name="Check" />
      </Button>
    </div>
  ) : (
    <p className="break-all text-xs text-muted-foreground">
      into <span className="text-foreground">{clonePath ?? "…"}</span>{" "}
      <button
        type="button"
        className="text-primary hover:underline disabled:opacity-50"
        disabled={pending}
        onClick={() => {
          setClonePathDraft(clonePath ?? "");
          setIsEditingClonePath(true);
        }}
      >
        change
      </button>
    </p>
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Set up {target.projectName} on {target.hostName}
        </DialogTitle>
        <DialogDescription>
          {hasRemote
            ? `${target.hostName} doesn't have this project yet. Pick how to get it there — this happens once.`
            : `${target.hostName} doesn't have this project yet. Point at the project folder on ${target.hostName} — this happens once.`}
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        {hasRemote ? (
          <div
            role="radiogroup"
            aria-label="Setup method"
            className="flex flex-col gap-2"
          >
            <SetupOptionCard
              selected={option === "clone"}
              disabled={pending}
              onSelect={() => selectOption("clone")}
              title="Clone from the project remote"
            >
              <p className="break-all text-xs text-muted-foreground">
                {target.gitRemoteUrl}
              </p>
              {option === "clone" ? cloneDestination : null}
            </SetupOptionCard>
            <SetupOptionCard
              selected={option === "folder"}
              disabled={pending}
              onSelect={() => selectOption("folder")}
              title={`Use an existing folder on ${target.hostName}`}
            >
              <p className="text-xs text-muted-foreground">
                Browse {target.hostName}'s files and point at a checkout you
                already have.
              </p>
            </SetupOptionCard>
          </div>
        ) : null}
        {option === "folder" ? (
          <RemotePathBrowser
            hostId={target.hostId}
            allowCreateFolder={false}
            onDirectoryChange={(directory) => {
              setFolderPath(directory);
              setValidationMessage(null);
            }}
            disabled={pending}
          />
        ) : null}
        {pending && option === "clone" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon name="Spinner" className="size-4 shrink-0 animate-spin" />
            Cloning onto {target.hostName}… This can take a while.
          </p>
        ) : null}
        {validationMessage ? (
          <p className="text-sm text-destructive">{validationMessage}</p>
        ) : null}
        {errorMessage ? (
          <div className="space-y-1">
            <p className="whitespace-pre-wrap break-words text-sm text-destructive">
              {errorMessage}
            </p>
            {isTargetNotEmptyError ? (
              <p className="text-sm text-muted-foreground">
                Pick a different destination, or use the existing-folder option
                to point at what's already there.
              </p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitDisabled}>
            {option === "clone" ? "Clone & continue" : "Use folder & continue"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

interface SetupOptionCardProps {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  title: string;
  children: ReactNode;
}

function SetupOptionCard({
  selected,
  disabled,
  onSelect,
  title,
  children,
}: SetupOptionCardProps) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-label={title}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        "flex items-start gap-3 rounded-md border p-3",
        selected ? "border-primary" : "border-border",
        !disabled && "cursor-pointer",
      )}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary" : "border-muted-foreground",
        )}
      >
        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}
