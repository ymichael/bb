import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { assertNever, type ThreadWorkStatus } from "@beanbag/agent-core";
import { DetailCard, DetailRow } from "@beanbag/ui-core";
import { WorkspaceChangesList } from "@/components/shared/WorkspaceChangesList";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type ThreadGitActionDialogTarget =
  | { kind: "commit" }
  | { kind: "commit_and_squash_merge" }
  | { kind: "squash_merge" };

interface ThreadGitActionDialogProps {
  target: ThreadGitActionDialogTarget | null;
  pending?: boolean;
  branchName?: string;
  gitStatusLabel?: string;
  gitStatusSummary?: string;
  changedFiles?: ThreadWorkStatus["files"];
  threadId?: string;
  showMergeBaseDetails?: boolean;
  mergeBaseBranch?: string;
  mergeBaseBranchOptions?: string[];
  onMergeBaseBranchChange?: (branch: string) => void;
  onOpenChange: (open: boolean) => void;
  onCommit: (args: { includeUnstaged: boolean }) => Promise<void>;
  onSquashMerge: (args: {
    commitIfNeeded: boolean;
    includeUnstaged: boolean;
    mergeBaseBranch?: string;
  }) => Promise<void>;
}

function getDialogCopy(target: ThreadGitActionDialogTarget) {
  switch (target.kind) {
    case "commit":
      return {
        title: "Commit changes",
        description: "Create a commit from the current workspace changes.",
        submitLabel: "Commit changes",
        showCommitControls: true,
        showMergeBase: false,
      };
    case "commit_and_squash_merge":
      return {
        title: "Commit and squash merge",
        description: "Commit the current workspace changes, then squash merge this thread branch.",
        submitLabel: "Commit + squash merge",
        showCommitControls: true,
        showMergeBase: true,
      };
    case "squash_merge":
      return {
        title: "Squash merge",
        description: "Squash merge this thread branch into the selected merge base.",
        submitLabel: "Squash merge",
        showCommitControls: false,
        showMergeBase: true,
      };
    default:
      return assertNever(target);
  }
}

