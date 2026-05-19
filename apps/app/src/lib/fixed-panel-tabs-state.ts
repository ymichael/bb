import { z } from "zod";
import {
  areEnvironmentFilePreviewSourcesEqual,
  type EnvironmentFilePreviewSource,
  type HostFileTabState,
  type WorkspaceFilePreviewStatusLabel,
  type WorkspaceFileTabState,
} from "./file-preview";

export const FIXED_PANEL_TABS_STATE_STORAGE_PREFIX =
  "bb.thread.fixedPanelTabsState";
export const FIXED_PANEL_TABS_STATE_STORAGE_VERSION = 1;
export const FIXED_PANEL_TABS_IDLE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

const THREAD_INFO_TAB_ID = "thread-info";
const GIT_DIFF_TAB_ID = "git-diff";

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
const threadInfoFixedPanelTabSchema = z
  .object({
    id: z.literal(THREAD_INFO_TAB_ID),
    kind: z.literal("thread-info"),
  })
  .strict();
const gitDiffFixedPanelTabSchema = z
  .object({
    id: z.literal(GIT_DIFF_TAB_ID),
    kind: z.literal("git-diff"),
  })
  .strict();
const workspaceFilePreviewFixedPanelTabSchema = z
  .object({
    environmentId: z.string().min(1).nullable(),
    id: z.string().min(1),
    kind: z.literal("workspace-file-preview"),
    lineNumber: z.number().int().positive().nullable(),
    path: z.string().min(1),
    source: environmentFilePreviewSourceSchema,
    statusLabel: workspaceFilePreviewStatusLabelSchema,
  })
  .strict();
const hostFilePreviewFixedPanelTabSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("host-file-preview"),
    lineNumber: z.number().int().positive().nullable(),
    path: z.string().min(1),
  })
  .strict();
const threadStorageFilePreviewFixedPanelTabSchema = z
  .object({
    id: z.string().min(1),
    isPinned: z.boolean(),
    kind: z.literal("thread-storage-file-preview"),
    path: z.string().min(1),
  })
  .strict();
const terminalFixedPanelTabSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("terminal"),
    terminalId: z.string().min(1),
  })
  .strict();
const secondaryFixedPanelTabSchema = z.discriminatedUnion("kind", [
  threadInfoFixedPanelTabSchema,
  gitDiffFixedPanelTabSchema,
  workspaceFilePreviewFixedPanelTabSchema,
  hostFilePreviewFixedPanelTabSchema,
  threadStorageFilePreviewFixedPanelTabSchema,
]);
const bottomFixedPanelTabSchema = z.discriminatedUnion("kind", [
  terminalFixedPanelTabSchema,
]);
const secondaryFixedPanelTabGroupStateSchema = z
  .object({
    tabs: z.array(secondaryFixedPanelTabSchema),
    activeTabId: z.string().min(1).nullable(),
    isOpen: z.boolean(),
  })
  .strict();
const legacySecondaryFixedPanelTabGroupStateSchema = z
  .object({
    tabs: z.array(secondaryFixedPanelTabSchema),
    activeTabId: z.string().min(1).nullable(),
  })
  .strict();
const bottomFixedPanelTabGroupStateSchema = z
  .object({
    tabs: z.array(bottomFixedPanelTabSchema),
    activeTabId: z.string().min(1).nullable(),
  })
  .strict();
const fixedPanelTabsStateSchema = z
  .object({
    version: z.literal(FIXED_PANEL_TABS_STATE_STORAGE_VERSION),
    secondary: secondaryFixedPanelTabGroupStateSchema,
    bottom: bottomFixedPanelTabGroupStateSchema,
    lastUsedAt: z.number().int().nonnegative(),
  })
  .strict();
const legacyFixedPanelTabsStateSchema = z
  .object({
    version: z.literal(FIXED_PANEL_TABS_STATE_STORAGE_VERSION),
    secondary: legacySecondaryFixedPanelTabGroupStateSchema,
    bottom: bottomFixedPanelTabGroupStateSchema,
    lastUsedAt: z.number().int().nonnegative(),
  })
  .strict();

