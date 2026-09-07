import type { ComponentPropsWithoutRef, ComponentType, ReactNode } from "react";
import type {
  PermissionMode,
  PromptInput,
  ProviderInfo,
  ReasoningLevel,
  ServiceTier,
} from "@bb/domain";
import type {
  CreateExecutionInputSources,
  CreateThreadEnvironmentArgs,
} from "@bb/server-contract";
import type { JsonValue } from "./json-value.js";
import type {
  PluginRpcCallArgs,
  PluginRpcContract,
  PluginRpcResult,
} from "./rpc-contract.js";

/**
 * The `@get-bb/plugin-sdk/app` contract (plugin design §5.2) — pure types with no
 * side effects. The BB app imports these to keep its real implementation in
 * sync (`satisfies PluginSdkApp`). Plugin authors import the same shapes through
 * `@get-bb/plugin-sdk/app`.
 *
 * Per-slot props are versioned contracts: additive-only within an SDK major.
 */

// ---------------------------------------------------------------------------
// Slot props (the versioned per-slot contracts).
// ---------------------------------------------------------------------------

/** Props passed to a `homepageSection` component. */
export interface PluginHomepageSectionProps {
  /** Project in view on the compose surface; null when none is selected. */
  projectId: string | null;
}

/**
 * Props passed to a `settingsSection` component.
 *
 * Deliberately empty in V1; versioned additive like the other slot props.
 */
export interface PluginSettingsSectionProps {}

/**
 * Props passed to an `experimental_appOverlay` component.
 *
 * Deliberately empty while the component reads live app state through SDK
 * hooks; versioned additive like the other slot props.
 */
export interface ExperimentalAppOverlayProps {}

/** Props passed to a `navPanel` component (it owns its whole route). */
export interface PluginNavPanelProps {
  /**
   * The route remainder after the panel root, "" at the root. The panel's
   * route is `/plugins/<pluginId>/<path>/*`, so a deep link like
   * `/plugins/notes/notes/work/ideas.md` renders the panel with
   * `subPath: "work/ideas.md"`. Navigate within the panel via
   * `useBbNavigate().toPluginPanel(path, { subPath })` — browser
   * back/forward then walks panel-internal history.
   */
  subPath: string;
}

/**
 * Props passed to a panel tab opened by a `threadPanelAction`.
 *
 * This slot is rendered only for an existing thread. Use
 * `experimental_newThreadPanelAction` for the root New thread screen.
 */
export interface PluginThreadPanelProps {
  threadId: string;
  /**
   * The JSON value the action's `openPanel` call passed (round-tripped
   * through persistence, so the tab restores across reloads); null when the
   * action opened the panel without params.
   */
  params: JsonValue | null;
}

/** Props passed to a panel tab opened by `experimental_newThreadPanelAction`. */
export interface PluginNewThreadPanelProps {
  /** Project selected in the root composer; null in projectless compose. */
  projectId: string | null;
  /**
   * The JSON value the action's `openPanel` call passed (round-tripped
   * through persistence, so the tab restores across reloads); null when the
   * action opened the panel without params.
   */
  params: JsonValue | null;
}

export interface PluginPendingInteractionView {
  id: string;
  threadId: string;
  title: string;
  payload: JsonValue;
  createdAt: number;
  expiresAt: number | null;
}

export interface PluginPendingInteractionProps {
  interaction: PluginPendingInteractionView;
  submit(value: JsonValue): Promise<void>;
  cancel(): Promise<void>;
}

/**
 * Props for a `sidebarFooterAction` — host-rendered (no plugin component).
 * Deliberately empty; the registration's `run` carries the behavior.
 */
export interface PluginSidebarFooterActionProps {}

/** Props passed to an experimental sidebar-footer disclosure component. */
export interface ExperimentalSidebarFooterDisclosureProps {
  /** Hide this disclosure without affecting another plugin's open disclosure. */
  dismiss(): void;
}

/** Display and accessibility metadata for a host-owned sidebar shortcut. */
export interface ExperimentalSidebarNavigationShortcut {
  label: string;
  ariaKeyShortcuts: string;
}

/** Host-owned behavior represented by one sidebar navigation item. */
export type ExperimentalSidebarNavigationAction =
  | { kind: "new-thread" }
  | { kind: "search-threads" }
  | { kind: "open-extensions" }
  | {
      kind: "open-plugin-panel";
      pluginId: string;
      panelId: string;
    };

/** Semantic icon identity for one sidebar navigation item. */
export type ExperimentalSidebarNavigationIcon =
  | { kind: "host"; name: "new-thread" | "search" | "extensions" }
  | { kind: "plugin"; pluginId: string; icon: string | null };

/** One host-owned destination or action a plugin may arrange. */
export interface ExperimentalSidebarNavigationItem {
  id: string;
  label: string;
  icon: ExperimentalSidebarNavigationIcon;
  action: ExperimentalSidebarNavigationAction;
  isDisabled: boolean;
  shortcut: ExperimentalSidebarNavigationShortcut | null;
  experimental_splitProps: {
    onPointerDown?: (event: import("react").PointerEvent<HTMLElement>) => void;
  };
}

/** How the host should activate a sidebar navigation item. */
export interface ExperimentalSidebarNavigationActivationOptions {
  openInSplit: boolean;
}

/** Props passed to an `experimental_sidebarNavigation` component. */
export interface ExperimentalSidebarNavigationProps {
  items: readonly ExperimentalSidebarNavigationItem[];
  activeItemId: string | null;
  isCompactViewport: boolean;
  experimental_activate(
    itemId: string,
    options: ExperimentalSidebarNavigationActivationOptions,
  ): void;
  experimental_Original: ComponentType;
}

/**
 * Props passed to an `experimental_threadList` component — the sidebar's
 * scrolling thread area, replaced wholesale by one plugin.
 */
export interface PluginThreadListProps {
  /** The thread the route currently shows; null on non-thread routes. */
  activeThreadId: string | null;
  /** The project the route currently shows; null when none is selected. */
  activeProjectId: string | null;
  /** True on phone-width viewports and coarse pointers. */
  isCompactViewport: boolean;
  /**
   * Call after the user opens a thread. It closes the mobile sidebar drawer.
   */
  onNavigate: () => void;
  /**
   * Compatibility value for the former sidebar search field. BB now searches
   * threads in the quick palette, so the host always supplies "".
   *
   * @deprecated The quick palette owns thread search. Ignore this value.
   */
  searchQuery: string;
  /**
   * BB's thread list, bound to this sidebar instance. Render it to delegate
   * conditionally without re-entering plugin replacement resolution.
   *
   * @experimental Audit before relying on this as a stable contract.
   */
  Original: ComponentType;
  /** @deprecated Renamed to `Original` in SDK 0.4.16; removed in bb 0.42. */
  experimental_Original?: ComponentType;
}

/**
 * Props passed to an `experimental_threadHeaderAction` component, rendered in
 * the thread header's action row.
 */
export interface PluginThreadHeaderActionProps {
  /**
   * The thread this header belongs to. Never null: the slot is not rendered
   * on the compose screen or other non-thread routes. A split layout renders
   * one header per pane, so the component mounts once per visible thread,
   * each with its own id — keep per-thread state in the component, never in a
   * module-level singleton.
   */
  threadId: string;
  projectId: string;
  /**
   * True on phone-width viewports and coarse pointers. Collapse to an
   * icon-sized control when it is true — the row is short.
   */
  isCompactViewport: boolean;
}

/**
 * Where a file being opened by a `fileOpener` lives. `path` semantics follow
 * the source: workspace paths are relative to the environment's worktree,
 * thread-storage paths are relative to the thread's storage root, host paths
 * are absolute on the thread's host.
 */
export interface PluginFileOpenerSource {
  kind: "workspace" | "host" | "thread-storage";
  threadId: string | null;
  environmentId: string | null;
  projectId: string | null;
  /**
   * Explicit host selected for a project-backed workspace file. Omitted when
   * the source is resolved by its environment/thread or the primary host.
   *
   * @experimental Audit before relying on this as a stable contract.
   */
  experimental_hostId?: string;
}

/** Props passed to a `fileOpener` component (rendered as a panel file tab). */
export interface PluginFileOpenerProps {
  path: string;
  source: PluginFileOpenerSource;
  /**
   * BB's file preview, bound to this file. Render it to delegate conditionally
   * without re-entering plugin replacement resolution.
   *
   * @experimental Audit before relying on this as a stable contract.
   */
  Original: ComponentType;
  /** @deprecated Renamed to `Original` in SDK 0.4.16; removed in bb 0.42. */
  experimental_Original?: ComponentType;
}

// ---------------------------------------------------------------------------
// Host-owned code rendering (SourceCode / Diff) — the public components and
// the props their replacements receive.
// ---------------------------------------------------------------------------

/** How a code line longer than the viewport is presented. */
export type CodeOverflowMode = "scroll" | "wrap";

/** How a diff presents its two sides. */
export type DiffViewMode = "unified" | "split";

/** A 1-based, inclusive line range. */
export interface SourceCodeLineRange {
  start: number;
  end: number;
}

/** One complete text side of a diff, resolved by the caller. */
export interface ExperimentalDiffFileContent {
  /** File path for this side. May differ between `old` and `new` for a rename. */
  path: string;
  /** Complete UTF-8 file contents, including unchanged lines outside the patch. */
  content: string;
}

/** Complete text contents for both sides of a diff. */
export interface ExperimentalDiffFullFileContents {
  old: ExperimentalDiffFileContent;
  new: ExperimentalDiffFileContent;
}

/**
 * Props of the host-owned `experimental_SourceCode` component — BB's source
 * viewer. The host owns syntax highlighting, gutters, wrapping, line-selection
 * presentation, and the live BB code theme; the caller owns loading the text
 * and any surrounding chrome.
 */
export interface SourceCodeProps {
  /** The complete source text to render. */
  content: string;
  /** File path or name. Drives language detection and the a11y label. */
  path: string;
  /** Long-line presentation. Defaults to `"scroll"`. */
  overflow?: CodeOverflowMode;
  /**
   * Lines to highlight and scroll into view (1-based, inclusive). Defaults to
   * `null` — nothing highlighted.
   */
  highlightedLines?: SourceCodeLineRange | null;
  /** Applied to the renderer's root element. */
  className?: string;
}

/**
 * Props of the host-owned `experimental_Diff` component — BB's diff viewer.
 * The host owns patch normalization (a patch without a `diff --git` header is
 * completed from `path`), syntax highlighting, unified/split presentation,
 * gutters, line-selection presentation, optional full-file context expansion,
 * and the live BB code theme. Content that cannot be parsed as a patch
 * degrades to plain monospace text.
 */
