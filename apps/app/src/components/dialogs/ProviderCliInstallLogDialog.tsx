import { useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { CopyButton } from "@/components/ui/copy-button";

export interface ProviderCliInstallLogDialogState {
  displayName: string;
  log: string;
  message: string;
  title: string;
}

interface ProviderCliInstallLogDialogProps {
  state: ProviderCliInstallLogDialogState | null;
  onClose: () => void;
}

interface ProviderCliInstallLogDialogContentProps {
  state: ProviderCliInstallLogDialogState;
}

export function ProviderCliInstallLogDialog({
  state,
  onClose,
}: ProviderCliInstallLogDialogProps) {
  const renderedStateRef = useRef<ProviderCliInstallLogDialogState | null>(
    state,
  );
  const isOpen = state !== null;

  if (state !== null) {
    renderedStateRef.current = state;
  }

  const currentState = state ?? renderedStateRef.current;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent>
        {currentState ? (
          <ProviderCliInstallLogDialogContent state={currentState} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ProviderCliInstallLogDialogContent({
  state,
}: ProviderCliInstallLogDialogContentProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{state.title}</DialogTitle>
        <DialogDescription>{state.message}</DialogDescription>
      </DialogHeader>

      <div className="relative overflow-hidden rounded-md border bg-background">
        <CopyButton
          text={state.log}
          label="Copy setup log"
          successMessage={`${state.displayName} setup log copied`}
          className="absolute right-2 top-2 z-10 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          iconClassName="size-3"
        />
        <pre className="max-h-80 min-h-32 overflow-auto p-3 pr-12 text-xs whitespace-pre-wrap break-words text-foreground">
          {state.log}
        </pre>
      </div>
    </>
  );
}