export type FixedPanelRegion = "secondary" | "bottom";

export interface ThreadInfoFixedPanelTab {
  id: typeof THREAD_INFO_TAB_ID;
  kind: "thread-info";
}

export interface GitDiffFixedPanelTab {
  id: typeof GIT_DIFF_TAB_ID;
  kind: "git-diff";
}

export interface WorkspaceFilePreviewFixedPanelTab {
  environmentId: string | null;
  id: string;
  kind: "workspace-file-preview";
  lineNumber: number | null;
  path: string;
  source: EnvironmentFilePreviewSource;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
}

export interface HostFilePreviewFixedPanelTab {
  id: string;
  kind: "host-file-preview";
  lineNumber: number | null;
  path: string;
}

export interface ThreadStorageFilePreviewFixedPanelTab {
  id: string;
  isPinned: boolean;
  kind: "thread-storage-file-preview";
  path: string;
}

export interface TerminalFixedPanelTab {
  id: string;
  kind: "terminal";
  terminalId: string;
}

export type SecondaryFixedPanelTab =
  | ThreadInfoFixedPanelTab
  | GitDiffFixedPanelTab
  | WorkspaceFilePreviewFixedPanelTab
  | HostFilePreviewFixedPanelTab
  | ThreadStorageFilePreviewFixedPanelTab;

export type BottomFixedPanelTab = TerminalFixedPanelTab;

export type FixedPanelTab = SecondaryFixedPanelTab | BottomFixedPanelTab;

export interface FixedPanelTabGroupState {
  tabs: readonly FixedPanelTab[];
  activeTabId: string | null;
}

export interface FixedSecondaryPanelTabGroupState
  extends FixedPanelTabGroupState {
  isOpen: boolean;
}

export interface FixedPanelTabsState {
  version: typeof FIXED_PANEL_TABS_STATE_STORAGE_VERSION;
  secondary: FixedSecondaryPanelTabGroupState;
  bottom: FixedPanelTabGroupState;
  lastUsedAt: number;
}

interface FixedPanelTabsStorageKeyArgs {
  threadId: string;
}

interface CreateFixedPanelTabsStateArgs {
  bottom?: FixedPanelTabGroupState;
  lastUsedAt?: number;
  secondary?: FixedSecondaryPanelTabGroupState;
}

interface ParseFixedPanelTabsStateArgs {
  initialValue: FixedPanelTabsState;
  now: number;
  storedValue: string | null;
}

interface ParseFixedPanelTabsStateForStorageResult {
  shouldPrune: boolean;
  state: FixedPanelTabsState;
}

interface SerializeFixedPanelTabsStateArgs {
  state: FixedPanelTabsState;
}

interface IsFixedPanelTabsStateExpiredArgs {
  now: number;
  state: FixedPanelTabsState;
}

interface PruneFixedPanelTabsStorageArgs {
  now: number;
}

interface NormalizeFixedPanelTabsStateArgs {
  state: FixedPanelTabsState;
}

interface NormalizeFixedPanelTabGroupStateArgs {
  group: FixedPanelTabGroupState;
  region: FixedPanelRegion;
}

interface CreateThreadStorageFilePreviewFixedPanelTabArgs {
  isPinned: boolean;
  path: string;
}

interface CreateWorkspaceFilePreviewFixedPanelTabArgs {
  environmentId: string | null;
  tab: WorkspaceFileTabState;
}