export interface DiffProps {
  /** Unified patch text for exactly ONE file. */
  patch: string;
  /**
   * The file the patch applies to. Used to complete a patch that arrives
   * without a `diff --git` header (GitHub's REST patches, single `@@` hunks)
   * and for language detection.
   */
  path: string;
  /** Side-by-side or inline. Defaults to `"unified"`. */
  view?: DiffViewMode;
  /** Long-line presentation. Defaults to `"scroll"`. */
  overflow?: CodeOverflowMode;
  /** Whether the gutter shows line numbers. Defaults to `true`. */
  showLineNumbers?: boolean;
  /**
   * Complete text for both file sides. When present and consistent with the
   * patch, BB enables expand-context controls between hunks. The caller owns
   * loading these contents; omit the field to render from the patch alone.
   */
  experimental_fullFileContents?: ExperimentalDiffFullFileContents;
  /** Applied to the renderer's root element. */
  className?: string;
}

/**
 * Props passed to an `experimental_sourceCodeRenderer` component. Every value
 * is already resolved — the replacement never re-applies a host default.
 */
export interface PluginSourceCodeRendererProps {
  content: string;
  path: string;
  overflow: CodeOverflowMode;
  highlightedLines: SourceCodeLineRange | null;
  /**
   * BB's source renderer, bound to this request. Render it to delegate
   * conditionally without re-entering plugin replacement resolution.
   *
   * @experimental Audit before relying on this as a stable contract.
   */
  Original: ComponentType;
  /** @deprecated Renamed to `Original` in SDK 0.4.16; removed in bb 0.42. */
  experimental_Original?: ComponentType;
}

/**
 * Props passed to an `experimental_diffRenderer` component. `patch` is always
 * a complete single-file unified patch, whatever shape the caller supplied,
 * and optional full-file context is resolved to an object or `null`.
 */
export interface PluginDiffRendererProps {
  patch: string;
  path: string;
  view: DiffViewMode;
  overflow: CodeOverflowMode;
  showLineNumbers: boolean;
  /**
   * Caller-resolved text for both sides, or `null` when the caller supplied
   * only the patch. A replacement can use this to implement context expansion,
   * but must verify that the paths and hunk lines agree with `patch` before
   * treating the contents as complete. BB's original renderer performs that
   * verification when it mounts.
   */
  experimental_fullFileContents: ExperimentalDiffFullFileContents | null;
  /**
   * BB's diff renderer, bound to this request. Render it to delegate
   * conditionally without re-entering plugin replacement resolution.
   *
   * @experimental Audit before relying on this as a stable contract.
   */
  Original: ComponentType;
  /** @deprecated Renamed to `Original` in SDK 0.4.16; removed in bb 0.42. */
  experimental_Original?: ComponentType;
}

/**
 * Message context passed to a `messageDirective` component — the assistant
 * (or nested agent) message that contained the directive.
 */
export interface PluginMessageDirectiveMessage {
  id: string;
  threadId: string;
  turnId: string | null;
  projectId: string | null;
}

/**
 * Open a worktree-relative file in the host's workspace file viewer. Returns
 * true when the host accepted the path; false when the path is invalid or the
 * viewer declined it.
 */
export type PluginMessageDirectiveOpenWorkspaceFile = (path: string) => boolean;

/**
 * Props passed to a `messageDirective` component. Attributes are untrusted
 * strings parsed from the directive; the plugin validates its own fields.
 */
export interface PluginMessageDirectiveProps {
  /** Parsed, untrusted directive attributes (e.g. `{ file: "demo.html" }`). */
  attributes: Readonly<Record<string, string>>;
  /** Original directive source text (useful for diagnostics / crash fallback). */
  source: string;
  message: PluginMessageDirectiveMessage;
  /**
   * Opens a worktree-relative file in the host's workspace file viewer. Null
   * when the message surface has no workspace viewer available.
   */
  openWorkspaceFile: PluginMessageDirectiveOpenWorkspaceFile | null;
}

// ---------------------------------------------------------------------------
// Slot registrations (the arguments to `app.slots.*`).
// ---------------------------------------------------------------------------

export interface PluginHomepageSectionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  title: string;
  component: ComponentType<PluginHomepageSectionProps>;
}

export interface PluginSettingsSectionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Optional host-rendered section heading. */
  title?: string;
  /**
   * Optional one-line host-rendered subheading under `title`, in the built-in
   * SettingsSection idiom (ignored when `title` is absent).
   */
  description?: string;
  component: ComponentType<PluginSettingsSectionProps>;
}

/**
 * Render app-wide plugin UI outside BB's layout regions.
 *
 * The host mounts each registration once per app window through the ordinary
 * plugin React boundary. The component therefore keeps PluginContext, router,
 * query, realtime, and other app-level SDK contexts when it renders fixed UI
 * or creates a React portal. BB supplies no chrome, positioning, visibility,
 * or interaction policy; the plugin owns those details and responsive
 * behavior. Registrations are additive and a crash hides only that overlay.
 */
export interface ExperimentalAppOverlayRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  component: ComponentType<ExperimentalAppOverlayProps>;
}

/**
 * Owner-defined validator for a fixed tab's transient target. The host first
 * verifies that the value is JSON-safe, then calls this validator before
 * selecting the tab or delivering the target.
 */
export interface ExperimentalFixedTabTargetContract<Target extends JsonValue> {
  validate(value: JsonValue): value is Target;
}

/** Stable, owner-scoped reference used by the app-panel controller. */
export type ExperimentalPluginFixedTabReference<
  Target extends JsonValue = never,
> = {
  /** The owning `navPanel` id; validated against the containing registration. */
  readonly panelId: string;
  /** Unique within the owning nav panel; letters, digits, `-`, `_`. */
  readonly id: string;
} & ([Target] extends [never]
  ? {
      /** An untargeted tab cannot be opened with a target. */
      readonly experimental_target?: never;
    }
  : {
      /** Owner validation required before the host delivers a target. */
      readonly experimental_target: ExperimentalFixedTabTargetContract<Target>;
    });

/** A fixed tab declared by a plugin nav panel. */
export type PluginFixedTabRegistration<Target extends JsonValue = never> =
  ExperimentalPluginFixedTabReference<Target> & {
    title: string;
    /** Icon hint (BB icon name); unknown names fall back to a generic icon. */
    icon: string;
    component: ComponentType<PluginNavPanelProps>;
    /** `flush` lets the component own padding and scrolling. */
    layout?: "padded" | "flush";
  };

/** A fixed tab with either no target or an owner-validated JSON target. */
export type PluginFixedTabDeclaration =
  | PluginFixedTabRegistration
  | PluginFixedTabRegistration<JsonValue>;

export interface PluginNavPanelRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  title: string;
  /** Icon hint (BB icon name); unknown names fall back to a generic icon. */
  icon: string;
  /** URL segment under `/plugins/<pluginId>/`; letters, digits, `-`, `_`. */
  path: string;
  component: ComponentType<PluginNavPanelProps>;
  /**
   * Ordered, non-closable tabs shown in this page's host-owned right panel.
   * BB owns selection and persistence and always includes its native Browser
   * and Terminal tools beside them. One tab is active in each visible split
   * pane, so multiple fixed-tab components can be mounted concurrently. A
   * component mounts only while its tab is active in a visible pane and the
   * panel is open, and receives the same `subPath` as the page component.
   *
   * Experimental: see docs/api_to_audit.md.
   */
  fixedTabs?: readonly PluginFixedTabDeclaration[];
  /**
   * Optional presentational component rendered at the trailing edge of this
   * panel's sidebar row. It receives no props so it can own a narrow live
   * value through the ordinary SDK hooks without coupling that state to the
   * host sidebar. The host does not mount it on compact viewports and clips it
   * to a small, single-line box on wider viewports. It shares the trailing
   * action column, fading out for the host's options button on hover or focus;
   * do not render controls or rely on unbounded content here.
   *
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_sidebarAccessory?: ComponentType;
  /**
   * Optional component rendered on the right side of the shared title bar
   * (e.g. a sync button or a count). Contained separately from the body: a
   * throwing headerContent is hidden without breaking the title bar.
   */
  headerContent?: ComponentType<PluginNavPanelProps>;
}

/**
 * What a plugin action passes when it asks the host to open one of its panel
 * tabs. Shared by every `openPanel` entry point so a plugin registering more
 * than one kind of action can write a single open routine;
 * `PluginTargetedPanelActionOpenOptions` adds the `actionId` a caller
 * outside a panel action must pass to name the panel it wants.
 */
export interface PluginPanelActionOpenOptions {
  /** Tab label. Default: the action's `title`. */
  title?: string;
  /**
   * Persisted with the tab and handed to the component as its `params` prop.
   * Must be a JSON value; anything else is a declined open.
   */
  params?: JsonValue;
}

/**
 * Context handed to a `threadPanelAction`'s `run`.
 *
 * The action is thread-only and is never offered on the root New thread
 * screen, so `threadId` is always present.
 */
export interface PluginThreadPanelActionContext {
  /** The thread whose panel launcher invoked the action. */
  threadId: string;
  /**
   * Open a tab in the thread's side panel rendering this action's
   * `component`. `title` labels the tab (default: the action's `title`);
   * `params` must be JSON-serializable — it is persisted with the tab and
   * reaches the component as its `params` prop. Opening with params
   * identical to an already-open tab of this action focuses that tab
   * (updating its title) instead of duplicating it. May be called more than
   * once (different params ⇒ multiple tabs) or not at all.
   *
   * Returns true when the host accepted the open; false when it declined —
   * from this launcher, only a `params` that is not a JSON value. The true /
   * false contract is shared with `messageAction`'s `openPanel` and
   * `useBbNavigate().openThreadPanel` (which decline for more reasons) so one
   * open routine can serve every action kind. A decline is never thrown: the
   * host logs it and reports it here.
   */
  openPanel(options?: PluginPanelActionOpenOptions): boolean;
}

export interface PluginThreadPanelActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label of the action row in the panel's new-tab launcher. */
  title: string;
  /**
   * Icon hint (BB icon name) used when the plugin ships no logo; the
   * launcher row and opened tabs prefer the plugin's logo.
   */
  icon?: string;
  /** Rendered inside every panel tab this action opens. */
  component: ComponentType<PluginThreadPanelProps>;
  /**
   * How the host frames the tab content. "padded" (default) wraps the
   * component in the panel's scroll container with standard padding —
   * right for document-like content. "flush" gives the component the full
   * tab area (no padding, definite height, no host scrolling) — right for
   * app-like content that manages its own layout, such as
   * `ThreadChat`.
   */
  layout?: "padded" | "flush";
  /**
   * Runs when the user activates the action: call your RPC methods, show a
   * toast, and/or open panel tabs via `context.openPanel`. Omitted =
   * immediately open a panel tab with defaults. Errors (sync or async) are
   * contained and logged; they never break the launcher.
   */
  run?(context: PluginThreadPanelActionContext): void | Promise<void>;
}

