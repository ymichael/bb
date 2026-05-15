import { z } from "zod";
import {
  areEnvironmentFilePreviewSourcesEqual,
  type EnvironmentFilePreviewSource,
  type WorkspaceFilePreviewStatusLabel,
} from "./file-preview";
import type { ThreadSecondaryPanel } from "./thread-secondary-panel";

export const LEGACY_THREAD_SECONDARY_PANEL_STORAGE_KEY =
  "bb.thread.secondaryPanel";
export const THREAD_SECONDARY_PANEL_STATE_STORAGE_PREFIX =
  "bb.thread.secondaryPanelState";
export const THREAD_SECONDARY_PANEL_STATE_STORAGE_VERSION = 1;
export const THREAD_SECONDARY_PANEL_IDLE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

const threadSecondaryPanelSchema = z.enum(["git-diff", "thread-info"]);
const environmentFilePreviewSourceSchema: z.ZodType<EnvironmentFilePreviewSource> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("working-tree"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("head"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("merge-base"),
        ref: z.string().min(1),
      })
      .strict(),
  ]);
const workspaceFilePreviewStatusLabelSchema: z.ZodType<WorkspaceFilePreviewStatusLabel | null> =
  z.literal("deleted").nullable();
const workspaceFileTabStateSchema = z
  .object({
    lineNumber: z.number().int().positive().nullable(),
    path: z.string().min(1),
    source: environmentFilePreviewSourceSchema,
    statusLabel: workspaceFilePreviewStatusLabelSchema,
  })
  .strict();
const hostFileTabStateSchema = z
  .object({
    lineNumber: z.number().int().positive().nullable(),
    path: z.string().min(1),
  })
  .strict();
const threadSecondaryPanelFileTabV1RefSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("workspace"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("storage"),
      path: z.string().min(1),
    })
    .strict(),
]);
const threadSecondaryPanelFileTabRefSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("workspace"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("storage"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("host-file"),
      path: z.string().min(1),
    })
    .strict(),
]);
const threadSecondaryPanelFileTabsStateSchema = z
  .object({
    workspace: z.array(workspaceFileTabStateSchema),
    storage: z.array(z.string().min(1)),
    hostFiles: z.array(hostFileTabStateSchema),
    active: threadSecondaryPanelFileTabRefSchema.nullable(),
  })
  .strict();
const threadSecondaryPanelFileTabsV1StateSchema = z
  .object({
    workspace: z.array(workspaceFileTabStateSchema),
    storage: z.array(z.string().min(1)),
    active: threadSecondaryPanelFileTabV1RefSchema.nullable(),
  })
  .strict();
const threadSecondaryPanelStateSchema = z
  .object({
    version: z.literal(THREAD_SECONDARY_PANEL_STATE_STORAGE_VERSION),
    activePanel: threadSecondaryPanelSchema.nullable(),
    environmentId: z.string().min(1).nullable(),
    fileTabs: threadSecondaryPanelFileTabsStateSchema,
    lastUsedAt: z.number().int().nonnegative(),
  })
  .strict();
const threadSecondaryPanelV1StateSchema = z
  .object({
    version: z.literal(THREAD_SECONDARY_PANEL_STATE_STORAGE_VERSION),
    activePanel: threadSecondaryPanelSchema.nullable(),
    environmentId: z.string().min(1).nullable(),
    fileTabs: threadSecondaryPanelFileTabsV1StateSchema,
    lastUsedAt: z.number().int().nonnegative(),
  })
  .strict();

export interface WorkspaceFileTabState {
  lineNumber: number | null;
  path: string;
  source: EnvironmentFilePreviewSource;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
}

export interface HostFileTabState {
  lineNumber: number | null;
  path: string;
}

interface ActiveWorkspaceFileTabRef {
  type: "workspace";
  path: string;
}

interface ActiveStorageFileTabRef {
  type: "storage";
  path: string;
}

interface ActiveHostFileTabRef {
  type: "host-file";
  path: string;
}

export type ThreadSecondaryPanelFileTabRef =
  | ActiveWorkspaceFileTabRef
  | ActiveStorageFileTabRef
  | ActiveHostFileTabRef;

export interface ThreadSecondaryPanelFileTabsState {
  workspace: readonly WorkspaceFileTabState[];
  storage: readonly string[];
  hostFiles: readonly HostFileTabState[];
  active: ThreadSecondaryPanelFileTabRef | null;
}

