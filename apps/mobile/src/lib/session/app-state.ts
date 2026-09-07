import type { AppStateLike } from "../realtime/app-state";
import type { SessionScheduler } from "./session-scheduler";

export function bindSessionToAppState(
  scheduler: SessionScheduler,
  appState: AppStateLike,
): () => void {
  const subscription = appState.addEventListener("change", (state) => {
    if (state === "active") scheduler.renewIfDue();
  });
  return () => subscription.remove();
}