/** Context handed to an `experimental_newThreadPanelAction`'s `run`. */
export interface PluginNewThreadPanelActionContext {
  /** Project selected in the root composer; null in projectless compose. */
  projectId: string | null;
  /**
   * Open a tab in the root New thread screen's side panel rendering this
   * action's `component`. The title, params, deduplication, return value, and
   * error semantics match `threadPanelAction`.
   */
  openPanel(options?: PluginPanelActionOpenOptions): boolean;
}

/** Registration for the root New thread screen's panel Actions list. */
export interface PluginNewThreadPanelActionRegistration {
  /** Unique within this slot for the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label of the action row in the panel's new-tab launcher. */
  title: string;
  /** Icon hint (BB icon name) used when the plugin ships no logo. */
  icon?: string;
  /** Rendered inside every panel tab this action opens. */
  component: ComponentType<PluginNewThreadPanelProps>;
  /** Host framing; matches `threadPanelAction`. */
  layout?: "padded" | "flush";
  /**
   * Runs when the user activates the action. Omitted = immediately open a
   * panel tab with defaults. Errors are contained and logged.
   */
  run?(context: PluginNewThreadPanelActionContext): void | Promise<void>;
}

export interface PluginPendingInteractionRegistration {
  /**
   * The renderer's plugin-local name. Two addresses resolve to it: the
   * `rendererId` a backend passes to `bb.ui.requestInput`, and the `<name>`
   * half of a provider bridge's `interaction/request` kind
   * `"<pluginId>/<name>"` (docs/provider-plugin-api.md §4), which the client
   * splits on the slash to find this registration under its plugin.
   * `bb.ui.requestInput` validates `rendererId` against `/^[a-zA-Z0-9_-]+$/`;
   * an extension kind must match `/^[a-z0-9-]+\/[a-z0-9-]+$/`
   * (`EXTENSION_KIND_PATTERN` in @bb/domain), so an id addressable both ways
   * uses lowercase letters, digits, and "-" only.
   */
  id: string;
  component: ComponentType<PluginPendingInteractionProps>;
}

/** Context handed to a `sidebarFooterAction`'s `run`. */
export interface PluginSidebarFooterActionContext {
  /**
   * Navigate to this plugin's detail page in Tools, where declarative settings
   * and `settingsSection` slots render.
   */
  openSettings(): void;
}

/**
 * An icon button in the app sidebar footer (next to Settings / bug report).
 * Host-rendered for consistent chrome — plugins supply icon, label, and
 * `run` behavior only.
 */
export interface PluginSidebarFooterActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Tooltip and accessible label for the icon button. */
  title: string;
  /** Icon hint (BB icon name); unknown names fall back to a generic icon. */
  icon: string;
  /**
   * Runs when the user activates the action (e.g. call `openSettings()`,
   * open a panel via other surfaces, toast). Errors (sync or async) are
   * contained and logged; they never break the sidebar.
   */
  run(context: PluginSidebarFooterActionContext): void | Promise<void>;
}

/** Context handed to an experimental sidebar-footer action. */
export interface ExperimentalSidebarFooterActionContext {
  /** Navigate to this plugin's detail page in Tools. */
  openPluginDetails(): void;
}

/** Fields shared by both experimental sidebar-footer item behaviors. */
export interface ExperimentalSidebarFooterItemBase {
  /** Unique within the plugin's unified sidebar footer; letters, digits, `-`, `_`. */
  id: string;
  /** Tooltip and accessible label for the host-rendered icon button. */
  label: string;
  /** BB icon-name hint; unknown names fall back to a generic icon. */
  icon: string;
}

/** A sidebar-footer item that runs a callback when activated. */
export interface ExperimentalSidebarFooterActionRegistration extends ExperimentalSidebarFooterItemBase {
  kind: "action";
  onActivate(
    context: ExperimentalSidebarFooterActionContext,
  ): void | Promise<void>;
}

/** A sidebar-footer item that reveals plugin-rendered content above the row. */
export interface ExperimentalSidebarFooterDisclosureRegistration extends ExperimentalSidebarFooterItemBase {
  kind: "disclosure";
  component: ComponentType<ExperimentalSidebarFooterDisclosureProps>;
}

/** One host-rendered item in the app sidebar footer. */
export type ExperimentalSidebarFooterItemRegistration =
  | ExperimentalSidebarFooterActionRegistration
  | ExperimentalSidebarFooterDisclosureRegistration;

/** Live controls for an experimental sidebar-footer disclosure. */
export interface ExperimentalSidebarFooterDisclosureController {
  /** Request that the host open this disclosure, replacing any open sibling. */
  open(): void;
  /** Close this disclosure if it is currently open. */
  close(): void;
  /** Open this disclosure, or close it when it is currently open. */
  toggle(): void;
}

/** Managed registration surface for items in the app sidebar footer. */
export interface ExperimentalSidebarFooter {
  register(registration: ExperimentalSidebarFooterActionRegistration): void;
  register(
    registration: ExperimentalSidebarFooterDisclosureRegistration,
  ): ExperimentalSidebarFooterDisclosureController;
}

// ---------------------------------------------------------------------------
// Sidebar thread data (the `experimental_useSidebarThreads` contract).
// ---------------------------------------------------------------------------

/**
 * The one status bb would paint for a thread, already resolved through the
 * host's precedence (attention before work; plan and goal before the generic
 * spinner). Draw your own glyph for it — the SDK ships no status component.
 *
 * Treat an unrecognized value as "none": bb adds kinds over time, and an
 * older plugin must degrade to drawing nothing rather than throwing.
 *
 * "draft" and "working-draft" are never reported here: an unsubmitted composer
 * draft is per-client state the host reads per row, which an array-wide view
 * cannot. A thread holding a draft reports whatever it would report without
 * one.
 */
export type PluginSidebarThreadIndicator =
  | "unread-error"
  | "waiting-for-input"
  | "working-draft"
  | "workflow"
  | "background-agent"
  | "background-command"
  | "plan-mode"
  | "goal"
  | "runtime"
  | "draft"
  | "unread-success"
  | "none";

/**
 * How a thread's environment presents its workspace: a worktree bb manages,
 * a worktree the user manages, or anything else (a plain checkout).
 */
export type PluginSidebarWorkspaceKind =
  | "managed-worktree"
  | "unmanaged-worktree"
  | "other";

/** Live work counts on a thread. All zero means nothing is running. */
export interface PluginSidebarThreadActivity {
  workflows: number;
  backgroundAgents: number;
  backgroundCommands: number;
  planMode: number;
  goals: number;
}

/**
 * One thread in the sidebar's live view.
 *
 * A deliberate copy of the fields a sidebar needs — not a re-export of the
 * host's internal thread row type, which changes whenever the app needs a
 * field. Timestamps are epoch milliseconds.
 */
export interface PluginSidebarThread {
  id: string;
  projectId: string;
  /** Null while a thread is still unnamed; pair with `titleFallback`. */
  title: string | null;
  titleFallback: string | null;
  /** The thread this one was forked from or spawned under; null at the root. */
  parentThreadId: string | null;
  sectionId: string | null;
  /** How this thread came to exist under its parent; null for root threads. */
  originKind: "fork" | null;
  /** The plugin that spawned it, or null for non-plugin origins. */
  originPluginId: string | null;
  /** The agent provider this thread runs on; resolve it through
   * {@link PluginSdkApp.experimental_useProviders} for a name and icon. */
  providerId: string;

  /** The agent is blocked on the user: an approval or a question. */
  hasPendingInteraction: boolean;
  activity: PluginSidebarThreadActivity;
  indicator: PluginSidebarThreadIndicator;
  /**
   * The host's accessible label for `indicator`, e.g. "Thread needs user
   * input"; null when the indicator is "none". Use it for `aria-label` so
   * screen-reader text stays consistent across sidebars.
   */
  indicatorLabel: string | null;

  isUnread: boolean;
  isPinned: boolean;
  isArchived: boolean;

  environment: {
    id: string | null;
    name: string | null;
    branchName: string | null;
    workspaceDisplayKind: PluginSidebarWorkspaceKind;
  } | null;
  /**
   * The machine this thread's work runs on, with the name resolved for you.
   * Null when the thread has no environment yet, or when its host is not in
   * the known-hosts list. Useful where a thread has no branch to show — a
   * personal-project thread has a machine but no worktree.
   */
  host: { id: string; name: string } | null;