interface CreateTerminalFixedPanelTabArgs {
  terminalId: string;
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

function buildFileTabId(kind: FixedPanelTab["kind"], path: string): string {
  return `${kind}:${encodeURIComponent(path)}`;
}

export function createThreadInfoFixedPanelTab(): ThreadInfoFixedPanelTab {
  return {
    id: THREAD_INFO_TAB_ID,
    kind: "thread-info",
  };
}

export function createGitDiffFixedPanelTab(): GitDiffFixedPanelTab {
  return {
    id: GIT_DIFF_TAB_ID,
    kind: "git-diff",
  };
}

export function createWorkspaceFilePreviewFixedPanelTab({
  environmentId,
  tab,
}: CreateWorkspaceFilePreviewFixedPanelTabArgs): WorkspaceFilePreviewFixedPanelTab {
  return {
    environmentId,
    id: buildFileTabId("workspace-file-preview", tab.path),
    kind: "workspace-file-preview",
    lineNumber: tab.lineNumber,
    path: tab.path,
    source: tab.source,
    statusLabel: tab.statusLabel,
  };
}

export function createHostFilePreviewFixedPanelTab(
  tab: HostFileTabState,
): HostFilePreviewFixedPanelTab {
  return {
    id: buildFileTabId("host-file-preview", tab.path),
    kind: "host-file-preview",
    lineNumber: tab.lineNumber,
    path: tab.path,
  };
}

export function createThreadStorageFilePreviewFixedPanelTab({
  isPinned,
  path,
}: CreateThreadStorageFilePreviewFixedPanelTabArgs): ThreadStorageFilePreviewFixedPanelTab {
  return {
    id: buildFileTabId("thread-storage-file-preview", path),
    isPinned,
    kind: "thread-storage-file-preview",
    path,
  };
}

export function createTerminalFixedPanelTab({
  terminalId,
}: CreateTerminalFixedPanelTabArgs): TerminalFixedPanelTab {
  return {
    id: `terminal:${encodeURIComponent(terminalId)}`,
    kind: "terminal",
    terminalId,
  };
}

function isTabSupportedInRegion(
  region: FixedPanelRegion,
  tab: FixedPanelTab,
): boolean {
  if (region === "bottom") {
    return tab.kind === "terminal";
  }
  return tab.kind !== "terminal";
}

function normalizeFixedPanelTabGroupState({
  group,
  region,
}: NormalizeFixedPanelTabGroupStateArgs): FixedPanelTabGroupState {
  const seenTabIds = new Set<string>();
  const tabs: FixedPanelTab[] = [];
  for (const tab of group.tabs) {
    if (!isTabSupportedInRegion(region, tab) || seenTabIds.has(tab.id)) {
      continue;
    }
    seenTabIds.add(tab.id);
    tabs.push(tab);
  }

  return {
    tabs,
    activeTabId:
      group.activeTabId !== null && seenTabIds.has(group.activeTabId)
        ? group.activeTabId
        : null,
  };
}

function normalizeFixedSecondaryPanelTabGroupState(
  group: FixedSecondaryPanelTabGroupState,
): FixedSecondaryPanelTabGroupState {
  return {
    ...normalizeFixedPanelTabGroupState({
      group,
      region: "secondary",
    }),
    isOpen: group.isOpen,
  };
}

export function normalizeFixedPanelTabsState({
  state,
}: NormalizeFixedPanelTabsStateArgs): FixedPanelTabsState {
  return {
    ...state,
    secondary: normalizeFixedSecondaryPanelTabGroupState(state.secondary),
    bottom: normalizeFixedPanelTabGroupState({
      group: state.bottom,
      region: "bottom",
    }),
  };
}

export function createEmptyFixedPanelTabsState(
  args: CreateFixedPanelTabsStateArgs = {},
): FixedPanelTabsState {
  return normalizeFixedPanelTabsState({
    state: {
      version: FIXED_PANEL_TABS_STATE_STORAGE_VERSION,
      secondary: args.secondary ?? {
        tabs: [],
        activeTabId: null,
        isOpen: false,
      },
      bottom: args.bottom ?? {
        tabs: [],
        activeTabId: null,
      },
      lastUsedAt: args.lastUsedAt ?? 0,
    },
  });
}

export const EMPTY_FIXED_PANEL_TABS_STATE = createEmptyFixedPanelTabsState();

export function getFixedPanelTabsStateStorageKey({
  threadId,
}: FixedPanelTabsStorageKeyArgs): string {
  return `${FIXED_PANEL_TABS_STATE_STORAGE_PREFIX}-${normalizeStorageSegment(
    threadId,
  )}-${FIXED_PANEL_TABS_STATE_STORAGE_VERSION}`;
}

export function isFixedPanelTabsStateStorageKey(key: string): boolean {
  return (
    key.startsWith(`${FIXED_PANEL_TABS_STATE_STORAGE_PREFIX}-`) &&
    key.endsWith(`-${FIXED_PANEL_TABS_STATE_STORAGE_VERSION}`)
  );
}

export function isFixedPanelTabsStateExpired({
  now,
  state,
}: IsFixedPanelTabsStateExpiredArgs): boolean {
  return now - state.lastUsedAt > FIXED_PANEL_TABS_IDLE_EXPIRY_MS;
}

export function parseFixedPanelTabsState({
  initialValue,
  now,
  storedValue,
}: ParseFixedPanelTabsStateArgs): FixedPanelTabsState {
  return parseFixedPanelTabsStateForStorage({
    initialValue,
    now,
    storedValue,
  }).state;
}

function parseFixedPanelTabsStateForStorage({
  initialValue,
  now,
  storedValue,
}: ParseFixedPanelTabsStateArgs): ParseFixedPanelTabsStateForStorageResult {
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

  const stateResult = fixedPanelTabsStateSchema.safeParse(parsedValue);
  if (stateResult.success) {
    const normalizedState = normalizeFixedPanelTabsState({
      state: stateResult.data,
    });
    if (isFixedPanelTabsStateExpired({ now, state: normalizedState })) {
      return {
        shouldPrune: true,
        state: initialValue,
      };
    }

    return {
      shouldPrune: false,
      state: normalizedState,
    };
  }

  const legacyStateResult = legacyFixedPanelTabsStateSchema.safeParse(parsedValue);
  if (!legacyStateResult.success) {
    return {
      shouldPrune: true,
      state: initialValue,
    };
  }
  const normalizedState = normalizeFixedPanelTabsState({
    state: {
      ...legacyStateResult.data,
      secondary: {
        ...legacyStateResult.data.secondary,
        isOpen: legacyStateResult.data.secondary.activeTabId !== null,
      },
    },
  });
  if (isFixedPanelTabsStateExpired({ now, state: normalizedState })) {
    return {
      shouldPrune: true,
      state: initialValue,
    };
  }

  return {
    shouldPrune: false,
    state: normalizedState,
  };
}

export function serializeFixedPanelTabsState({
  state,
}: SerializeFixedPanelTabsStateArgs): string {
  return JSON.stringify(normalizeFixedPanelTabsState({ state }));
}

export function pruneFixedPanelTabsStorage({
  now,
}: PruneFixedPanelTabsStorageArgs): void {
  const localStorage = getLocalStorage();
  if (!localStorage) {
    return;
  }

  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && isFixedPanelTabsStateStorageKey(key)) {
      keys.push(key);
    }
  }

  for (const key of keys) {
    const result = parseFixedPanelTabsStateForStorage({
      initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
      now,
      storedValue: localStorage.getItem(key),
    });
    if (result.shouldPrune) {
      localStorage.removeItem(key);
    }
  }
}

export function areFixedPanelTabsEquivalent(
  a: FixedPanelTab,
  b: FixedPanelTab,
): boolean {
  if (a.id !== b.id || a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "thread-info":
    case "git-diff":
      return true;
    case "workspace-file-preview":
      return (
        b.kind === "workspace-file-preview" &&
        a.environmentId === b.environmentId &&
        a.lineNumber === b.lineNumber &&
        a.path === b.path &&
        areEnvironmentFilePreviewSourcesEqual(a.source, b.source) &&
        a.statusLabel === b.statusLabel
      );
    case "host-file-preview":
      return (
        b.kind === "host-file-preview" &&
        a.lineNumber === b.lineNumber &&
        a.path === b.path
      );
    case "thread-storage-file-preview":
      return (
        b.kind === "thread-storage-file-preview" &&
        a.isPinned === b.isPinned &&
        a.path === b.path
      );
    case "terminal":
      return b.kind === "terminal" && a.terminalId === b.terminalId;
  }
}
