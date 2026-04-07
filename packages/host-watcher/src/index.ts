import type { HostWatcher, CreateHostWatcherArgs } from "./host-watcher-types.js";

export type {
  HostObservedChange,
  HostWatchError,
  HostWatcher,
  ThreadStorageWatchError,
  ThreadStorageWatchTarget,
  WatchThreadStorageRootArgs,
  WatchWorkspaceArgs,
  WorkspaceWatchError,
} from "./host-watcher-types.js";
export type {
  WorkspaceStatusChangeEvent,
  WorkspaceStatusWatchChangeKind,
} from "./watch-status-types.js";

export async function createHostWatcher(
  args: CreateHostWatcherArgs,
): Promise<HostWatcher | undefined> {
  if (args.hostType === "ephemeral") {
    return undefined;
  }

  const { createParcelHostWatcher } = await import("./parcel-host-watcher.js");
  return createParcelHostWatcher();
}
