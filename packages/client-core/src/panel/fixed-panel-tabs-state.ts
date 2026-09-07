import { z } from "zod";
import {
  BB_DESKTOP_BROWSER_MAX_TITLE_LENGTH,
  BB_DESKTOP_BROWSER_MAX_URL_LENGTH,
  bbDesktopBrowserTargetSchema,
  type BbDesktopBrowserTarget,
} from "@bb/desktop-contract";
import {
  terminalCreateTargetSchema,
  threadTabFileOpenerOwnerSchema,
  type TerminalCreateTarget,
  type ThreadTabFileOpenerOwner,
} from "@bb/server-contract";
import {
  areFilePreviewLineRangesEqual,
  areEnvironmentFilePreviewSourcesEqual,
  type EnvironmentFilePreviewSource,
  type FilePreviewLineRange,
  type HostFileTabState,
  type ThreadStorageFileTabState,
  type WorkspaceFilePreviewStatusLabel,
  type WorkspaceFileTabState,
} from "../file-preview.js";

const FIXED_PANEL_TABS_STATE_STORAGE_PREFIX = "bb.thread.fixedPanelTabsState";
export const FIXED_PANEL_TABS_STATE_STORAGE_VERSION = 1;
export const FIXED_PANEL_TABS_IDLE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

const SECONDARY_PANEL_TAB_ID_ENVIRONMENT_NONE = "none";
const THREAD_INFO_TAB_ID = "thread-info:thread-info:none";
const GIT_DIFF_TAB_ID = "git-diff:git-diff:none";
const NEW_TAB_TAB_ID = "new-tab:new-tab:none";

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
const filePreviewLineRangeSchema: z.ZodType<FilePreviewLineRange> = z
  .object({
    endLineNumber: z.number().int().positive(),
    startLineNumber: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.startLineNumber <= range.endLineNumber);
const threadInfoFixedPanelTabSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("thread-info"),
  })
  .strict();
const gitDiffFixedPanelTabSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("git-diff"),
  })
  .strict();
const pluginPageFixedPanelTabSchema = z
  .object({
    fixedTabId: z.string().min(1),
    id: z.string().min(1),
    kind: z.literal("plugin-page-fixed"),
    pageId: z.string().min(1),
    pluginId: z.string().min(1),
  })
  .strict();
const workspaceFilePreviewFixedPanelTabSchema = z
  .object({
    environmentId: z.string().min(1).nullable(),
    id: z.string().min(1),
    kind: z.literal("workspace-file-preview"),
    lineRange: filePreviewLineRangeSchema.nullable().default(null),
    path: z.string().min(1),
    projectId: z.string().min(1).nullable().default(null),
    source: environmentFilePreviewSourceSchema,
    statusLabel: workspaceFilePreviewStatusLabelSchema,
  })
  .strict();
const hostFilePreviewFixedPanelTabSchema = z
  .object({
    environmentId: z.string().min(1).nullable().default(null),
    hostId: z.string().min(1).nullable().default(null),
    id: z.string().min(1),
    kind: z.literal("host-file-preview"),
    lineRange: filePreviewLineRangeSchema.nullable().default(null),
    path: z.string().min(1),
    threadId: z.string().min(1).nullable().default(null),
  })
  .strict();
const threadStorageFilePreviewFixedPanelTabSchema = z
  .object({
    environmentId: z.string().min(1).nullable().default(null),
    id: z.string().min(1),
    isPinned: z.boolean(),
    kind: z.literal("thread-storage-file-preview"),
    lineRange: filePreviewLineRangeSchema.nullable().default(null),
    path: z.string().min(1),
    threadId: z.string().min(1).nullable().default(null),
  })
  .strict();
const browserFixedPanelTabSchema = z
  .object({
    environmentId: z.string().min(1).nullable().default(null),
    id: z.string().min(1),
    kind: z.literal("browser"),
    desktopTarget: bbDesktopBrowserTargetSchema.optional(),
    title: z
      .string()
      .min(1)
      .max(BB_DESKTOP_BROWSER_MAX_TITLE_LENGTH)
      .nullable(),
    url: z.string().max(BB_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
const newTabFixedPanelTabSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("new-tab"),
  })
  .strict();
const terminalFixedPanelTabSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("terminal"),
    terminalId: z.string().min(1),
    target: terminalCreateTargetSchema.optional(),
  })
  .strict();