export interface ThreadSecondaryPanelState {
  version: typeof THREAD_SECONDARY_PANEL_STATE_STORAGE_VERSION;
  activePanel: ThreadSecondaryPanel | null;
  environmentId: string | null;
  fileTabs: ThreadSecondaryPanelFileTabsState;
  lastUsedAt: number;
}

interface ThreadSecondaryPanelStorageKeyArgs {
  threadId: string;
}

interface ParseThreadSecondaryPanelStateArgs {
  initialValue: ThreadSecondaryPanelState;
  now: number;
  storedValue: string | null;
}

interface ParseThreadSecondaryPanelStateForStorageResult {
  shouldPrune: boolean;
  state: ThreadSecondaryPanelState;
}

interface SerializeThreadSecondaryPanelStateArgs {
  state: ThreadSecondaryPanelState;
}

interface IsThreadSecondaryPanelStateExpiredArgs {
  now: number;
  state: ThreadSecondaryPanelState;
}

interface PruneThreadSecondaryPanelStorageArgs {
  now: number;
}

interface NormalizeThreadSecondaryPanelStateArgs {
  isManagerThread: boolean;
  state: ThreadSecondaryPanelState;
}

interface ClearWorkspaceTabsForEnvironmentArgs {
  environmentId: string | null | undefined;
  state: ThreadSecondaryPanelState;
}

interface PruneStorageFileTabsArgs {
  isManagerThread: boolean;
  pinnedStorageFilePath: string;
  state: ThreadSecondaryPanelState;
  storageFiles: readonly { path: string }[];
}

interface CreateThreadSecondaryPanelStateArgs {
  activePanel?: ThreadSecondaryPanel | null;
  environmentId?: string | null;
  fileTabs?: ThreadSecondaryPanelFileTabsState;
  lastUsedAt?: number;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

function normalizeStorageSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function areWorkspaceFileTabsEqual(
  a: readonly WorkspaceFileTabState[],
  b: readonly WorkspaceFileTabState[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const aTab = a[i];
    const bTab = b[i];
    if (
      !aTab ||
      !bTab ||
      aTab.path !== bTab.path ||
      aTab.lineNumber !== bTab.lineNumber ||
      !areEnvironmentFilePreviewSourcesEqual(aTab.source, bTab.source) ||
      aTab.statusLabel !== bTab.statusLabel
    ) {
      return false;
    }
  }
  return true;
}

function areStorageFileTabsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function areHostFileTabsEqual(
  a: readonly HostFileTabState[],
  b: readonly HostFileTabState[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const aTab = a[i];
    const bTab = b[i];
    if (
      !aTab ||
      !bTab ||
      aTab.path !== bTab.path ||
      aTab.lineNumber !== bTab.lineNumber
    ) {
      return false;
    }
  }
  return true;
}

function areActiveFileTabsEqual(
  a: ThreadSecondaryPanelFileTabRef | null,
  b: ThreadSecondaryPanelFileTabRef | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.type === b.type && a.path === b.path;
}

function findWorkspaceFileTab(
  tabs: readonly WorkspaceFileTabState[],
  path: string,
): WorkspaceFileTabState | null {
  return tabs.find((tab) => tab.path === path) ?? null;
}

function findHostFileTab(
  tabs: readonly HostFileTabState[],
  path: string,
): HostFileTabState | null {
  return tabs.find((tab) => tab.path === path) ?? null;
}

function dedupeWorkspaceFileTabs(
  tabs: readonly WorkspaceFileTabState[],
): WorkspaceFileTabState[] {
  const seenPaths = new Set<string>();
  const nextTabs: WorkspaceFileTabState[] = [];
  for (const tab of tabs) {
    if (seenPaths.has(tab.path)) continue;
    seenPaths.add(tab.path);
    nextTabs.push(tab);
  }
  return nextTabs;
}

function dedupeStorageFileTabs(tabs: readonly string[]): string[] {
  const seenPaths = new Set<string>();
  const nextTabs: string[] = [];
  for (const path of tabs) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    nextTabs.push(path);
  }
  return nextTabs;
}

function dedupeHostFileTabs(
  tabs: readonly HostFileTabState[],
): HostFileTabState[] {
  const seenPaths = new Set<string>();
  const nextTabs: HostFileTabState[] = [];
  for (const tab of tabs) {
    if (seenPaths.has(tab.path)) continue;
    seenPaths.add(tab.path);
    nextTabs.push(tab);
  }
  return nextTabs;
}