  createdAt: number;
  updatedAt: number;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

/**
 * The pull request for a thread's branch, narrowed to what a sidebar row
 * needs. `attention` is bb's rolled-up "does this need you" signal, so a row
 * can colour a badge without reading checks, review, and mergeability itself.
 */
export interface PluginSidebarPullRequest {
  number: number;
  title: string;
  url: string;
  state: "draft" | "open" | "merged" | "closed";
  attention:
    | "checks_failed"
    | "checks_pending"
    | "changes_requested"
    | "review_requested"
    | "conflicts"
    | "blocked"
    | "draft"
    | "ready_to_merge"
    | "merged"
    | "closed"
    | "none";
}

export interface PluginSidebarThreadPullRequestState {
  /** True while the first lookup for this thread's environment is in flight. */
  isLoading: boolean;
  /**
   * The pull request, or null when the branch has none, the thread has no
   * environment, or the lookup could not run (a git-host hiccup). A row should
   * treat null as "nothing to show", never as an error.
   */
  pullRequest: PluginSidebarPullRequest | null;
}

/** One project in the sidebar's live view. */
export interface PluginSidebarProject {
  id: string;
  name: string;
  /** True for the implicit personal project. */
  isPersonal: boolean;
}

export interface PluginSidebarThreadsState {
  status: "loading" | "ready" | "error";
  threads: readonly PluginSidebarThread[];
  projects: readonly PluginSidebarProject[];
}

/**
 * The provider directory (see {@link PluginSdkApp.experimental_useProviders}):
 * every registered agent provider in picker order, as the same `ProviderInfo`
 * the host's own pickers read. `logoUrl` is server-relative
 * (`/api/v1/system/providers/<id>/logo`) or null when the provider declared a
 * glyph or no icon; `strings` carries the provider's declared copy.
 */
export interface PluginProvidersState {
  status: "loading" | "ready" | "error";
  providers: readonly ProviderInfo[];
}

/**
 * One TextMate token rule from the active code theme, in the shape VS Code
 * theme files author it.
 */
export interface PluginCodeThemeTokenRule {
  /** Scope(s) the rule paints; absent means the theme's base rule. */
  scope?: string | readonly string[];
  settings: {
    /** `#rrggbb` or `#rrggbbaa`. */
    foreground?: string;
    background?: string;
    /** Space-separated TextMate font styles, e.g. `"bold italic"`. */
    fontStyle?: string;
  };
}

/**
 * The active code theme as a VS Code theme file: the same document BB's own
 * highlighter renders from, so a plugin that embeds a third-party editor can
 * translate it into that editor's theme format rather than guessing colors
 * from CSS variables.
 */
export interface PluginCodeThemeData {
  /** Registered theme name — a bundled Shiki name or a BB-registered id. */
  name: string;
  type: "light" | "dark";
  /** Default editor foreground, as `#rrggbb[aa]`. */
  fg: string;
  /** Default editor background, as `#rrggbb[aa]`. */
  bg: string;
  /** VS Code workbench colors (`editor.background`, `editorCursor.foreground`, …). */
  colors: Readonly<Record<string, string>>;
  tokenColors: readonly PluginCodeThemeTokenRule[];
}

/**
 * The code theme BB is currently rendering with (see
 * {@link PluginSdkApp.experimental_useCodeTheme}). `mode` and `name` change
 * the moment the user switches palette or light/dark; `theme` follows once
 * the theme file resolves, and keeps the previous document until then so a
 * consumer never has to paint an unthemed frame. Compare `theme.name` with
 * `name` to tell a settled state from one still resolving.
 */
export interface PluginCodeThemeState {
  mode: "light" | "dark";
  name: string;
  /** null only before the first theme file resolves. */
  theme: PluginCodeThemeData | null;
}

/**
 * Act on threads from a plugin surface. Every method routes to the host's own
 * flow, so optimistic updates, toasts, dialogs, pane closing, and route repair
 * behave exactly as they do in the built-in sidebar. Unknown thread ids are
 * ignored by `open` and rejected by the rest.
 */
export interface PluginSidebarThreadActions {
  /**
   * Navigate to a thread. `split: true` applies bb's split placement rules —
   * a right split by default, focus when the thread is already open, replace
   * at the pane cap — and falls back to plain navigation where splits are off.
   */
  open(threadId: string, options?: { split?: boolean }): void;
  /**
   * Go to the new-thread screen. Passing `projectId` also makes that project
   * the composer's selection, so the thread is created where you asked.
   */
  openNewThread(options?: { projectId?: string; focusPrompt?: boolean }): void;
  setPinned(threadId: string, pinned: boolean): Promise<void>;
  setRead(threadId: string, read: boolean): Promise<void>;
  /** Silent rename — no dialog. For inline editing in your own row. */
  rename(threadId: string, title: string): Promise<void>;
  /** Archives the thread AND its children, closing any panes showing them. */
  archive(threadId: string): void;
  /**
   * Opens bb's delete confirmation, which counts child threads first. Deletion
   * is destructive and recursive, so the host owns the confirmation: there is
   * deliberately no silent `delete`.
   */
  requestDelete(threadId: string): void;
}

/**
 * Render a plugin component in the thread header's action row.
 *
 * The frontend sibling of the backend `bb.ui.registerThreadAction`, which
 * renders a host-owned button and runs server-side. Use that one for "do a
 * thing"; use this one when the control must draw live state.
 *
 * The host places it at the left end of the action row, before the workspace
 * button, git actions, the panel toggle, maximize, and close. That row is a
 * 48px chrome row with 28px controls: render one inline control that fits, and
 * put anything taller in a portalled popover.
 */
export interface PluginThreadHeaderActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /**
   * Names the region the host wraps around your component (a labelled group).
   * It does NOT label your control: an icon-only button still needs its own
   * accessible name.
   */
  title: string;
  component: ComponentType<PluginThreadHeaderActionProps>;
}

/** One pane's place in the split layout, as fractions of the split area. */
export interface PluginSidebarSplitPane {
  paneId: string;
  rect: { x: number; y: number; width: number; height: number };
  /** This pane holds the thread the row represents. */
  isMe: boolean;
  isFocused: boolean;
}

/**
 * Drag-to-split support for one row, plus where that thread currently sits in
 * the split layout.
 */
export interface PluginSidebarThreadSplit {
  /**
   * Spread onto the row's interactive element. Carries the pointer handler
   * that starts a split drag; empty when splits are unavailable, so spreading
   * it is always safe.
   *
   * The host owns every rule: the gesture engages only once the pointer leaves
   * the sidebar toward the main area (so a list with its own drag-to-reorder
   * keeps working), an edge drop splits, a center drop replaces, an
   * already-open thread focuses its pane, and the pane cap coerces a split
   * into a replace.
   */
  splitProps: {
    onPointerDown?: (event: import("react").PointerEvent<HTMLElement>) => void;
  };
  /**
   * False on compact viewports, when the user disabled splits, and for an
   * unknown thread id. Gate any "open in split" affordance you draw on it.
   */
  isAvailable: boolean;
  /**
   * Where this thread sits in the split layout, or null when it is not open in
   * one (including single-pane layouts). Draw a mini-map, a tint, or nothing.
   */
  layout: { panes: readonly PluginSidebarSplitPane[] } | null;
}

/**
 * Replace the sidebar's thread list with a plugin component.
 *
 * Unlike every other slot, this one is EXCLUSIVE: two lists cannot share one
 * scroll area. Registering activates the replacement while the plugin is
 * enabled. If multiple plugins register one, the first in deterministic slot
 * order is active by default; removing it reveals the next. The user can pin
 * BB's list or a specific provider under Settings → Appearance. A plugin can
 * also use its own setting and render `Original` conditionally.
 * An absent or crashing replacement falls back to BB's list rather than
 * leaving the user with no sidebar.
 *
 * The plugin gets the scrolling list and nothing else. The New-thread button,
 * the search action, the plugin nav rows, and the footer stay host-rendered in
 * every sidebar — they are shared surfaces (other plugins live in two of
 * them), and a replaced list must not be able to remove them.
 */
export interface PluginThreadListRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label shown in Settings → Appearance and capability details. */
  title: string;
  /** Optional one-line description shown with the provider choice. */
  description?: string;
  component: ComponentType<PluginThreadListProps>;
}

/** Replace the bounded navigation controls above the sidebar thread list. */
export interface ExperimentalSidebarNavigationRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label shown in Settings → Appearance and capability details. */
  title: string;
  /** Optional one-line description shown with the provider choice. */
  description?: string;
  component: ComponentType<ExperimentalSidebarNavigationProps>;
}

/**
 * Register this plugin as a viewer/editor for file extensions. By default,
 * matching files render the first applicable opener in deterministic slot
 * order. The user can pin BB's preview or a specific opener per extension
 * under Settings → Files. The file tab's "Open with" menu can override that
 * choice for one open. A plugin can also use its own setting and render
 * `Original` conditionally. Applies to working-tree, host, and
 * thread-storage files — never to git-ref snapshots (diff views always use
 * BB's preview).
 */
export interface PluginFileOpenerRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label in the "Open with" menu (e.g. "Notes editor"). */
  title: string;
  /** Lowercase extensions without the dot (e.g. ["md", "mdx"]). */
  extensions: readonly string[];
  component: ComponentType<PluginFileOpenerProps>;
}

/**
 * Replace BB's source-code renderer everywhere it renders supplied source
 * text — the native file preview and every plugin that calls
 * `experimental_SourceCode`. Like `experimental_threadList` this slot is
 * **exclusive**: one renderer at a time. Registering activates it while the
 * plugin is enabled; if several are registered the first in deterministic slot
 * order wins. A missing, disabled, or crashing replacement falls back to BB's
 * renderer, and a replacement can render `Original` to delegate
 * per call (behind its own setting, by language, by size — whatever it needs).
 */
export interface PluginSourceCodeRendererRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label shown in capability details. */
  title: string;
  /** Optional one-line description shown with the provider choice. */
  description?: string;
  component: ComponentType<PluginSourceCodeRendererProps>;
}

/**
 * Replace BB's diff renderer everywhere it renders supplied diff content — the
 * timeline file diffs, the environment diff panel's text bodies, and every
 * plugin that calls `experimental_Diff`. Exclusive, with the same activation,
 * fallback, and `Original` delegation rules as
 * {@link PluginSourceCodeRendererRegistration}.
 */
export interface PluginDiffRendererRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label shown in capability details. */
  title: string;
  /** Optional one-line description shown with the provider choice. */
  description?: string;
  component: ComponentType<PluginDiffRendererProps>;
}

/**
 * Register a leaf message directive rendered inside assistant (and nested
 * agent) message Markdown. `id` is the directive name: `inline-vis` matches
 * `::inline-vis{file="demo.html"}`.
 */
export interface PluginMessageDirectiveRegistration {
  /**
   * The directive name. Lowercase kebab-case beginning with a letter.
   */
  id: string;
  component: ComponentType<PluginMessageDirectiveProps>;
}

/**
 * A narrow, stable reference to one rendered chat message — NOT an internal
 * timeline row. `sourceSeqEnd` is the last source event sequence the message
 * covers, the anchor the server accepts for provider-history forks.
 */
export interface ThreadChatMessageReference {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  /** Visible text of the message. */
  text: string;
  sourceSeqEnd: number;
}

/**
 * What a caller that is *not* itself a panel action passes to open one — a
 * `messageAction`'s `run`, or any component via `useBbNavigate()`. A panel
 * action opening its own tab is already the target, so it passes the bare
 * {@link PluginPanelActionOpenOptions} instead.
 */
export interface PluginTargetedPanelActionOpenOptions extends PluginPanelActionOpenOptions {
  /** A `threadPanelAction` id registered by this same plugin. */
  actionId: string;
}

/** Context handed to a `messageAction`'s `run`. */
export interface PluginMessageActionContext {
  /** The thread whose timeline surfaced the action. */
  threadId: string;
  message: ThreadChatMessageReference;
  /**
   * Present only when the action was invoked from the text-selection menu;
   * the exact text the user highlighted inside `message`.
   */
  selectedText?: string;
  /**
   * Open one of this plugin's `threadPanelAction` components in the current
   * thread's side panel — the registration-callback equivalent of
   * `useBbNavigate().openThreadPanel`.
   *
   * Returns true when the host accepted the open; false when it declined —
   * `params` was not a JSON value, the action id names no `threadPanelAction`
   * of this plugin, or the surface has no side panel (only the main thread
   * view does; a `ThreadChat` embedded in a plugin panel does not). A decline
   * is never thrown: the host logs it and reports it here.
   */
  openPanel(options: PluginTargetedPanelActionOpenOptions): boolean;
}

/**
 * An action on chat messages: an icon button in the per-message action bar
 * (user and assistant messages) and an entry in the assistant-message
 * text-selection menu. Host-rendered chrome — the plugin supplies title,
 * icon hint, and `run` behavior only.
 */
