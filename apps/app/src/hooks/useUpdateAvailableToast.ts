import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSystemVersion } from "./queries/system-queries";

const DISMISSED_STORAGE_KEY_PREFIX = "bb:update-toast:dismissed:";

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isDismissedForVersion(latestVersion: string): boolean {
  const storage = getLocalStorage();
  if (storage === null) {
    return false;
  }
  try {
    return (
      storage.getItem(`${DISMISSED_STORAGE_KEY_PREFIX}${latestVersion}`) ===
      "true"
    );
  } catch {
    return false;
  }
}

function markDismissedForVersion(latestVersion: string): void {
  const storage = getLocalStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(`${DISMISSED_STORAGE_KEY_PREFIX}${latestVersion}`, "true");
  } catch {
    // localStorage may be disabled; the in-memory ref keeps the toast hidden
    // for the rest of this session.
  }
}

interface ToastContentArgs {
  upgradeCommand: string;
}

function toastDescription(args: ToastContentArgs): string {
  return `Restart \`${args.upgradeCommand}\` to get the latest version`;
}

export function useUpdateAvailableToast(): void {
  const { data } = useSystemVersion();
  const shownForVersionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!data) {
      return;
    }
    if (data.isDevelopment) {
      return;
    }
    if (!data.updateAvailable) {
      return;
    }
    const { latestVersion, upgradeCommand } = data;
    if (latestVersion === null) {
      return;
    }
    if (shownForVersionRef.current === latestVersion) {
      return;
    }
    if (isDismissedForVersion(latestVersion)) {
      shownForVersionRef.current = latestVersion;
      return;
    }
    shownForVersionRef.current = latestVersion;
    toast(`Update available: bb-app ${latestVersion}`, {
      id: `bb-update-available:${latestVersion}`,
      description: toastDescription({ upgradeCommand }),
      duration: Infinity,
      action: {
        label: "Dismiss",
        onClick: () => {
          markDismissedForVersion(latestVersion);
          toast.dismiss(`bb-update-available:${latestVersion}`);
        },
      },
      onDismiss: () => {
        markDismissedForVersion(latestVersion);
      },
    });
  }, [data]);
}
