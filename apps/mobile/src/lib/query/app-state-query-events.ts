import type { AppStateLike } from "../realtime/app-state";

export interface FocusManagerLike {
  setEventListener(
    setup: (setFocused: (focused?: boolean) => void) => () => void,
  ): void;
  setFocused(focused?: boolean): void;
}

export interface InstallAppStateQueryEventsArgs {
  AppState: AppStateLike;
  focusManager: FocusManagerLike;
}

export function installAppStateQueryEvents({
  AppState,
  focusManager,
}: InstallAppStateQueryEventsArgs): () => void {
  let subscription: { remove(): void } | null = null;
  focusManager.setEventListener((setFocused) => {
    setFocused(AppState.currentState === "active");
    subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setFocused(true);
      else if (state === "background") setFocused(false);
    });
    return () => {
      subscription?.remove();
      subscription = null;
    };
  });
  return () => {
    focusManager.setEventListener(() => () => {});
    focusManager.setFocused(true);
  };
}