export interface PluginMessageActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Tooltip / menu label for the action. */
  title: string;
  /** Icon hint (BB icon name); unknown names fall back to a generic icon. */
  icon?: string;
  /**
   * Runs when the user activates the action. Errors (sync or async) are
   * contained and logged; they never break the timeline.
   */
  run(context: PluginMessageActionContext): void | Promise<void>;
}

/** Context handed to a `commandPaletteAction`'s `isAvailable` and `run`. */
export interface PluginCommandPaletteActionContext {
  /** The thread in view, or null on a surface without one. */
  threadId: string | null;
  projectId: string | null;
  /**
   * Open one of this plugin's `threadPanelAction` components in the current
   * thread's side panel, exactly as `messageAction`'s `openPanel` does.
   *
   * Returns true when the host accepted the open; false when it declined —
   * `params` was not a JSON value, the action id names no `threadPanelAction`
   * of this plugin, or the surface has no side panel. Only the main thread
   * view has one, and the palette opens anywhere, so guard with `isAvailable`
   * rather than assuming.
   */
  openPanel(options: PluginTargetedPanelActionOpenOptions): boolean;
}

/**
 * A row in bb's quick palette (Mod+Shift+P), listed under the plugin's name
 * beside bb's own commands. Host-rendered: the plugin supplies a title and
 * `run`, and the host owns matching, ordering, and recency.
 */
export interface PluginCommandPaletteActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** The row's label, e.g. "Linear: open issue for this thread". */
  title: string;
  /**
   * Hide the row when it cannot do anything — typically when it needs a thread
   * and there is none. Called while the palette is open; keep it cheap and
   * synchronous. Omitted means always listed.
   */
  isAvailable?(context: PluginCommandPaletteActionContext): boolean;
  /**
   * Runs after the palette closes and focus is restored. Errors (sync or
   * async) are contained and logged; they never break the palette.
   */
  run(context: PluginCommandPaletteActionContext): void | Promise<void>;
}

/**
 * Supply the inline React mark bb draws for one agent provider.
 *
 * A manifest `branding.icon` (or a provider's `logoUrl`) is fetched and drawn
 * through `<img>`, a separate document where `currentColor` resolves to black
 * — invisible on dark themes and unreachable from app CSS. A component is
 * rendered inline, so it inherits the app's theme colors and the host's sizing
 * classes. Register a static color logo as a file and a theme-aware mark here.
 *
 * The host passes only `className` (sizing plus the provider's color class);
 * the component must render an inline SVG (or other inline markup) and must
 * not fetch. One registration per provider id per plugin; when two plugins
 * claim the same provider id the host keeps the first by plugin id and warns.
 */
export interface PluginProviderIconRegistration {
  /**
   * The provider this mark is for — the id bb knows the provider by (the
   * provider declaration's id, e.g. `codex` or `acp-cursor`), not the plugin
   * id. Letters, digits, `-`, `_`.
   */
  providerId: string;
  /** Inline, theme-aware mark. Receives the host's sizing/color className. */
  icon: ComponentType<{ className?: string }>;
}

/**
 * The declarative presentation persisted with a timeline item (docs/
 * provider-plugin-api.md §3): what every client renders when no plugin code
 * is present. A renderer receives it so it can reuse the bridge's label,
 * glyph and tint instead of re-deriving them from the payload.
 */
export interface PluginTimelineRowPresentation {
  label: { pending: string; completed: string };
  icon: { glyph: string };
  title?: string;
  /** Short Markdown, length-capped at ingest. */
  detail?: string;
  suppress?: boolean;
  tint?: { light: string; dark: string };
}

export type PluginTimelineRowStatus =
  | "pending"
  | "completed"
  | "error"
  | "interrupted";

/** The projected row a `experimental_timelineRenderer` component receives. */
export interface PluginTimelineRendererRow {
  id: string;
  threadId: string;
  turnId: string | null;
  /**
   * The item kind the renderer registered for: this plugin's extension kind
   * (`"<pluginId>/<name>"`) or `"tool"` for a generic tool item.
   */
  kind: string;
  /** The tool name for a `"tool"` row; null for an extension row. */
  toolName: string | null;
  status: PluginTimelineRowStatus;
  startedAt: number;
  completedAt: number | null;
}

export interface PluginTimelineRendererProps {
  row: PluginTimelineRendererRow;
  /**
   * The item's data: an extension item's payload (validated against the
   * plugin's declared schema at ingest), or for a `"tool"` row the call's
   * `{ arguments, output }`.
   */
  payload: JsonValue;
  /**
   * The bridge's presentation for the row. Null only for a generic tool row
   * persisted before bridges attached presentation (grammar v2); an
   * extension row always has one.
   */
  presentation: PluginTimelineRowPresentation | null;
  /** The thread the row belongs to. */
  thread: { id: string; providerId: string | null };
  /**
   * The host's declarative base for this row's body (the presentation's
   * `detail`, or the tool call's arguments and output). Render it to keep
   * the default body beside the plugin's own content.
   */
  Original: ComponentType<Record<never, never>>;
}

/**
 * Render the expanded body of the timeline rows this plugin owns: its own
 * extension item kinds (`"<pluginId>/<name>"`, where `<pluginId>` is this
 * plugin), and `"tool"` for the generic tool items of the providers this
 * plugin registered. Core kinds (message, command, fileChange, fileRead,
 * search, delegation, planSteps, …) always use the core renderers and are
 * customized through the bridge's presentation alone.
 *
 * The row's header — the bridge's label, glyph, tint and headline — stays
 * host-rendered so the timeline reads uniformly; the component owns the
 * body. When no renderer is registered for a kind (the plugin is not loaded,
 * uninstalled, or never shipped an app bundle) the declarative base renders
 * instead, so a row never goes blank. Crashes are contained per row.
 */
export interface PluginTimelineRendererRegistration {
  /**
   * `"<pluginId>/<name>"` for one of this plugin's extension kinds, or
   * `"tool"` for the generic tool items of this plugin's providers.
   */
  kind: string;
  component: ComponentType<PluginTimelineRendererProps>;
}

// ---------------------------------------------------------------------------
// definePluginApp
// ---------------------------------------------------------------------------

export interface PluginAppSlots {
  homepageSection(registration: PluginHomepageSectionRegistration): void;
  settingsSection(registration: PluginSettingsSectionRegistration): void;
  /**
   * Render one app-wide overlay component (see
   * {@link ExperimentalAppOverlayRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_appOverlay(
    registration: ExperimentalAppOverlayRegistration,
  ): void;
  navPanel(registration: PluginNavPanelRegistration): void;
  /**
   * Add an action to an existing thread's panel launcher. This slot is
   * thread-only; use `experimental_newThreadPanelAction` for root compose.
   */
  threadPanelAction(registration: PluginThreadPanelActionRegistration): void;
  /**
   * Add an action to the root New thread screen's panel launcher (see
   * {@link PluginNewThreadPanelActionRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_newThreadPanelAction(
    registration: PluginNewThreadPanelActionRegistration,
  ): void;
  pendingInteraction(registration: PluginPendingInteractionRegistration): void;
  sidebarFooterAction(
    registration: PluginSidebarFooterActionRegistration,
  ): void;
  /** Replace the bounded sidebar navigation controls. */
  experimental_sidebarNavigation(
    registration: ExperimentalSidebarNavigationRegistration,
  ): void;
  /**
   * Replace the sidebar's thread list (see
   * {@link PluginThreadListRegistration}). Experimental: see
   * docs/api_to_audit.md for what to audit before the prefix drops.
   */
  experimental_threadList(registration: PluginThreadListRegistration): void;
  /**
   * Render a component in the thread header's action row (see
   * {@link PluginThreadHeaderActionRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_threadHeaderAction(
    registration: PluginThreadHeaderActionRegistration,
  ): void;
  fileOpener(registration: PluginFileOpenerRegistration): void;
  /**
   * Replace BB's source-code renderer (see
   * {@link PluginSourceCodeRendererRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_sourceCodeRenderer(
    registration: PluginSourceCodeRendererRegistration,
  ): void;
  /**
   * Replace BB's diff renderer (see
   * {@link PluginDiffRendererRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_diffRenderer(registration: PluginDiffRendererRegistration): void;
  messageDirective(registration: PluginMessageDirectiveRegistration): void;
  messageAction(registration: PluginMessageActionRegistration): void;
  /**
   * Add a row to the quick palette (see
   * {@link PluginCommandPaletteActionRegistration}).
   */
  commandPaletteAction(
    registration: PluginCommandPaletteActionRegistration,
  ): void;
  /**
   * Draw one agent provider's icon with an inline React component instead of
   * its `<img>`-rendered logo file (see
   * {@link PluginProviderIconRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_providerIcon(registration: PluginProviderIconRegistration): void;
  /**
   * Render the body of this plugin's own timeline rows: its extension kinds
   * and its providers' generic tool items (see
   * {@link PluginTimelineRendererRegistration}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_timelineRenderer(
    registration: PluginTimelineRendererRegistration,
  ): void;
}

export interface PluginAppComposer {
  customize(registration: ComposerCustomization): void;
}

/** Stable lifecycle values for one content-script instance in one bb client. */
export interface PluginContentScriptContext {
  /** The id of the plugin that owns this script. */
  readonly pluginId: string;
  /** Monotonic per-client generation, starting at 1. */
  readonly generation: number;
  /** Aborted before cleanup begins on replacement, deactivation, or teardown. */
  readonly signal: AbortSignal;
  /**
   * Persistently decorate any thread row for this plugin generation.
   *
   * The status is owned by the frontend generation and therefore survives
   * route changes. Passing `null` clears the plugin's status for that thread.
   * The host clears every remaining status when the frontend generation
   * deactivates.
   *
   * Optional so bundles can feature-detect support while this experimental
   * surface rolls out across 0.x clients.
   */
  readonly experimental_setThreadRowStatus?: (
    threadId: string,
    status: PluginComposerThreadRowStatus | null,
  ) => void;
}

/** Cleanup returned by a frontend content script. */
export type PluginContentScriptDisposer = () => void | Promise<void>;

/**
 * Trusted same-origin JavaScript/TypeScript mounted once per active frontend
 * generation in each bb app window or browser tab.
 */
export interface PluginContentScriptRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /**
   * Install behavior into the bb app shell. The host awaits a returned
   * promise, retains the plugin's imported frontend stylesheet for this
   * generation, contains failures, and calls the returned disposer exactly
   * once. Styling or decorating existing app-shell DOM belongs here rather
   * than in an always-on frontend stylesheet.
   */
  mount(
    context: PluginContentScriptContext,
  ):
    | void
    | PluginContentScriptDisposer
    | Promise<void | PluginContentScriptDisposer>;
}

