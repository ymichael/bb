import type { QueryClient } from "@tanstack/react-query";
import {
  threadTabsSchema,
  type ThreadTab,
  type ThreadTabsResponse,
} from "@bb/server-contract";
import { appToast } from "@/components/ui/app-toast";
import {
  getCachedThreadTabs,
  invalidateCachedThreadTabs,
  setCachedThreadTabs,
} from "@/hooks/cache-owners/thread-tabs-cache-owner";
import { BbHttpError, sdk } from "./sdk";
import {
  areFixedPanelTabsEquivalent,
  type FixedPanelTab,
  type FixedPanelTabsState,
} from "./fixed-panel-tabs-state";

interface ThreadTabsSyncArgs {
  queryClient: QueryClient;
  threadId: string;
}

interface PersistThreadTabsArgs extends ThreadTabsSyncArgs {
  tabs: readonly FixedPanelTab[];
}

interface MigrateLocalThreadTabsArgs extends ThreadTabsSyncArgs {
  tabs: readonly FixedPanelTab[];
}

const writeQueues = new WeakMap<QueryClient, Map<string, Promise<void>>>();
const pendingWriteCounts = new WeakMap<QueryClient, Map<string, number>>();
const attemptedLocalMigrations = new WeakMap<QueryClient, Set<string>>();

type PersistedThreadFixedPanelTab = Exclude<
  FixedPanelTab,
  { kind: "plugin-page-fixed" }
>;

function persistedThreadTabs(
  tabs: readonly (FixedPanelTab | ThreadTab)[],
): readonly PersistedThreadFixedPanelTab[] {
  return tabs.filter(
    (tab): tab is PersistedThreadFixedPanelTab =>
      tab.kind !== "side-chat" && tab.kind !== "plugin-page-fixed",
  );
}

export function areThreadTabListsEquivalent(
  left: readonly (FixedPanelTab | ThreadTab)[],
  right: readonly (FixedPanelTab | ThreadTab)[],
): boolean {
  const leftTabs = persistedThreadTabs(left);
  const rightTabs = persistedThreadTabs(right);
  return (
    leftTabs.length === rightTabs.length &&
    leftTabs.every((tab, index) => {
      const other = rightTabs[index];
      return other !== undefined && areFixedPanelTabsEquivalent(tab, other);
    })
  );
}

export function reconcileFixedPanelTabsState(
  current: FixedPanelTabsState,
  serverTabs: readonly ThreadTab[],
): FixedPanelTabsState {
  if (areThreadTabListsEquivalent(current.secondary.tabs, serverTabs)) {
    return current;
  }
  const tabs = persistedThreadTabs(serverTabs);
  const activeTabId = tabs.some(
    (tab) => tab.id === current.secondary.activeTabId,
  )
    ? current.secondary.activeTabId
    : null;
  return {
    ...current,
    secondary: {
      ...current.secondary,
      activeTabId,
      tabs,
    },
  };
}

function getWriteQueue(queryClient: QueryClient): Map<string, Promise<void>> {
  let queue = writeQueues.get(queryClient);
  if (queue === undefined) {
    queue = new Map();
    writeQueues.set(queryClient, queue);
  }
  return queue;
}

function adjustPendingWriteCount(
  queryClient: QueryClient,
  threadId: string,
  adjustment: 1 | -1,
): void {
  let counts = pendingWriteCounts.get(queryClient);
  if (counts === undefined) {
    counts = new Map();
    pendingWriteCounts.set(queryClient, counts);
  }
  const nextCount = (counts.get(threadId) ?? 0) + adjustment;
  if (nextCount <= 0) {
    counts.delete(threadId);
  } else {
    counts.set(threadId, nextCount);
  }
}

export function hasPendingThreadTabsWrite(
  queryClient: QueryClient,
  threadId: string,
): boolean {
  return (pendingWriteCounts.get(queryClient)?.get(threadId) ?? 0) > 0;
}

async function readCurrentThreadTabs({
  queryClient,
  threadId,
}: ThreadTabsSyncArgs): Promise<ThreadTabsResponse> {
  const cached = getCachedThreadTabs(queryClient, threadId);
  if (cached !== undefined) {
    return cached;
  }
  const response = await sdk.threads.tabs.get({ threadId });
  setCachedThreadTabs(queryClient, threadId, response);
  return response;
}

function isThreadTabsConflict(error: unknown): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 409 &&
    error.code === "thread_tabs_conflict"
  );
}

async function persistThreadTabs({
  tabs,
  queryClient,
  threadId,
}: PersistThreadTabsArgs): Promise<void> {
  const current = await readCurrentThreadTabs({ queryClient, threadId });
  const tabsToPersist = persistedThreadTabs(tabs);
  if (areThreadTabListsEquivalent(current.tabs, tabsToPersist)) {
    return;
  }
  const response = await sdk.threads.tabs.update({
    expectedRevision: current.revision,
    tabs: threadTabsSchema.parse(tabsToPersist),
    threadId,
  });
  setCachedThreadTabs(queryClient, threadId, response);
}

async function migrateLocalThreadTabs({
  queryClient,
  tabs,
  threadId,
}: MigrateLocalThreadTabsArgs): Promise<void> {
  const current = await readCurrentThreadTabs({ queryClient, threadId });
  if (current.revision !== 0) {
    return;
  }
  const tabsToPersist = persistedThreadTabs(tabs);
  const response = await sdk.threads.tabs.update({
    expectedRevision: 0,
    tabs: threadTabsSchema.parse(tabsToPersist),
    threadId,
  });
  setCachedThreadTabs(queryClient, threadId, response);
}

function enqueueThreadTabsWrite(
  { queryClient, threadId }: ThreadTabsSyncArgs,
  operation: () => Promise<void>,
): void {
  const queue = getWriteQueue(queryClient);
  const previous = queue.get(threadId) ?? Promise.resolve();
  adjustPendingWriteCount(queryClient, threadId, 1);
  const next = previous.catch(() => undefined).then(operation);
  queue.set(threadId, next);

  let didFail = false;
  void next
    .catch((error: unknown) => {
      didFail = true;
      if (!isThreadTabsConflict(error)) {
        appToast.error("Couldn’t sync tabs", {
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
      }
    })
    .finally(() => {
      adjustPendingWriteCount(queryClient, threadId, -1);
      if (didFail) {
        invalidateCachedThreadTabs(queryClient, threadId);
      }
      if (queue.get(threadId) === next) {
        queue.delete(threadId);
      }
    });
}

export function scheduleThreadTabsPersistence(
  args: PersistThreadTabsArgs,
): void {
  enqueueThreadTabsWrite(args, () => persistThreadTabs(args));
}

export function scheduleLocalThreadTabsMigration(
  args: MigrateLocalThreadTabsArgs,
): void {
  let attempted = attemptedLocalMigrations.get(args.queryClient);
  if (attempted === undefined) {
    attempted = new Set();
    attemptedLocalMigrations.set(args.queryClient, attempted);
  }
  if (attempted.has(args.threadId)) {
    return;
  }
  attempted.add(args.threadId);
  enqueueThreadTabsWrite(args, () => migrateLocalThreadTabs(args));
}
