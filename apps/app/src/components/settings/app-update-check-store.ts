import { appToast } from "@/components/ui/app-toast";

let isChecking = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAppUpdateCheck(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAppUpdateCheckSnapshot(): boolean {
  return isChecking;
}

export function checkErrorDescription(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "The update check did not complete.";
}

export function startAppUpdateCheck(check: () => Promise<void>): void {
  if (isChecking) {
    return;
  }
  isChecking = true;
  notify();

  void check()
    .catch((error: unknown) => {
      appToast.error("Update check failed", {
        description: checkErrorDescription(error),
      });
    })
    .finally(() => {
      isChecking = false;
      notify();
    });
}

export function resetAppUpdateCheckStoreForTests(): void {
  isChecking = false;
  listeners.clear();
}