function normalizeActiveFileTab(
  fileTabs: ThreadSecondaryPanelFileTabsState,
  isManagerThread: boolean,
): ThreadSecondaryPanelFileTabRef | null {
  const active = fileTabs.active;
  if (active === null) return null;
  if (active.type === "workspace") {
    return findWorkspaceFileTab(fileTabs.workspace, active.path) === null
      ? null
      : active;
  }
  if (active.type === "host-file") {
    return findHostFileTab(fileTabs.hostFiles, active.path) === null
      ? null
      : active;
  }
  if (!isManagerThread) return null;
  return fileTabs.storage.includes(active.path) ? active : null;
}

export function createEmptyThreadSecondaryPanelState(
  args: CreateThreadSecondaryPanelStateArgs = {},
): ThreadSecondaryPanelState {
  return {
    version: THREAD_SECONDARY_PANEL_STATE_STORAGE_VERSION,
    activePanel: args.activePanel ?? null,
    environmentId: args.environmentId ?? null,
    fileTabs: args.fileTabs ?? {
      workspace: [],
      storage: [],
      hostFiles: [],
      active: null,
    },
    lastUsedAt: args.lastUsedAt ?? 0,
  };
}

export const EMPTY_THREAD_SECONDARY_PANEL_STATE =
  createEmptyThreadSecondaryPanelState();

export function getThreadSecondaryPanelStateStorageKey({
  threadId,
}: ThreadSecondaryPanelStorageKeyArgs): string {
  return `${THREAD_SECONDARY_PANEL_STATE_STORAGE_PREFIX}-${normalizeStorageSegment(
    threadId,
  )}-${THREAD_SECONDARY_PANEL_STATE_STORAGE_VERSION}`;
}

export function isThreadSecondaryPanelStateStorageKey(key: string): boolean {
  return (
    key.startsWith(`${THREAD_SECONDARY_PANEL_STATE_STORAGE_PREFIX}-`) &&
    key.endsWith(`-${THREAD_SECONDARY_PANEL_STATE_STORAGE_VERSION}`)
  );
}

export function isThreadSecondaryPanelStateExpired({
  now,
  state,
}: IsThreadSecondaryPanelStateExpiredArgs): boolean {
  return now - state.lastUsedAt > THREAD_SECONDARY_PANEL_IDLE_EXPIRY_MS;
}

export function parseThreadSecondaryPanelState({
  initialValue,
  now,
  storedValue,
}: ParseThreadSecondaryPanelStateArgs): ThreadSecondaryPanelState {
  return parseThreadSecondaryPanelStateForStorage({
    initialValue,
    now,
    storedValue,
  }).state;
}

function parseThreadSecondaryPanelStateForStorage({
  initialValue,
  now,
  storedValue,
}: ParseThreadSecondaryPanelStateArgs): ParseThreadSecondaryPanelStateForStorageResult {
  if (storedValue === null) {
    return {
      shouldPrune: false,
      state: initialValue,
    };
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(storedValue);
  } catch {
    return {
      shouldPrune: true,
      state: initialValue,
    };
  }

  const stateResult = threadSecondaryPanelStateSchema.safeParse(parsedValue);
  if (stateResult.success) {
    if (isThreadSecondaryPanelStateExpired({ now, state: stateResult.data })) {
      return {
        shouldPrune: true,
        state: initialValue,
      };
    }

    return {
      shouldPrune: false,
      state: stateResult.data,
    };
  }

  const legacyStateResult =
    threadSecondaryPanelV1StateSchema.safeParse(parsedValue);
  if (!legacyStateResult.success) {
    return {
      shouldPrune: true,
      state: initialValue,
    };
  }

  const migratedState: ThreadSecondaryPanelState = {
    ...legacyStateResult.data,
    fileTabs: {
      ...legacyStateResult.data.fileTabs,
      hostFiles: [],
    },
  };

  if (isThreadSecondaryPanelStateExpired({ now, state: migratedState })) {
    return {
      shouldPrune: true,
      state: initialValue,
    };
  }

  return {
    shouldPrune: false,
    state: migratedState,
  };
}

export function serializeThreadSecondaryPanelState({
  state,
}: SerializeThreadSecondaryPanelStateArgs): string {
  return JSON.stringify(state);
}