const pluginPanelFixedPanelTabSchema = z
  .object({
    actionId: z.string().min(1),
    fileOpenerOwner: threadTabFileOpenerOwnerSchema.optional(),
    id: z.string().min(1),
    kind: z.literal("plugin-panel"),
    paramsJson: z.string().nullable(),
    pluginId: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();
const secondaryFixedPanelTabSchema = z.union([
  threadInfoFixedPanelTabSchema,
  gitDiffFixedPanelTabSchema,
  pluginPageFixedPanelTabSchema,
  pluginPanelFixedPanelTabSchema,
  workspaceFilePreviewFixedPanelTabSchema,
  hostFilePreviewFixedPanelTabSchema,
  threadStorageFilePreviewFixedPanelTabSchema,
  browserFixedPanelTabSchema,
  newTabFixedPanelTabSchema,
  terminalFixedPanelTabSchema,
]);
const secondaryFixedPanelTabsSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter(
          (tab) =>
            !(
              typeof tab === "object" &&
              tab !== null &&
              (tab as { kind?: unknown }).kind === "side-chat"
            ),
        )
      : value,
  z.array(secondaryFixedPanelTabSchema),
);
const secondaryFixedPanelTabGroupStateSchema = z
  .object({
    tabs: secondaryFixedPanelTabsSchema,
    activeTabId: z.string().min(1).nullable(),
    isOpen: z.boolean(),
  })
  .strict();
const fixedPanelTabsStateSchema = z
  .object({
    version: z.literal(FIXED_PANEL_TABS_STATE_STORAGE_VERSION),
    secondary: secondaryFixedPanelTabGroupStateSchema,
    lastUsedAt: z.number().int().nonnegative(),
  })
  .passthrough();

interface ThreadInfoFixedPanelTab {
  id: string;
  kind: "thread-info";
}

interface GitDiffFixedPanelTab {
  id: string;
  kind: "git-diff";
}

export interface PluginPageFixedPanelTab {
  fixedTabId: string;
  id: string;
  kind: "plugin-page-fixed";
  pageId: string;
  pluginId: string;
}

export type FixedPanelViewTab =
  | ThreadInfoFixedPanelTab
  | GitDiffFixedPanelTab
  | PluginPageFixedPanelTab;

export interface PluginPanelFixedPanelTab {
  actionId: string;
  fileOpenerOwner?: ThreadTabFileOpenerOwner;
  id: string;
  kind: "plugin-panel";
  paramsJson: string | null;
  pluginId: string;
  title: string;
}

export interface WorkspaceFilePreviewFixedPanelTab {
  environmentId: string | null;
  id: string;
  kind: "workspace-file-preview";
  lineRange: FilePreviewLineRange | null;
  path: string;
  projectId: string | null;
  source: EnvironmentFilePreviewSource;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
}

export interface HostFilePreviewFixedPanelTab {
  environmentId: string | null;
  hostId: string | null;
  id: string;
  kind: "host-file-preview";
  lineRange: FilePreviewLineRange | null;
  path: string;
  threadId: string | null;
}

export interface ThreadStorageFilePreviewFixedPanelTab {
  environmentId: string | null;
  id: string;
  isPinned: boolean;
  kind: "thread-storage-file-preview";
  lineRange: FilePreviewLineRange | null;
  path: string;
  threadId: string | null;
}

export interface BrowserFixedPanelTab {
  desktopTarget?: BbDesktopBrowserTarget;
  environmentId: string | null;
  id: string;
  kind: "browser";
  title: string | null;
  url: string;
}

export interface NewTabFixedPanelTab {
  id: string;
  kind: "new-tab";
}

export interface TerminalFixedPanelTab {
  id: string;
  kind: "terminal";
  terminalId: string;
  target?: TerminalCreateTarget;
}

export type SecondaryFixedPanelTab =
  | ThreadInfoFixedPanelTab
  | GitDiffFixedPanelTab
  | PluginPageFixedPanelTab
  | PluginPanelFixedPanelTab
  | WorkspaceFilePreviewFixedPanelTab
  | HostFilePreviewFixedPanelTab
  | ThreadStorageFilePreviewFixedPanelTab
  | BrowserFixedPanelTab
  | NewTabFixedPanelTab
  | TerminalFixedPanelTab;

export type SecondaryFileFixedPanelTab =
  | WorkspaceFilePreviewFixedPanelTab
  | HostFilePreviewFixedPanelTab
  | ThreadStorageFilePreviewFixedPanelTab
  | BrowserFixedPanelTab
  | NewTabFixedPanelTab
  | TerminalFixedPanelTab
  | PluginPanelFixedPanelTab;

export type FixedPanelTab = SecondaryFixedPanelTab;

interface FixedPanelTabGroupState {
  tabs: readonly FixedPanelTab[];
  activeTabId: string | null;
}

interface FixedSecondaryPanelTabGroupState extends FixedPanelTabGroupState {
  isOpen: boolean;
}

export interface FixedPanelTabsState {
  version: typeof FIXED_PANEL_TABS_STATE_STORAGE_VERSION;
  secondary: FixedSecondaryPanelTabGroupState;
  lastUsedAt: number;
}

interface FixedPanelTabsStorageKeyArgs {
  threadId: string;
}

interface CreateFixedPanelTabsStateArgs {
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

interface NormalizeFixedPanelTabsStateArgs {
  state: FixedPanelTabsState;
}

interface StripTransientFixedPanelTabsStateForStorageArgs {
  state: FixedPanelTabsState;
}

interface NormalizeFixedPanelTabGroupStateArgs {
  group: FixedPanelTabGroupState;
}

interface CreateThreadStorageFilePreviewFixedPanelTabArgs {
  environmentId: string | null;
  isPinned: boolean;
  tab: ThreadStorageFileTabState;
  threadId: string;
}

interface CreateHostFilePreviewFixedPanelTabArgs {
  environmentId: string | null;
  hostId?: string | null;
  tab: HostFileTabState;
  threadId: string | null;
}

interface CreateWorkspaceFilePreviewFixedPanelTabArgs {
  environmentId: string | null;
  projectId: string | null;
  tab: WorkspaceFileTabState;
}

interface CreateTerminalFixedPanelTabArgs {
  terminalId: string;
  target?: TerminalCreateTarget;
}

interface CreatePluginPanelFixedPanelTabArgs {
  actionId: string;
  paramsJson: string | null;
  pluginId: string;
  title: string;
}

interface CreatePluginPageFixedPanelTabArgs {
  fixedTabId: string;
  pageId: string;
  pluginId: string;
}

interface BuildFixedPanelTabIdArgs {
  environmentId: string | null;
  kind: FixedPanelTab["kind"];
  path: string;
}

interface BuildWorkspaceFilePreviewTabIdArgs {
  environmentId: string | null;
  path: string;
  projectId: string | null;
}

interface BuildHostFilePreviewTabIdArgs {
  environmentId: string | null;
  hostId: string | null;
  path: string;
  threadId: string | null;
}

interface BuildThreadStorageFilePreviewTabIdArgs {
  path: string;
  threadId: string | null;
}

interface NormalizeFixedPanelTabGroupStateResult {
  activeTabId: string | null;
  tabs: readonly FixedPanelTab[];
}

function normalizeStorageSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function decodeStorageSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildFixedPanelTabId({
  environmentId,
  kind,
  path,
}: BuildFixedPanelTabIdArgs): string {
  return [
    kind,
    encodeURIComponent(path),
    encodeURIComponent(
      environmentId ?? SECONDARY_PANEL_TAB_ID_ENVIRONMENT_NONE,
    ),
  ].join(":");
}

function buildWorkspaceFilePreviewTabId({
  environmentId,
  path,
  projectId,
}: BuildWorkspaceFilePreviewTabIdArgs): string {
  return buildFixedPanelTabId({
    environmentId: environmentId ?? (projectId ? `project:${projectId}` : null),
    kind: "workspace-file-preview",
    path,
  });
}

function buildHostFilePreviewTabId({
  environmentId,
  hostId,
  path,
  threadId,
}: BuildHostFilePreviewTabIdArgs): string {
  if (hostId !== null) {
    return buildFixedPanelTabId({
      environmentId: `host:${hostId}`,
      kind: "host-file-preview",
      path,
    });
  }
  if (threadId === null || environmentId === null) {
    return buildFixedPanelTabId({
      environmentId: null,
      kind: "host-file-preview",
      path,
    });
  }
  return buildFixedPanelTabId({
    environmentId: `thread:${threadId}:environment:${environmentId}`,
    kind: "host-file-preview",
    path,
  });
}

function buildThreadStorageFilePreviewTabId({
  path,
  threadId,
}: BuildThreadStorageFilePreviewTabIdArgs): string {
  return buildFixedPanelTabId({
    environmentId: threadId === null ? null : `thread:${threadId}`,
    kind: "thread-storage-file-preview",
    path,
  });
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

export function createPluginPageFixedPanelTab({
  fixedTabId,
  pageId,
  pluginId,
}: CreatePluginPageFixedPanelTabArgs): PluginPageFixedPanelTab {
  return {
    fixedTabId,
    id: buildFixedPanelTabId({
      environmentId: null,
      kind: "plugin-page-fixed",
      path: `${pluginId}:${pageId}:${fixedTabId}`,
    }),
    kind: "plugin-page-fixed",
    pageId,
    pluginId,
  };
}

export function createPluginPanelFixedPanelTab({
  actionId,
  paramsJson,
  pluginId,
  title,
}: CreatePluginPanelFixedPanelTabArgs): PluginPanelFixedPanelTab {
  return {
    actionId,
    id: buildFixedPanelTabId({
      environmentId: null,
      kind: "plugin-panel",
      path: `${pluginId}:${actionId}:${paramsJson ?? ""}`,
    }),
    kind: "plugin-panel",
    paramsJson,
    pluginId,
    title,
  };
}

export function createWorkspaceFilePreviewFixedPanelTab({
  environmentId,
  projectId,
  tab,
}: CreateWorkspaceFilePreviewFixedPanelTabArgs): WorkspaceFilePreviewFixedPanelTab {
  return {
    environmentId,
    id: buildWorkspaceFilePreviewTabId({
      environmentId,
      path: tab.path,
      projectId,
    }),
    kind: "workspace-file-preview",
    lineRange: tab.lineRange,
    path: tab.path,
    projectId,
    source: tab.source,
    statusLabel: tab.statusLabel,
  };
}

export function createHostFilePreviewFixedPanelTab({
  environmentId,
  hostId = null,
  tab,
  threadId,
}: CreateHostFilePreviewFixedPanelTabArgs): HostFilePreviewFixedPanelTab {
  return {
    environmentId,
    hostId,
    id: buildHostFilePreviewTabId({
      environmentId,
      hostId,
      path: tab.path,
      threadId,
    }),
    kind: "host-file-preview",
    lineRange: tab.lineRange,
    path: tab.path,
    threadId,
  };
}

export function createThreadStorageFilePreviewFixedPanelTab({
  environmentId,
  isPinned,
  tab,
  threadId,
}: CreateThreadStorageFilePreviewFixedPanelTabArgs): ThreadStorageFilePreviewFixedPanelTab {
  return {
    environmentId,
    id: buildThreadStorageFilePreviewTabId({
      path: tab.path,
      threadId,
    }),
    isPinned,
    kind: "thread-storage-file-preview",
    lineRange: tab.lineRange,
    path: tab.path,
    threadId,
  };
}

export function createNewTabFixedPanelTab(): NewTabFixedPanelTab {
  return {
    id: NEW_TAB_TAB_ID,
    kind: "new-tab",
  };
}

export function ensureOpenFixedPanelHasActiveTab(
  state: FixedPanelTabsState,
): FixedPanelTabsState {
  if (!state.secondary.isOpen) {
    return state;
  }

  const activeTab = state.secondary.tabs.find(
    (tab) => tab.id === state.secondary.activeTabId,
  );
  if (activeTab !== undefined) {
    return state;
  }

  const fallbackTab = state.secondary.tabs[0];
  if (fallbackTab === undefined) {
    return {
      ...state,
      secondary: {
        ...state.secondary,
        activeTabId: null,
        isOpen: false,
      },
    };
  }

  return {
    ...state,
    secondary: {
      ...state.secondary,
      activeTabId: fallbackTab.id,
    },
  };
}

export function createTerminalFixedPanelTab({
  terminalId,
  target,
}: CreateTerminalFixedPanelTabArgs): TerminalFixedPanelTab {
  return {
    id: buildFixedPanelTabId({
      environmentId: null,
      kind: "terminal",
      path: terminalId,
    }),
    kind: "terminal",
    terminalId,
    ...(target !== undefined ? { target } : {}),
  };
}

function normalizeFixedPanelTabId(tab: FixedPanelTab): FixedPanelTab {
  switch (tab.kind) {
    case "thread-info":
      return tab.id === THREAD_INFO_TAB_ID
        ? tab
        : {
            ...tab,
            id: THREAD_INFO_TAB_ID,
          };
    case "git-diff":
      return tab.id === GIT_DIFF_TAB_ID
        ? tab
        : {
            ...tab,
            id: GIT_DIFF_TAB_ID,
          };
    case "plugin-page-fixed": {
      const id = createPluginPageFixedPanelTab({
        fixedTabId: tab.fixedTabId,
        pageId: tab.pageId,
        pluginId: tab.pluginId,
      }).id;
      return tab.id === id ? tab : { ...tab, id };
    }
    case "workspace-file-preview": {
      const id = buildWorkspaceFilePreviewTabId({
        environmentId: tab.environmentId,
        path: tab.path,
        projectId: tab.projectId,
      });
      return tab.id === id ? tab : { ...tab, id };
    }
    case "host-file-preview": {
      const id = buildHostFilePreviewTabId({
        environmentId: tab.environmentId,
        hostId: tab.hostId,
        path: tab.path,
        threadId: tab.threadId,
      });
      return tab.id === id ? tab : { ...tab, id };
    }
    case "thread-storage-file-preview": {
      const id = buildThreadStorageFilePreviewTabId({
        path: tab.path,
        threadId: tab.threadId,
      });
      return tab.id === id ? tab : { ...tab, id };
    }
    case "browser": {
      if (tab.desktopTarget !== undefined) return tab;
      const idSegments = tab.id.split(":");
      const browserPath =
        idSegments.length === 3 && idSegments[0] === "browser"
          ? decodeStorageSegment(idSegments[1] ?? "")
          : tab.id;
      const id = buildFixedPanelTabId({
        environmentId: tab.environmentId,
        kind: tab.kind,
        path: browserPath,
      });
      return tab.id === id ? tab : { ...tab, id };
    }
    case "new-tab":
      return tab.id === NEW_TAB_TAB_ID
        ? tab
        : {
            ...tab,
            id: NEW_TAB_TAB_ID,
          };
    case "plugin-panel": {
      const id = createPluginPanelFixedPanelTab({
        actionId: tab.actionId,
        paramsJson: tab.paramsJson,
        pluginId: tab.pluginId,
        title: tab.title,
      }).id;
      return tab.id === id ? tab : { ...tab, id };
    }
    case "terminal": {
      const id = buildFixedPanelTabId({
        environmentId: null,
        kind: tab.kind,
        path: tab.terminalId,
      });
      return tab.id === id ? tab : { ...tab, id };
    }
  }
}

function isTransientFixedPanelTab(tab: FixedPanelTab): boolean {
  return tab.kind === "new-tab";
}

function normalizeFixedPanelTabGroupState({
  group,
}: NormalizeFixedPanelTabGroupStateArgs): NormalizeFixedPanelTabGroupStateResult {
  const seenTabIds = new Set<string>();
  const tabs: FixedPanelTab[] = [];
  let activeTabId: string | null = null;
  for (const tab of group.tabs) {
    const normalizedTab = normalizeFixedPanelTabId(tab);
    if (
      isTransientFixedPanelTab(normalizedTab) ||
      seenTabIds.has(normalizedTab.id)
    ) {
      continue;
    }
    seenTabIds.add(normalizedTab.id);
    tabs.push(normalizedTab);
    if (
      group.activeTabId !== null &&
      (tab.id === group.activeTabId || normalizedTab.id === group.activeTabId)
    ) {
      activeTabId = normalizedTab.id;
    }
  }

  return {
    tabs,
    activeTabId,
  };
}

function normalizeFixedSecondaryPanelTabGroupState(
  group: FixedSecondaryPanelTabGroupState,
): FixedSecondaryPanelTabGroupState {
  return {
    ...normalizeFixedPanelTabGroupState({
      group,
    }),
    isOpen: group.isOpen,
  };
}

function stripTransientFixedPanelTabForStorage(
  tab: FixedPanelTab,
): FixedPanelTab {
  switch (tab.kind) {
    case "workspace-file-preview":
    case "host-file-preview":
    case "thread-storage-file-preview":
      return {
        ...tab,
        lineRange: null,
      };
    case "thread-info":
    case "git-diff":
    case "plugin-page-fixed":
    case "browser":
    case "new-tab":
    case "terminal":
      return tab;
    case "plugin-panel":
      return tab.fileOpenerOwner === undefined
        ? tab
        : {
            ...tab,
            fileOpenerOwner: stripFileOpenerOwnerForStorage(
              tab.fileOpenerOwner,
            ),
          };
  }
}

function stripFileOpenerOwnerForStorage(
  owner: ThreadTabFileOpenerOwner,
): ThreadTabFileOpenerOwner {
  switch (owner.kind) {
    case "workspace-file-preview":
      return { ...owner, tab: { ...owner.tab, lineRange: null } };
    case "host-file-preview":
      return { ...owner, tab: { ...owner.tab, lineRange: null } };
    case "thread-storage-file-preview":
      return { ...owner, tab: { ...owner.tab, lineRange: null } };
  }
}

function stripTransientFixedPanelTabsStateForStorage({
  state,
}: StripTransientFixedPanelTabsStateForStorageArgs): FixedPanelTabsState {
  return {
    ...state,
    secondary: {
      ...state.secondary,
      tabs: state.secondary.tabs.map(stripTransientFixedPanelTabForStorage),
    },
  };
}

function normalizeFixedPanelTabsState({
  state,
}: NormalizeFixedPanelTabsStateArgs): FixedPanelTabsState {
  const normalizedSecondary = normalizeFixedSecondaryPanelTabGroupState(
    state.secondary,
  );

  return {
    version: state.version,
    secondary: normalizedSecondary,
    lastUsedAt: state.lastUsedAt,
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
  return key.startsWith(`${FIXED_PANEL_TABS_STATE_STORAGE_PREFIX}-`);
}

function isFixedPanelTabsStateExpired({
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
  if (!stateResult.success) {
    return {
      shouldPrune: true,
      state: initialValue,
    };
  }

  const normalizedState = stripTransientFixedPanelTabsStateForStorage({
    state: normalizeFixedPanelTabsState({
      state: stateResult.data,
    }),
  });
  if (isFixedPanelTabsStateExpired({ now, state: normalizedState })) {
    return {
      shouldPrune: true,
      state: initialValue,
    };
  }

  return {
    shouldPrune: false,
    state: ensureOpenFixedPanelHasActiveTab(normalizedState),
  };
}

export function shouldPruneStoredFixedPanelTabsState(
  storedValue: string | null,
  now: number,
): boolean {
  if (storedValue === null) {
    return false;
  }
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(storedValue);
  } catch {
    return true;
  }
  if (typeof parsedValue !== "object" || parsedValue === null) {
    return true;
  }
  const lastUsedAt = Reflect.get(parsedValue, "lastUsedAt");
  if (
    typeof lastUsedAt === "number" &&
    Number.isInteger(lastUsedAt) &&
    lastUsedAt >= 0
  ) {
    if (now - lastUsedAt > FIXED_PANEL_TABS_IDLE_EXPIRY_MS) {
      return true;
    }
    return !fixedPanelTabsStateSchema.safeParse(parsedValue).success;
  }
  return parseFixedPanelTabsStateForStorage({
    initialValue: EMPTY_FIXED_PANEL_TABS_STATE,
    now,
    storedValue,
  }).shouldPrune;
}

export function serializeFixedPanelTabsState({
  state,
}: SerializeFixedPanelTabsStateArgs): string {
  return JSON.stringify(
    stripTransientFixedPanelTabsStateForStorage({
      state: normalizeFixedPanelTabsState({ state }),
    }),
  );
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
    case "new-tab":
      return true;
    case "plugin-page-fixed":
      return (
        b.kind === "plugin-page-fixed" &&
        a.pluginId === b.pluginId &&
        a.pageId === b.pageId &&
        a.fixedTabId === b.fixedTabId
      );
    case "plugin-panel":
      return (
        b.kind === "plugin-panel" &&
        a.pluginId === b.pluginId &&
        a.actionId === b.actionId &&
        a.paramsJson === b.paramsJson &&
        areFileOpenerOwnersEqual(a.fileOpenerOwner, b.fileOpenerOwner) &&
        a.title === b.title
      );
    case "workspace-file-preview":
      return (
        b.kind === "workspace-file-preview" &&
        a.environmentId === b.environmentId &&
        areFilePreviewLineRangesEqual({
          a: a.lineRange,
          b: b.lineRange,
        }) &&
        a.path === b.path &&
        a.projectId === b.projectId &&
        areEnvironmentFilePreviewSourcesEqual(a.source, b.source) &&
        a.statusLabel === b.statusLabel
      );
    case "host-file-preview":
      return (
        b.kind === "host-file-preview" &&
        a.environmentId === b.environmentId &&
        a.hostId === b.hostId &&
        areFilePreviewLineRangesEqual({
          a: a.lineRange,
          b: b.lineRange,
        }) &&
        a.path === b.path &&
        a.threadId === b.threadId
      );
    case "browser":
      return (
        b.kind === "browser" &&
        a.desktopTarget?.hostId === b.desktopTarget?.hostId &&
        a.desktopTarget?.instanceId === b.desktopTarget?.instanceId &&
        a.desktopTarget?.generation === b.desktopTarget?.generation &&
        a.environmentId === b.environmentId &&
        a.url === b.url &&
        a.title === b.title
      );
    case "thread-storage-file-preview":
      return (
        b.kind === "thread-storage-file-preview" &&
        a.environmentId === b.environmentId &&
        a.isPinned === b.isPinned &&
        areFilePreviewLineRangesEqual({
          a: a.lineRange,
          b: b.lineRange,
        }) &&
        a.path === b.path &&
        a.threadId === b.threadId
      );
    case "terminal":
      return (
        b.kind === "terminal" &&
        a.terminalId === b.terminalId &&
        JSON.stringify(a.target) === JSON.stringify(b.target)
      );
  }
}

function areFileOpenerOwnersEqual(
  a: ThreadTabFileOpenerOwner | undefined,
  b: ThreadTabFileOpenerOwner | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (
    a.kind !== b.kind ||
    a.environmentId !== b.environmentId ||
    a.threadId !== b.threadId ||
    a.tab.path !== b.tab.path ||
    !areFilePreviewLineRangesEqual({
      a: a.tab.lineRange,
      b: b.tab.lineRange,
    })
  ) {
    return false;
  }
  if (a.kind === "host-file-preview") {
    return b.kind === "host-file-preview" && a.hostId === b.hostId;
  }
  if (a.kind !== "workspace-file-preview") return true;
  return (
    b.kind === "workspace-file-preview" &&
    a.projectId === b.projectId &&
    areEnvironmentFilePreviewSourcesEqual(a.tab.source, b.tab.source) &&
    a.tab.statusLabel === b.tab.statusLabel
  );
}