function MergeBaseBranchPicker({
  value,
  options,
  disabled,
  onChange,
  className,
}: {
  value: string;
  options: readonly string[];
  disabled?: boolean;
  onChange: (branch: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredOptions = useMemo(() => {
    if (normalizedQuery.length === 0) {
      return options;
    }
    return options.filter((branch) => branch.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, options]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-8 w-full min-w-0 justify-between rounded-md border-border/60 bg-background px-2.5 text-sm font-normal shadow-none hover:bg-muted/35",
            className,
          )}
          role="combobox"
          aria-expanded={open}
        >
          <span className="truncate text-left">{value}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={16}
        className="flex max-h-[calc(100vh-6rem)] w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
      >
        <div className="shrink-0 border-b border-border/70 p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search branches"
              className="h-9 border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0"
            />
          </div>
        </div>
        <div
          className="min-h-0 max-h-80 overflow-y-auto overscroll-contain p-1"
          onWheel={(event) => {
            event.stopPropagation();
          }}
        >
          {filteredOptions.length > 0 ? (
            filteredOptions.map((branch) => (
              <button
                key={branch}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                onClick={() => {
                  onChange(branch);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate" title={branch}>
                  {branch}
                </span>
                <Check
                  className={branch === value ? "size-4 shrink-0 opacity-100" : "size-4 shrink-0 opacity-0"}
                />
              </button>
            ))
          ) : (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No branches found.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ThreadGitActionDialog({
  target,
  pending = false,
  branchName,
  gitStatusLabel,
  gitStatusSummary,
  changedFiles,
  threadId,
  showMergeBaseDetails = false,
  mergeBaseBranch,
  mergeBaseBranchOptions,
  onMergeBaseBranchChange,
  onOpenChange,
  onCommit,
  onSquashMerge,
}: ThreadGitActionDialogProps) {
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      setIncludeUnstaged(true);
      setErrorMessage(null);
      return;
    }

    setIncludeUnstaged(true);
    setErrorMessage(null);
  }, [target]);

  const dialogCopy = useMemo(
    () => (target ? getDialogCopy(target) : null),
    [target],
  );
  const mergeBaseCandidates = useMemo(() => {
    const fromProps = mergeBaseBranchOptions ?? [];
    if (!mergeBaseBranch || fromProps.includes(mergeBaseBranch)) {
      return fromProps;
    }
    return [mergeBaseBranch, ...fromProps];
  }, [mergeBaseBranch, mergeBaseBranchOptions]);
  const selectedMergeBaseBranch = mergeBaseBranch ?? mergeBaseCandidates[0];
  const canSelectMergeBase =
    Boolean(dialogCopy?.showMergeBase) &&
    showMergeBaseDetails &&
    Boolean(onMergeBaseBranchChange) &&
    mergeBaseCandidates.length > 0;
  const canShowMergeBase =
    Boolean(dialogCopy?.showMergeBase) &&
    showMergeBaseDetails &&
    (canSelectMergeBase || Boolean(selectedMergeBaseBranch));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || pending) {
      return;
    }
    setErrorMessage(null);

    try {
      switch (target.kind) {
        case "commit":
          await onCommit({
            includeUnstaged,
          });
          break;
        case "commit_and_squash_merge":
          await onSquashMerge({
            commitIfNeeded: true,
            includeUnstaged,
            mergeBaseBranch: selectedMergeBaseBranch,
          });
          break;
        case "squash_merge":
          await onSquashMerge({
            commitIfNeeded: false,
            includeUnstaged: false,
            mergeBaseBranch: selectedMergeBaseBranch,
          });
          break;
        default:
          assertNever(target);
      }
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to start git action",
      );
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        {target && dialogCopy ? (
          <>
            <DialogHeader className="px-6 pt-5 pb-3">
              <DialogTitle>{dialogCopy.title}</DialogTitle>
              <DialogDescription>{dialogCopy.description}</DialogDescription>
            </DialogHeader>
            <form className="space-y-5 px-6 pt-3 pb-5" onSubmit={handleSubmit}>
              {branchName || gitStatusLabel || canShowMergeBase ? (
                <DetailCard className="border-border/70 bg-muted/20">
                  {branchName ? (
                    <DetailRow label="Branch" valueClassName="min-w-0 truncate">
                      <span className="block truncate" title={branchName}>
                        {branchName}
                      </span>
                    </DetailRow>
                  ) : null}
                  {gitStatusLabel ? (
                    <DetailRow label="Git status" valueClassName="min-w-0">
                      <div
                        className="flex min-w-0 items-baseline gap-2 whitespace-nowrap"
                        title={[gitStatusLabel, gitStatusSummary].filter(Boolean).join(" ")}
                      >
                        <span className="shrink-0 font-medium">{gitStatusLabel}</span>
                        {gitStatusSummary ? (
                          <span className="min-w-0 truncate text-muted-foreground">
                            {gitStatusSummary}
                          </span>
                        ) : null}
                      </div>
                    </DetailRow>
                  ) : null}
                  {canShowMergeBase && selectedMergeBaseBranch ? (
                    <DetailRow label="Merge base" valueClassName="min-w-0">
                      {canSelectMergeBase ? (
                        <MergeBaseBranchPicker
                          value={selectedMergeBaseBranch}
                          options={mergeBaseCandidates}
                          disabled={pending}
                          onChange={(branch) => onMergeBaseBranchChange?.(branch)}
                          className="max-w-full"
                        />
                      ) : (
                        <span className="block truncate" title={selectedMergeBaseBranch}>
                          {selectedMergeBaseBranch}
                        </span>
                      )}
                    </DetailRow>
                  ) : null}
                  {dialogCopy.showCommitControls ? (
                    <DetailRow label="Include unstaged" valueClassName="min-w-0">
                      <div className="flex min-w-0 items-center gap-3">
                        <Switch
                          checked={includeUnstaged}
                          disabled={pending}
                          aria-label="Include unstaged changes"
                          onCheckedChange={setIncludeUnstaged}
                          className="h-4 w-7 [&>span]:size-3 [&>span[data-state=checked]]:translate-x-3"
                        />
                        <span className="min-w-0 truncate text-muted-foreground">
                          {includeUnstaged ? "All workspace changes" : "Only staged changes"}
                        </span>
                      </div>
                    </DetailRow>
                  ) : null}
                  {changedFiles && changedFiles.length > 0 ? (
                    <DetailRow
                      label="Changed files"
                      layout="vertical"
                      valueClassName="pt-0.5"
                    >
                      <WorkspaceChangesList
                        files={changedFiles}
                        threadId={threadId}
                        maxHeightClassName="max-h-40"
                      />
                    </DetailRow>
                  ) : null}
                </DetailCard>
              ) : null}
              {errorMessage ? (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {errorMessage}
                </p>
              ) : null}
              <DialogFooter className="px-0 pt-4 sm:justify-end">
                <Button type="submit" disabled={pending}>
                  {pending ? "Starting..." : dialogCopy.submitLabel}
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