export function normalizeThreadSecondaryPanelState({
  isManagerThread,
  state,
}: NormalizeThreadSecondaryPanelStateArgs): ThreadSecondaryPanelState {
  const workspace = dedupeWorkspaceFileTabs(state.fileTabs.workspace);
  const storage = isManagerThread
    ? dedupeStorageFileTabs(state.fileTabs.storage)
    : [];
  const hostFiles = dedupeHostFileTabs(state.fileTabs.hostFiles);
  const fileTabs: ThreadSecondaryPanelFileTabsState = {
    workspace,
    storage,
    hostFiles,
    active: normalizeActiveFileTab(
      {
        workspace,
        storage,
        hostFiles,
        active: state.fileTabs.active,
      },
      isManagerThread,
    ),
  };

  if (
    areWorkspaceFileTabsEqual(workspace, state.fileTabs.workspace) &&
    areStorageFileTabsEqual(storage, state.fileTabs.storage) &&
    areHostFileTabsEqual(hostFiles, state.fileTabs.hostFiles) &&
    areActiveFileTabsEqual(fileTabs.active, state.fileTabs.active)
  ) {
    return state;
  }

  return {
    ...state,
    fileTabs,
  };
}

export function getActiveWorkspaceFileTab(
  state: ThreadSecondaryPanelState,
): WorkspaceFileTabState | null {
  const active = state.fileTabs.active;
  if (active?.type !== "workspace") {
    return null;
  }
  return findWorkspaceFileTab(state.fileTabs.workspace, active.path);
}

export function getActiveStorageFilePath(
  state: ThreadSecondaryPanelState,
): string | null {
  const active = state.fileTabs.active;
  if (active?.type !== "storage") {
    return null;
  }
  return state.fileTabs.storage.includes(active.path) ? active.path : null;
}

export function getActiveHostFileTab(
  state: ThreadSecondaryPanelState,
): HostFileTabState | null {
  const active = state.fileTabs.active;
  if (active?.type !== "host-file") {
    return null;
  }
  return findHostFileTab(state.fileTabs.hostFiles, active.path);
}

export function clearActiveFileTab(
  state: ThreadSecondaryPanelState,
): ThreadSecondaryPanelState {
  if (state.fileTabs.active === null) {
    return state;
  }
  return {
    ...state,
    fileTabs: {
      ...state.fileTabs,
      active: null,
    },
  };
}

export function clearWorkspaceTabsForEnvironment({
  environmentId,
  state,
}: ClearWorkspaceTabsForEnvironmentArgs): ThreadSecondaryPanelState {
  const nextEnvironmentId = environmentId ?? null;
  const hasWorkspaceState =
    state.fileTabs.workspace.length > 0 ||
    state.fileTabs.active?.type === "workspace";
  if (!hasWorkspaceState) {
    return state;
  }
  if (state.environmentId === nextEnvironmentId) {
    return state;
  }
  return {
    ...state,
    environmentId: nextEnvironmentId,
    fileTabs: {
      ...state.fileTabs,
      workspace: [],
      active:
        state.fileTabs.active?.type === "workspace"
          ? null
          : state.fileTabs.active,
    },
  };
}

export function pruneStorageFileTabs({
  isManagerThread,
  pinnedStorageFilePath,
  state,
  storageFiles,
}: PruneStorageFileTabsArgs): ThreadSecondaryPanelState {
  if (!isManagerThread) {
    return normalizeThreadSecondaryPanelState({ isManagerThread, state });
  }

  const knownPaths = new Set([
    pinnedStorageFilePath,
    ...storageFiles.map((file) => file.path),
  ]);
  const storage = state.fileTabs.storage.filter((path) => knownPaths.has(path));
  const active =
    state.fileTabs.active?.type === "storage" &&
    !knownPaths.has(state.fileTabs.active.path)
      ? null
      : state.fileTabs.active;

  if (
    areStorageFileTabsEqual(storage, state.fileTabs.storage) &&
    areActiveFileTabsEqual(active, state.fileTabs.active)
  ) {
    return state;
  }

  return {
    ...state,
    fileTabs: {
      ...state.fileTabs,
      storage,
      active,
    },
  };
}

export function pruneThreadSecondaryPanelStorage({
  now,
}: PruneThreadSecondaryPanelStorageArgs): void {
  const localStorage = getLocalStorage();
  if (!localStorage) return;

  localStorage.removeItem(LEGACY_THREAD_SECONDARY_PANEL_STORAGE_KEY);

  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !isThreadSecondaryPanelStateStorageKey(key)) continue;
    const parseResult = parseThreadSecondaryPanelStateForStorage({
      initialValue: EMPTY_THREAD_SECONDARY_PANEL_STATE,
      now,
      storedValue: localStorage.getItem(key),
    });
    if (parseResult.shouldPrune) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}