/** Lifecycle surface for trusted frontend content scripts. */
export interface PluginAppContentScripts {
  register(registration: PluginContentScriptRegistration): void;
}

export interface PluginAppBuilder {
  slots: PluginAppSlots;
  composer: PluginAppComposer;
  contentScripts: PluginAppContentScripts;
  /** Experimental managed region for actions and disclosures in the sidebar footer. */
  experimental_sidebarFooter: ExperimentalSidebarFooter;
}

export type PluginAppSetup = (app: PluginAppBuilder) => void;

/**
 * The opaque product of `definePluginApp` — a plugin's `app.tsx` default
 * export. The host re-runs `setup` against a fresh collector on every
 * (re)interpretation, replacing that plugin's registrations wholesale.
 */
export interface PluginAppDefinition {
  /** Brand the host checks before interpreting a bundle's default export. */
  readonly __bbPluginApp: true;
  readonly setup: PluginAppSetup;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface PluginRpcClient<
  Contract extends PluginRpcContract = PluginRpcContract,
> {
  /**
   * Invoke one of the plugin's `bb.rpc` methods (POST
   * /api/v1/plugins/&lt;id&gt;/rpc/&lt;method&gt;). Resolves with the method's
   * inferred output; rejects with an `Error` carrying the server's message,
   * stable `code`, and validation `issues` when present.
   */
  call<Method extends Extract<keyof Contract, string>>(
    method: Method,
    ...args: PluginRpcCallArgs<Contract[Method]>
  ): Promise<PluginRpcResult<Contract[Method]>>;
}

export interface PluginSettingsState {
  /**
   * Effective non-secret setting values (secret settings are excluded —
   * read them server-side). Undefined while loading or unavailable.
   */
  values: Record<string, string | number | boolean> | undefined;
  isLoading: boolean;
}

/** State of the app's shared realtime connection to the bb server. */
export type PluginRealtimeConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting";

/** Where `useComposer()` writes. */
export type PluginComposerScope =
  | { kind: "thread"; threadId: string }
  | {
      kind: "queued-message";
      threadId: string;
      queuedMessageId: string;
    }
  | {
      kind: "side-chat";
      projectId: string;
      parentThreadId: string;
      tabId: string;
      childThreadId: string | null;
    }
  | {
      kind: "new-thread";
      /** Root compose's effective selected project; null only while unresolved. */
      projectId: string | null;
    };

/** One plugin-owned composer customization registration. */
export interface ComposerCustomization {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Composer kinds where this customization is active; omit for all kinds. */
  scopes?: readonly PluginComposerScope["kind"][];
  actions?: readonly { id: string; component: ComponentType }[];
  banners?: readonly {
    id: string;
    /** Host chrome around the banner. Defaults to `"card"`. */
    chrome?: "card" | "bare";
    component: ComponentType;
  }[];
  plusMenu?: readonly ComposerPlusMenuItem[];
  richText?: ComposerRichTextSpec;
}

/** Host-rendered menu row in the composer's `+` menu. */
export interface ComposerPlusMenuItem {
  id: string;
  label: string;
  /** BB icon name; unknown names fall back to the generic plugin icon. */
  icon?: string;
  /** Accessible description for the host-rendered row. */
  description?: string;
  disabled?: boolean | ((view: ComposerView) => boolean);
  run(context: {
    composer: PluginComposerApi;
    view: ComposerView;
  }): void | Promise<void>;
}

/** Reactive read-side of the composer a plugin surface is mounted in. */
export interface ComposerView {
  scope: PluginComposerScope;
  layout: "expanded" | "compact" | "zen";
  draft: { text: string; isEmpty: boolean; attachmentCount: number };
  run: { isRunning: boolean; isSubmitting: boolean };
}

export interface ComposerRichTextSpec {
  /** Content-derived paint: match ranges receive `className`; text is never mutated. */
  effects?: readonly {
    id: string;
    /** Plain-text offsets into the current structured draft. */
    match(text: string): readonly { from: number; to: number }[];
    className: string;
  }[];
  /** Debounced, read-only observation of the structured draft. */
  onDraftChange?(draft: ComposerStructuredDraft, view: ComposerView): void;
}

export interface ComposerStructuredDraft {
  text: string;
  mentions: readonly {
    from: number;
    to: number;
    provider: string;
    id: string;
    label: string;
  }[];
}

/** Host-rendered paint applied to the editable composer text. */
export interface PluginComposerTextEffect {
  className: string;
}

/** Host-rendered status that temporarily replaces a thread's draft glyph. */
export interface PluginComposerThreadRowStatus {
  /** BB icon-name hint; unknown names fall back to the generic plugin icon. */
  icon: string;
  /** Accessible label for the status glyph. */
  label: string;
  /**
   * Semantic host treatment for the status glyph. `running` automatically
   * shimmers; terminal `success` and `error` tones are static. Defaults to the
   * neutral tone.
   */
  tone?: "default" | "running" | "success" | "error";
}

/** An @-mention pill bound to one of the calling plugin's mention providers. */
export interface PluginComposerMention {
  /** Mention provider id registered by THIS plugin via `bb.ui.registerMentionProvider`. */
  provider: string;
  /** Item id your provider's `resolve` will receive at send time. */
  id: string;
  /** Pill text shown in the composer. */
  label: string;
}

/**
 * Programmatic access to the chat composer draft — the same shared draft the
 * built-in "Add to chat" affordances (file preview, diff, terminal selections)
 * write to. While a queued message is being edited, writes land in that
 * message's inline editor. In a side chat, writes land in the visible side-chat
 * draft. Otherwise, inside a thread context writes land in that thread's draft;
 * anywhere else (nav panel, homepage section) they seed the new-thread composer
 * draft, which persists until the user sends or clears it.
 */
export interface PluginComposerApi {
  scope: PluginComposerScope;
  /** Current plain text for this composer scope. */
  readonly text: string;
  /**
   * Replace the draft's plain text. Attachments are preserved. Inline mentions
   * outside the changed range are preserved and rebased; mentions overlapped
   * by the replacement are removed because their text representation changed.
   */
  setText(next: string): void;
  /**
   * Replace the draft's plain text from the latest committed value. Uses the
   * same structured-state reconciliation as `setText`.
   */
  updateText(updater: (current: string) => string): void;
  /** Clear plain text without clearing independently attached files. */
  clear(): void;
  /**
   * Apply a host-rendered effect to this composer's editable text, or clear it.
   * Effects are scoped to the calling plugin and automatically clear when the
   * slot unmounts or its composer scope changes.
   */
  setTextEffect(effect: PluginComposerTextEffect | null): void;
  /**
   * Lock or unlock editing for this composer. Locks are scoped to the calling
   * plugin and automatically release when the slot unmounts or its composer
   * scope changes.
   */
  setInputLock(locked: boolean): void;
  /**
   * Append text to the draft as a `> ` blockquote block and focus the
   * composer. Blank text is a no-op. This is the "reference this selection
   * in chat" primitive.
   */
  addQuote(text: string): void;
  /**
   * Insert an @-mention pill that resolves through this plugin's mention
   * provider at send time — the durable way to reference an entity whose
   * content should be fetched fresh when the message is sent.
   */
  insertMention(mention: PluginComposerMention): void;
  /** Focus the composer caret at the end of the draft. */
  focus(): void;
  /**
   * Submit this composer's draft through the composer's OWN submit pipeline,
   * queued until `sendAt` instead of dispatched now.
   *
   * This is a real submission, not a plugin-issued send: the host builds the
   * request exactly as pressing Enter would, so the draft's attachments and
   * @-mentions, and — in the new-thread composer — the provider, model,
   * reasoning level, service tier, permission mode and environment the user
   * has selected on screen, all travel with it. A plugin cannot assemble that
   * tuple itself, which is why sending from the backend instead would silently
   * run the message with different settings than the ones in front of the user.
   *
   * In a thread composer the message is queued as a row instead of being
   * sent or queued for the next idle moment. In the new-thread composer the
   * thread is created `pending` and its first message becomes the queued row.
   * Either way the resulting row is core's: the queued card above the
   * composer, the countdown, Send now and Delete all work with no further
   * plugin involvement.
   *
   * Resolves once the host has accepted the submission and cleared the draft.
   * Rejects when the composer refused to submit — a scope with no submit
   * pipeline (a queued-message editor, a side chat), an empty draft, or a
   * composer that is not ready (still loading its execution defaults, missing
   * an environment). The rejection's message is safe to show to the user.
   * Failures of the underlying request are reported by bb's own submit error
   * handling and restore the draft, exactly as an interactive failure does.
   *
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_submit(
    options: ExperimentalComposerSubmitOptions,
  ): Promise<void>;
}

/**
 * What `experimental_submit` does differently from pressing Enter.
 *
 * There is deliberately no zero-argument overload and no "submit now" arm: a
 * plugin that wants a draft sent immediately is asking for the affordance the
 * user already has, and handing plugins an unconditional "send this draft"
 * button is a much larger surface than scheduling needs.
 */
export interface ExperimentalComposerSubmitOptions {
  /**
   * Epoch ms the submission should dispatch at. Must be in the future; the
   * host does not second-guess how far ahead it is.
   */
  sendAt: number;
}

// ---------------------------------------------------------------------------
// ThreadChat — the host-owned chat component.
// ---------------------------------------------------------------------------

/**
 * A consumer-supplied action on the messages of one `ThreadChat` instance,
 * rendered in the embedded timeline's per-message action bar alongside the
 * native and slot-registered actions. Unlike the `messageAction` slot this is
 * scoped to the rendering component, not registered globally.
 */
export interface ThreadChatMessageAction {
  /** Unique within this ThreadChat instance; letters, digits, `-`, `_`. */
  id: string;
  /** Tooltip / menu label for the action. */
  title: string;
  /** Icon hint (BB icon name); unknown names fall back to a generic icon. */
  icon?: string;
  /**
   * Message roles the action applies to. Omitted = both user and assistant
   * messages.
   */
  roles?: readonly ("user" | "assistant")[];
  /**
   * Runs when the user activates the action. Errors (sync or async) are
   * contained and logged; they never break the timeline.
   */
  run(message: ThreadChatMessageReference): void | Promise<void>;
}

/**
 * Props of the host-owned `ThreadChat` component — one thread's chat
 * (timeline, and for the composer variants the full send/queue/draft
 * engine), rendered by the BB app inside a plugin slot. This is the
 * deliberate exception to the no-host-components rule (§5.5): a stable
 * product capability, not a UI kit. Versioned additive like slot props;
 * internal timeline rows, query hooks, and prompt-box configuration are
 * deliberately not exposed.
 */
export interface ThreadChatProps {
  threadId: string;
  /**
   * "full" (default) is the page presentation (centered reading width);
   * "compact" is the side-panel presentation; "timeline" renders the
   * transcript without a composer.
   */
  variant?: "full" | "compact" | "timeline";
  /**
   * "contained" (default) fills and scrolls inside a bounded parent;
   * "document" grows with its content and defers scrolling to the page.
   */
  layout?: "contained" | "document";
  /** Bump to focus the composer (ignored by `variant: "timeline"`). */
  focusRequest?: number;
  /**
   * Who controls the permission mode sends run with. "inherit" (default)
   * pins every send to the thread's own resolved default and renders the
   * picker as a dimmed label — a plugin surface can never widen it.
   * "editable" gives this chat its own picker, so the user can raise or
   * lower permissions for this thread independently of the thread it was
   * forked from. Ignored by `variant: "timeline"` (no composer).
   */
  permissionPolicy?: "inherit" | "editable";
  className?: string;
  /** Rendered above the conversation, scrolling with it. */
  leadingContent?: ReactNode;
  /**
   * Actions rendered in this instance's per-message action bar (see
   * {@link ThreadChatMessageAction}).
   */
  messageActions?: readonly ThreadChatMessageAction[];
}

// ---------------------------------------------------------------------------
// experimental_ProviderModelPicker — host-owned execution selection.
// ---------------------------------------------------------------------------

/**
 * The controlled execution selection resolved by the picker.
 *
 * Deliberately a single concrete shape, not a union: this value exists to be
 * forwarded verbatim to `bb.sdk.threads.spawn`, so it must name a real
 * provider and model.
 */
export interface ExperimentalProviderModelPickerValue {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  /** Present only when the selected provider supports service tiers. */
  serviceTier?: ServiceTier;
}

/** Where the picker resolves the live provider and model catalog. */
export type ExperimentalProviderModelPickerRouting =
  | { kind: "host"; hostId: string }
  | { kind: "environment"; environmentId: string };

/**
 * Props of the host-owned `experimental_ProviderModelPicker` component.
 * Provider switches emit one coherent value after the live catalog resolves
 * its default model, reasoning level, and service-tier capability. Failed or
 * empty catalogs leave `value` unchanged. Omit `routing` to use bb's
 * primary-machine routing. Environment routing is required when a provider's
 * model catalog depends on the selected workspace.
 */
export interface ExperimentalProviderModelPickerProps {
  value: ExperimentalProviderModelPickerValue;
  onChange(value: ExperimentalProviderModelPickerValue): void;
  /** Route discovery through an explicit machine or existing environment. */
  routing?: ExperimentalProviderModelPickerRouting;
  /** Allow switching providers. Defaults to true; false hides provider tabs. */
  allowProviderChange?: boolean;
  /** Horizontal popover alignment. Defaults to `"start"`. */
  align?: "start" | "center" | "end";
  /** Render the shared selection summary without allowing changes. */
  disabled?: boolean;
  className?: string;
}

/** Props of BB's controlled, host-resolved permission-mode picker. */
export interface ExperimentalPermissionModePickerProps {
  /** Provider whose supported modes determine the available choices. */
  providerId: string;
  value: PermissionMode;
  onChange(value: PermissionMode): void;
  /** Route capability and machine-ceiling resolution like the execution picker. */
  routing?: ExperimentalProviderModelPickerRouting;
  /** Horizontal menu alignment. Defaults to `"end"`. */
  align?: "start" | "center" | "end";
  /** Render the resolved mode without allowing changes. */
  disabled?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// experimental_NewThreadComposer — the host-owned new-thread compose surface.
// ---------------------------------------------------------------------------

/**
 * Every selection the composer resolved, JSON-serializable so a plugin can
 * forward it to its own backend rpc verbatim and hand it straight to
 * `bb.sdk.threads.spawn`.
 *
 * The split is deliberate: the composer owns *user selections*, the plugin
 * owns *filing and attribution*. `bb.sdk.threads.spawn` auto-fills
 * `origin: "plugin"` and `originPluginId`, so a thread created this way stays
 * attributed to the plugin — which it would not be if the component created
 * the thread itself. The plugin adds `sectionId`, `parentThreadId`, `title`,
 * and `visibility` to the request on its own; they are deliberately not
 * composer props.
 */
export interface NewThreadRequest {
  /**
   * The selected project id. Choosing "Don't work in a project" submits BB's
   * personal-project id (not `null`) together with a `personal` workspace
   * environment. Forward those fields unchanged to `threads.spawn`; if the
   * plugin needs project metadata, request it from the plugin backend with
   * `bb.sdk.projects.list({ includePersonal: true })`.
   */
  projectId: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  /** Omitted when the selected provider has no service tiers. */
  serviceTier?: ServiceTier;
  /**
   * Per-field provenance (caller-explicit vs. default) for the execution
   * options above, forwarded to `spawn` so the server records what the user
   * actually chose.
   */
  executionInputSources: CreateExecutionInputSources;
  environment: CreateThreadEnvironmentArgs;
  input: PromptInput[];
  /**
   * Epoch ms the first turn should dispatch at. Present only when the
   * submission came from `useComposer().experimental_submit` — a scheduled
   * create — and absent otherwise, which is what makes an ordinary submission
   * start work at once. Forward it to `threads.spawn` unchanged: the thread is
   * created `pending` and its first message is queued as a row until then.
   */
  sendAt?: number;
}

/**
 * Props of the host-owned `experimental_NewThreadComposer` component — bb's
 * full new-thread compose surface (prompt editor with @-mentions and expand,
 * attachments, provider/model/reasoning picker, voice, submit, and the row
 * beneath with project, environment, branch-from, and permission mode),
 * rendered by the BB app inside a plugin slot.
 *
 * It is the create-side counterpart to `ThreadChat`: same deliberate
 * exception to the no-host-components rule (§5.5), same additive versioning.
 */
export interface NewThreadComposerProps {
  /**
   * Seeds the project picker. The user can change it, including choosing
   * "Don't work in a project"; see {@link NewThreadRequest.projectId} for the
   * submitted projectless shape.
   */
  defaultProjectId?: string;
  /**
   * Seeds the provider picker. Like every `default*` prop this is a SEED, not
   * a controlled value: the composer stays uncontrolled, the user can change
   * it, and when omitted the composer falls back to the project's remembered
   * execution defaults exactly as before. When provided it takes precedence
   * over those project defaults.
   *
   * Re-seeding: the `default*` props are value-compared each render. When any
   * of them changes after mount, the composer re-seeds EVERY execution and
   * environment selection from the new props — including selections the user
   * had already touched — so switching between two saved records in the same
   * mounted composer reloads that record's values (the same rule
   * `defaultProjectId` already follows).
   *
   * Every seeded field is reported as caller-explicit in the submitted
   * request's `executionInputSources`. That is what makes the seed survive
   * `threads.spawn`: the server drops a requested `providerId`/`model` that
   * carries no provenance source and re-derives it from the project's stored
   * defaults, which would silently undo the seed.
   */
  defaultProviderId?: string;
  /** Seeds the model picker. Same seed semantics as {@link defaultProviderId}. */
  defaultModel?: string;
  /**
   * Seeds the reasoning-level picker. Same seed semantics as
   * {@link defaultProviderId}. If the seeded model does not support this
   * level, the composer reconciles to the closest supported one.
   */
  defaultReasoningLevel?: ReasoningLevel;
  /**
   * Seeds the service-tier picker. Same seed semantics as
   * {@link defaultProviderId}. Ignored (and omitted from the submitted
   * request) when the selected provider has no service tiers.
   */
  defaultServiceTier?: ServiceTier;
  /** Seeds the permission-mode picker. Same seed semantics as {@link defaultProviderId}. */
  defaultPermissionMode?: PermissionMode;
  /**
   * Seeds the environment and branch pickers from a previously submitted
   * `NewThreadRequest.environment`. Same seed semantics as
   * {@link defaultProviderId}: a seed the user can change, taking precedence
   * over the composer's own environment default when provided.
   *
   * Round trip: feeding a submitted request's `environment` back in and
   * resubmitting untouched reproduces an equivalent environment, with these
   * documented limits — the composer cannot represent every args variant:
   *
   * - `{ type: "project-default" }` seeds nothing; the composer resolves its
   *   own default and submits that concrete environment instead.
   * - A `host` environment whose host no longer exists (or whose project has
   *   no source on it) falls back to the composer's default host, exactly as
   *   the primary compose surface would.
   * - A `reuse` environment whose worktree no longer has unarchived threads
   *   falls back the same way.
   * - An `unmanaged` workspace's `path` has no composer control; the seeded
   *   selection submits `path: null` (the host's configured checkout). The
   *   composer itself never produces a non-null `path`, so real round trips
   *   are unaffected.
   * - A `managed-worktree` with `baseBranch: { kind: "default" }` leaves the
   *   branch picker on its default, which may resolve to a named base branch
   *   when the project configures a dedicated worktree base — the same branch
   *   the original `default` submission would have created from.
   */
  defaultEnvironment?: CreateThreadEnvironmentArgs;
  /** Seeds the draft, only while the draft is still empty. */
  initialPrompt?: string;
  placeholder?: string;
  /**
   * "contained" (default) fills and scrolls inside a bounded parent;
   * "document" grows with its content and defers scrolling to the page.
   */
  layout?: "contained" | "document";
  /** Bump to focus the editor. */
  focusRequest?: number;
  className?: string;
  /**
   * Where the draft persists. Drafts survive reloads and are shared by every
   * composer using the same key; defaults to a key scoped to this plugin.
   */
  draftKey?: string;
  /**
   * Fires on submit with every selection resolved. The draft clears when this
   * resolves and is KEPT if it throws, so a failed create never loses what the
   * user typed.
   */
  onSubmit: (request: NewThreadRequest) => void | Promise<void>;
}

/**
 * Props of the host-owned `Markdown` component — bb's chat message renderer
 * (the same typography, spacing, and code styling as timeline messages).
 * Use it wherever plugin UI quotes or previews message content so it reads
 * like the rest of the chat. Like `ThreadChat`, this is a stable product
 * capability, not a UI kit; renderer internals stay private.
 */
export interface MarkdownProps {
  /** Markdown source, rendered exactly like a chat message body. */
  content: string;
  className?: string;
}

/**
 * Props for BB's semantic URL link. The host owns ordinary activation while
 * retaining browser-owned anchor behavior for app routes, modifiers, explicit
 * targets, copying, and unsupported schemes. New top-level targets preserve
 * supplied `rel` tokens and receive safe defaults unless `opener` is explicit.
 * Experimental: see docs/api_to_audit.md.
 */
export interface UrlLinkProps extends Omit<
  ComponentPropsWithoutRef<"a">,
  "href"
> {
  href: string;
}

/** A live file whose identity is complete without ambient route context. */
export type ExperimentalLiveFileTarget =
  | { kind: "workspace"; environmentId: string; path: string }
  | { kind: "host"; hostId: string; path: string }
  | { kind: "thread-storage"; threadId: string; path: string };

/** One-based location to reveal after a live file opens. */
export type ExperimentalFileLocation =
  | { kind: "line"; line: number; column: number | null }
  | { kind: "range"; startLine: number; endLine: number };

/** Options shared by BB's preview and preferred-external file intents. */
export interface ExperimentalFileOpenOptions {
  target: ExperimentalLiveFileTarget;
  location: ExperimentalFileLocation | null;
}

/**
 * Props for BB's host-rendered semantic file link. Valid targets receive a
 * scheme-safe anchor href; traversal paths, ill-formed Unicode, and other
 * malformed runtime targets remain inert.
 */
export interface ExperimentalFileLinkProps extends Omit<
  ComponentPropsWithoutRef<"a">,
  "href" | "target"
> {
  target: ExperimentalLiveFileTarget;
  location?: ExperimentalFileLocation | null;
}

/** The panel surface resolved by the component making the request. */
export type ExperimentalAppPanelSurface = { kind: "current" };

/**
 * The owning fixed tab's current memory-only target. It survives tab, panel,
 * and route remounts during the current app session, but is never persisted
 * across a refresh. Call `clear` when the owner returns to its untargeted state.
 */
export interface ExperimentalFixedTabTargetState<Target extends JsonValue> {
  readonly sequence: number;
  readonly target: Target;
  clear(): void;
}

export type ExperimentalOpenFixedTabOptions<Target extends JsonValue> = {
  surface: ExperimentalAppPanelSurface;
  tab: ExperimentalPluginFixedTabReference<Target>;
  /** Omit to select the tab without replacing its current session target. */
  target?: NoInfer<Target>;
};

/** Surface-aware controller for selecting owner-scoped fixed tabs. */
export interface ExperimentalAppPanel {
  openFixedTab<Target extends JsonValue = never>(
    options: ExperimentalOpenFixedTabOptions<Target>,
  ): boolean;
}

/** Current app selection, derived from the route. */
export interface BbContext {
  projectId: string | null;
  threadId: string | null;
}

export interface BbNavigate {
  toThread(threadId: string): void;
  toProject(projectId: string): void;
  /**
   * Navigate to one of this plugin's own nav panels by its `path`.
   * `subPath` targets a location inside the panel (the component's
   * `subPath` prop); `replace` swaps the current history entry instead of
   * pushing — use it for redirects so back does not bounce.
   */
  toPluginPanel(
    path: string,
    options?: { subPath?: string; replace?: boolean },
  ): void;
  /**
   * Navigate to the root compose surface (the new-thread screen). Pass
   * `initialPrompt` to seed the composer draft and `focusPrompt` to focus the
   * composer on arrival — the pairing behind "Create via chat" style entry
   * points that drop the user into chat with a prefilled prompt.
   */
  toCompose(options?: { initialPrompt?: string; focusPrompt?: boolean }): void;
  /**
   * Open one of this plugin's registered thread-panel actions in the current
   * thread surface. Returns false when the surface has no thread side panel or
   * the action is unavailable.
   */
  openThreadPanel(options: PluginTargetedPanelActionOpenOptions): boolean;
  /**
   * Open an HTTP(S) URL using this client's BB browser preference. Returns
   * false for schemes the host does not own. Experimental: see
   * docs/api_to_audit.md.
   */
  openUrl(url: string): boolean;
  /** Open a live file in this surface's shared BB preview panel. */
  experimental_openFilePreview(options: ExperimentalFileOpenOptions): boolean;
  /** Open a live file in this client's preferred external file target. */
  experimental_openFileExternally(
    options: ExperimentalFileOpenOptions,
  ): boolean;
}

// ---------------------------------------------------------------------------
// The whole runtime surface. Declaration-versus-runtime parity is tested
// against the actual `@get-bb/plugin-sdk/app` module namespace.
//
// Components are deliberately NOT part of this surface (removed 2026-07-03,
// plugin design §5.5): plugins vendor shadcn-style component source from the
// BB registry (`npx shadcn add @bb/<name>`) and own it. `bb plugin build`
// shims react, the shared-singleton packages (portal radix families,
// sonner, vaul, @pierre/diffs) and the host-resident libraries every plugin
// would otherwise duplicate (clsx, tailwind-merge, class-variance-authority,
// the shared-ui icon); everything else bundles per plugin. Freezing 65
// component prop types here made every host component change a
// plugin-breaking change.
// ---------------------------------------------------------------------------

/**
 * Everything `@get-bb/plugin-sdk/app` resolves to at runtime. The BB app builds
 * the real implementation and `satisfies` this interface; `bb plugin build`
 * shims the specifier to that object on `globalThis.__bbPluginRuntime`.
 */
export interface PluginSdkApp {
  definePluginApp(setup: PluginAppSetup): PluginAppDefinition;
  useRpc<
    Contract extends PluginRpcContract = PluginRpcContract,
  >(): PluginRpcClient<Contract>;
  useRealtime(channel: string, handler: (payload: unknown) => void): void;
  /**
   * Observe the same shared connection that delivers `useRealtime` signals.
   * Use a subsequent transition to `connected` to reconcile server state that
   * may have changed while ephemeral signals could not be delivered. The first
   * connection can transition from `connecting` and is not a reconnection.
   */
  useRealtimeConnectionState(): PluginRealtimeConnectionState;
  useSettings(): PluginSettingsState;
  useBbContext(): BbContext;
  useBbNavigate(): BbNavigate;
  /** Select one of this plugin's eligible fixed tabs on the current surface. */
  experimental_useAppPanel(): ExperimentalAppPanel;
  /** Read or clear the owning tab's validated, session-scoped target. */
  experimental_useFixedTabTarget<Target extends JsonValue>(
    tab: ExperimentalPluginFixedTabReference<Target>,
  ): ExperimentalFixedTabTargetState<Target> | null;
  useComposer(): PluginComposerApi;
  /**
   * The sidebar's live thread view (see {@link PluginSidebarThreadsState}).
   * Reads the host's own cache and realtime subscriptions, so it costs no
   * extra request and updates exactly when the built-in sidebar does.
   *
   * `threads` is one array of every visible thread and is not capped. Thread
   * objects keep their identity across updates while the underlying entry is
   * unchanged, so a memoized row re-renders only when its own thread changed;
   * the array itself is new on every update. Window your rows (render only
   * what is on screen) as the built-in sidebar does — a list that mounts one
   * row per thread is slow on phones with many threads.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_useSidebarThreads(): PluginSidebarThreadsState;
  /**
   * Thread actions bound to the host's mutations (see
   * {@link PluginSidebarThreadActions}). Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_useSidebarThreadActions(): PluginSidebarThreadActions;
  /**
   * The pull request for one thread's branch (see
   * {@link PluginSidebarThreadPullRequestState}).
   *
   * Per row and opt-in, because it costs a git-host lookup: it is NOT on the
   * thread payload every sidebar loads. Threads sharing an environment share
   * one query, and the host owns the polling and staleness rules — an open PR
   * with pending checks refreshes, a merged one does not.
   *
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_useSidebarThreadPullRequest(
    threadId: string,
  ): PluginSidebarThreadPullRequestState;
  /**
   * Per-row drag-to-split support (see {@link PluginSidebarThreadSplit}).
   * Call it once per rendered row, like the built-in sidebar does.
   * Experimental: see docs/api_to_audit.md.
   */
  experimental_useSidebarThreadSplit(
    threadId: string,
  ): PluginSidebarThreadSplit;
  /**
   * The provider directory (see {@link PluginProvidersState}). Reads the
   * host's own cached provider roster, so a plugin that shows a thread's
   * provider never re-vendors provider names, icons, or copy. Experimental:
   * see docs/api_to_audit.md.
   */
  experimental_useProviders(): PluginProvidersState;
  /**
   * The active code theme as a VS Code theme file (see
   * {@link PluginCodeThemeState}), for a plugin that renders code with an
   * engine of its own and needs BB's palette to reach it. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_useCodeTheme(): PluginCodeThemeState;
  /**
   * The host-owned chat component (see {@link ThreadChatProps}). Together
   * with `Markdown`, the only components the SDK ships — everything else
   * stays vendored per §5.5.
   */
  ThreadChat: ComponentType<ThreadChatProps>;
  /**
   * The host-owned chat-message markdown renderer (see
   * {@link MarkdownProps}).
   */
  Markdown: ComponentType<MarkdownProps>;
  /**
   * A real anchor whose ordinary HTTP(S) activation uses BB's URL preference.
   * Experimental: see docs/api_to_audit.md.
   */
  UrlLink: ComponentType<UrlLinkProps>;
  /** Host-rendered live-file link backed by the shared navigation controller. */
  experimental_FileLink: ComponentType<ExperimentalFileLinkProps>;
  /**
   * The host-owned new-thread compose surface (see
   * {@link NewThreadComposerProps}). Experimental: see
   * docs/api_to_audit.md for what to audit before the prefix drops.
   */
  experimental_NewThreadComposer: ComponentType<NewThreadComposerProps>;
  /**
   * BB's controlled provider/model/reasoning picker. Provider changes emit
   * only after the new provider's verified defaults and capabilities resolve,
   * so `onChange` always receives one coherent value. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_ProviderModelPicker: ComponentType<ExperimentalProviderModelPickerProps>;
  /**
   * BB's controlled permission-mode picker. The host resolves provider
   * capabilities and the routed machine's permission ceiling. Experimental:
   * see docs/api_to_audit.md.
   */
  experimental_PermissionModePicker: ComponentType<ExperimentalPermissionModePickerProps>;
  /**
   * The host-owned source viewer (see {@link SourceCodeProps}). Renders
   * supplied source text with BB's syntax highlighting, gutters, and live code
   * theme, and honours an active `experimental_sourceCodeRenderer`
   * replacement. Experimental: see docs/api_to_audit.md.
   */
  experimental_SourceCode: ComponentType<SourceCodeProps>;
  /**
   * The host-owned diff viewer (see {@link DiffProps}). Renders supplied patch
   * content with BB's normalization, optional full-file context expansion,
   * syntax highlighting, unified/split presentation, and live code theme, and
   * honours an active
   * `experimental_diffRenderer` replacement. Experimental: see
   * docs/api_to_audit.md.
   */
  experimental_Diff: ComponentType<DiffProps>;
  useComposerView(): ComposerView;
}
