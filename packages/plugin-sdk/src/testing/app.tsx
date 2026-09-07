import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { act, render, type RenderResult } from "@testing-library/react";
import {
  type BbContext,
  type BbNavigate,
  type ComposerCustomization,
  type ComposerView,
  type ExperimentalAppOverlayRegistration,
  type PluginAppDefinition,
  type PluginAppSetup,
  type PluginCodeThemeState,
  type PluginContentScriptDisposer,
  type PluginContentScriptRegistration,
  type PluginComposerApi,
  type PluginComposerMention,
  type PluginComposerScope,
  type PluginComposerTextEffect,
  type PluginComposerThreadRowStatus,
  type PluginFileOpenerRegistration,
  type PluginHomepageSectionRegistration,
  type PluginMessageActionRegistration,
  type PluginMessageDirectiveRegistration,
  type PluginDiffRendererRegistration,
  type PluginNavPanelRegistration,
  type PluginNewThreadPanelActionRegistration,
  type PluginPendingInteractionRegistration,
  type PluginProviderIconRegistration,
  type PluginTimelineRendererRegistration,
  type PluginRealtimeConnectionState,
  type PluginRpcClient,
  type PluginSdkApp,
  type PluginSettingsSectionRegistration,
  type PluginSettingsState,
  type PluginSidebarFooterActionRegistration,
  type ExperimentalSidebarNavigationRegistration,
  type PluginSidebarPullRequest,
  type PluginSidebarThreadActions,
  type PluginSidebarThreadPullRequestState,
  type PluginSidebarThreadSplit,
  type PluginProvidersState,
  type PluginSidebarThreadsState,
  type PluginSourceCodeRendererRegistration,
  type PluginThreadHeaderActionRegistration,
  type PluginThreadListRegistration,
  type PluginThreadPanelActionRegistration,
  type PluginRpcContract,
  type PluginRpcResult,
  type StandardSchemaV1InferInput,
  type MarkdownProps,
  type UrlLinkProps,
  type ExperimentalFileLinkProps,
  type ExperimentalFileOpenOptions,
  type ExperimentalAppPanel,
  type ExperimentalFixedTabTargetState,
  type ExperimentalOpenFixedTabOptions,
  type ExperimentalPluginFixedTabReference,
  type NewThreadComposerProps,
  type ExperimentalPermissionModePickerProps,
  type ExperimentalProviderModelPickerProps,
  type ThreadChatProps,
  type DiffProps,
  type SourceCodeProps,
  type JsonValue,
} from "@get-bb/plugin-sdk";
import { isComposerDraftEmpty } from "../internal/composer-view.js";
import { normalizePluginThreadRowStatus } from "../internal/composer-customization-validation.js";
import { normalizeExperimentalFileOpenOptions } from "../internal/file-navigation-validation.js";
import {
  collectPluginAppRegistrations,
  type CollectedExperimentalSidebarFooterItem,
} from "../internal/plugin-app-collector.js";

/**
 * `@get-bb/plugin-sdk/testing/app` — the frontend plugin test harness. Tests a
 * plugin's `app.tsx` source directly under vitest + jsdom, without the bb
 * host or the esbuild bundle:
 *
 * - {@link installTestPluginRuntime} fills `globalThis.__bbPluginRuntime.
 *   pluginSdkApp` with a test implementation of the `@get-bb/plugin-sdk/app`
 *   surface (the same seam `bb plugin build` shims to the real app). It must
 *   run BEFORE the plugin's `app.tsx` module evaluates, because that module
 *   binds the runtime at import time — so import `app.tsx` through
 *   {@link loadPluginApp}'s thunk form, or call the installer from a vitest
 *   setup file when you prefer static imports.
 * - {@link loadPluginApp} runs the definition's setup against a validating
 *   collector (ported from the BB app's interpreter, same error messages)
 *   and returns the typed slot registrations.
 * - {@link renderSlot} mounts one registration's component with mock hook
 *   backends: rpc as a method→handler map with a call log, realtime as a
 *   channel you can push events into, settings/context as plain values, and
 *   navigate/composer as recorders. Its `behavior`, `inspection`, and
 *   `lifecycle` views separate host inputs, assertions, and mount controls;
 *   the existing direct members remain aliases.
 *
 * Add `// @vitest-environment jsdom` to test files using renderSlot.
 */

// ---------------------------------------------------------------------------
// The test-side hook environment (one per renderSlot mount).
// ---------------------------------------------------------------------------

export interface RpcCall {
  method: string;
  input: unknown;
}
export type NavigateCall =
  | { method: "toThread"; threadId: string }
  | { method: "toProject"; projectId: string }
  | {
      method: "toPluginPanel";
      path: string;
      options?: { subPath?: string; replace?: boolean };
    }
  | {
      method: "toCompose";
      options?: { initialPrompt?: string; focusPrompt?: boolean };
    }
  | {
      method: "openThreadPanel";
      options: Parameters<BbNavigate["openThreadPanel"]>[0];
    }
  | { method: "openUrl"; url: string }
  | {
      method: "experimental_openFilePreview";
      options: ExperimentalFileOpenOptions;
    }
  | {
      method: "experimental_openFileExternally";
      options: ExperimentalFileOpenOptions;
    };

export interface ExperimentalFixedTabOpenCall {
  surface: ExperimentalOpenFixedTabOptions<JsonValue>["surface"];
  panelId: string;
  tabId: string;
  target?: JsonValue;
}

export interface ComposerLog {
  /** Latest plain text in this isolated composer scope. */
  readonly text: string;
  /** Latest host-provided composer scope. */
  readonly scope: PluginComposerScope;
  /** Latest host-provided attachment count exposed through `useComposerView()`. */
  readonly attachmentCount: number;
  /** Latest host-rendered text effect requested by the plugin. */
  textEffect: PluginComposerTextEffect | null;
  textEffectCalls: Array<PluginComposerTextEffect | null>;
  /** Whether this plugin currently holds the composer input lock. */
  inputLocked: boolean;
  inputLockCalls: boolean[];
  quotes: string[];
  mentions: PluginComposerMention[];
  focusCount: number;
  /**
   * Every `experimental_submit` the plugin ran, in order. The harness composer
   * has no submit pipeline of its own, so it records the options and clears the
   * draft — enough to assert what a picker scheduled and that it tidied up.
   */
  submits: Array<{ sendAt: number }>;
}

interface TestComposerStore {
  api: Omit<PluginComposerApi, "scope" | "text">;
  getAttachmentCount(): number;
  getScope(): PluginComposerScope;
  getText(): string;
  getVersionSnapshot(): number;
  subscribe(listener: () => void): () => void;
}

interface SlotEnv {
  rpcClient: PluginRpcClient;
  rpcCalls: RpcCall[];
  realtimeHandlers: Map<string, Set<(payload: unknown) => void>>;
  realtimeConnection: TestRealtimeConnectionStore;
  settingsState: PluginSettingsState;
  bbContext: BbContext;
  navigate: BbNavigate;
  navigateCalls: NavigateCall[];
  appPanel: ExperimentalAppPanel;
  experimental_fixedTabOpenCalls: ExperimentalFixedTabOpenCall[];
  fixedTabTarget: TestFixedTabTargetStore;
  composer: TestComposerStore;
  composerLog: ComposerLog;
  sidebarThreads: PluginSidebarThreadsState;
  sidebarActions: PluginSidebarThreadActions;
  sidebarActionCalls: SidebarActionCall[];
  sidebarPullRequests: ReadonlyMap<string, PluginSidebarPullRequest>;
  providers: PluginProvidersState;
  codeTheme: PluginCodeThemeState;
}

interface TestFixedTabTargetStore {
  clear(sequence: number): void;
  getSnapshot(): {
    panelId: string;
    sequence: number;
    tabId: string;
    target: JsonValue;
  } | null;
  subscribe(listener: () => void): () => void;
}

/** One recorded `experimental_useSidebarThreadActions()` call. */
export interface SidebarActionCall {
  method: keyof PluginSidebarThreadActions;
  threadId?: string;
  options?: Record<string, unknown>;
  title?: string;
  pinned?: boolean;
  read?: boolean;
}

function SlotLifecycleGuard({
  children,
  onUnmount,
}: {
  children: ReactNode;
  onUnmount: () => void;
}) {
  useEffect(() => () => onUnmount(), [onUnmount]);
  return children;
}

interface TestRealtimeConnectionStore {
  getSnapshot(): PluginRealtimeConnectionState;
  subscribe(listener: () => void): () => void;
  setState(state: PluginRealtimeConnectionState): void;
}

const SlotEnvContext = createContext<SlotEnv | null>(null);

function useSlotEnv(hook: string): SlotEnv {
  const env = useContext(SlotEnvContext);
  if (!env) {
    throw new Error(
      `${hook}() needs the test slot environment — mount the component via renderSlot(...) from @get-bb/plugin-sdk/testing/app`,
    );
  }
  return env;
}

// ---------------------------------------------------------------------------
// The fake @get-bb/plugin-sdk/app runtime.
// ---------------------------------------------------------------------------

/** Same shape (and checks) as the BB app's real definePluginApp. */
function definePluginApp(setup: PluginAppSetup): PluginAppDefinition {
  if (typeof setup !== "function") {
    throw new Error("definePluginApp expects a setup function");
  }
  return Object.freeze({ __bbPluginApp: true as const, setup });
}

function isPluginAppDefinition(value: unknown): value is PluginAppDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __bbPluginApp?: unknown }).__bbPluginApp === true &&
    typeof (value as { setup?: unknown }).setup === "function"
  );
}

/**
 * Stand-in for the host-owned ThreadChat component: a recognizable stub that
 * records every public prop as a data attribute so plugin tests can assert
 * what their slot component passed without the real chat engine.
 * `leadingContent` renders inside the stub; each `messageActions` entry
 * renders as a button (`data-testid="bb-thread-chat-action-<id>"`) that
 * invokes its `run` with a synthetic assistant message reference, so plugin
 * tests can drive the action without the real timeline.
 */
function TestThreadChat({
  threadId,
  variant = "full",
  layout = "contained",
  focusRequest,
  permissionPolicy = "inherit",
  className,
  leadingContent,
  messageActions,
}: ThreadChatProps) {
  return (
    <div
      data-testid="bb-thread-chat"
      data-thread-id={threadId}
      data-variant={variant}
      data-layout={layout}
      data-focus-request={focusRequest ?? 0}
      data-permission-policy={permissionPolicy}
      data-message-actions={(messageActions ?? [])
        .map((action) => action.id)
        .join(" ")}
      className={className}
    >
      {leadingContent === undefined ? null : (
        <div data-testid="bb-thread-chat-leading-content">{leadingContent}</div>
      )}
      ThreadChat stub ({threadId})
      {(messageActions ?? []).map((action) => (
        <button
          key={action.id}
          type="button"
          data-testid={`bb-thread-chat-action-${action.id}`}
          data-roles={action.roles === undefined ? "" : action.roles.join(" ")}
          onClick={() => {
            void action.run({
              id: "test-message",
              threadId,
              role: action.roles?.[0] ?? "assistant",
              text: "test message text",
              sourceSeqEnd: 1,
            });
          }}
        >
          {action.title}
        </button>
      ))}
    </div>
  );
}

/**
 * Stand-in for the host-owned Markdown renderer: emits the raw source in a
 * recognizable wrapper so plugin tests can assert what content they passed
 * without the real renderer.
 */
function TestMarkdown({ content, className }: MarkdownProps) {
  return (
    <div data-testid="bb-markdown" className={className}>
      {content}
    </div>
  );
}

/** Anchor-faithful stand-in backed by the same navigation recorder as the hook. */
function TestUrlLink({
  href,
  onClick,
  rel,
  target,
  ...anchorProps
}: UrlLinkProps) {
  const navigate = useSlotEnv("UrlLink").navigate;
  const normalizedTarget = target?.toLowerCase();
  const opensNewBrowsingContext =
    normalizedTarget !== undefined &&
    normalizedTarget !== "" &&
    normalizedTarget !== "_self" &&
    normalizedTarget !== "_parent" &&
    normalizedTarget !== "_top" &&
    normalizedTarget !== "_unfencedtop";
  const relTokens = rel?.split(/\s+/u).filter(Boolean) ?? [];
  const normalizedRelTokens = relTokens.map((token) => token.toLowerCase());
  const resolvedRel =
    opensNewBrowsingContext && !normalizedRelTokens.includes("opener")
      ? [
          ...relTokens,
          ...(normalizedRelTokens.includes("noopener") ? [] : ["noopener"]),
          ...(normalizedRelTokens.includes("noreferrer") ? [] : ["noreferrer"]),
        ].join(" ")
      : rel;
  return (
    <a
      {...anchorProps}
      href={href}
      target={target}
      rel={resolvedRel}
      onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.currentTarget.hasAttribute("download") ||
          event.currentTarget.hasAttribute("target")
        ) {
          return;
        }
        if (navigate.openUrl(href)) event.preventDefault();
      }}
    />
  );
}

/** Anchor-faithful file-link stand-in backed by the navigation recorder. */
function TestFileLink({
  target,
  location = null,
  onClick,
  ...anchorProps
}: ExperimentalFileLinkProps) {
  const navigate = useSlotEnv("experimental_FileLink").navigate;
  const options = normalizeExperimentalFileOpenOptions({ target, location });
  const href =
    options === null
      ? undefined
      : `./${encodeURIComponent(options.target.path)}`;
  return (
    <a
      {...anchorProps}
      href={href}
      onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (
          options === null ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.currentTarget.hasAttribute("download")
        ) {
          return;
        }
        event.preventDefault();
        navigate.experimental_openFilePreview(options);
      }}
    />
  );
}

/**
 * Stand-in for the host-owned new-thread composer: a textarea plus a submit
 * button that calls `onSubmit` with a fixed, obviously-synthetic request, so
 * plugin tests can drive the create path without the real compose surface.
 */
function TestNewThreadComposer({
  defaultProjectId,
  defaultProviderId,
  defaultModel,
  defaultReasoningLevel,
  defaultServiceTier,
  defaultPermissionMode,
  defaultEnvironment,
  initialPrompt,
  placeholder,
  layout = "contained",
  focusRequest,
  className,
  draftKey,
  onSubmit,
}: NewThreadComposerProps) {
  const [text, setText] = useState(initialPrompt ?? "");
  return (
    <div
      data-testid="bb-new-thread-composer"
      data-default-project-id={defaultProjectId ?? ""}
      data-default-provider-id={defaultProviderId ?? ""}
      data-default-model={defaultModel ?? ""}
      data-default-reasoning-level={defaultReasoningLevel ?? ""}
      data-default-service-tier={defaultServiceTier ?? ""}
      data-default-permission-mode={defaultPermissionMode ?? ""}
      data-default-environment={
        defaultEnvironment === undefined
          ? ""
          : JSON.stringify(defaultEnvironment)
      }
      data-layout={layout}
      data-focus-request={focusRequest ?? 0}
      data-draft-key={draftKey ?? ""}
      className={className}
    >
      <textarea
        data-testid="bb-new-thread-composer-input"
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        data-testid="bb-new-thread-composer-submit"
        onClick={() => {
          // Untouched submits echo the `default*` seeds back, mirroring the
          // real composer's round-trip guarantee so plugin tests can cover
          // the store-then-restore pattern.
          void onSubmit({
            projectId: defaultProjectId ?? "project-test",
            providerId: defaultProviderId ?? "codex",
            model: defaultModel ?? "gpt-5",
            reasoningLevel: defaultReasoningLevel ?? "medium",
            permissionMode: defaultPermissionMode ?? "auto",
            ...(defaultServiceTier !== undefined
              ? { serviceTier: defaultServiceTier }
              : {}),
            executionInputSources: {},
            environment: defaultEnvironment ?? { type: "project-default" },
            input: [{ type: "text", text, mentions: [] }],
          });
        }}
      >
        Start thread
      </button>
    </div>
  );
}

function TestProviderModelPicker({
  value,
  onChange,
  routing,
  allowProviderChange = true,
  align = "start",
  disabled,
  className,
}: ExperimentalProviderModelPickerProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const reasoningLevels = [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "ultracode",
    "max",
    "ultra",
  ] as const;

  return (
    <div
      data-testid="bb-provider-model-picker"
      data-routing-kind={routing?.kind ?? "primary"}
      data-routing-id={
        routing === undefined
          ? ""
          : routing.kind === "host"
            ? routing.hostId
            : routing.environmentId
      }
      data-disabled={disabled ? "true" : "false"}
      data-provider-change-allowed={allowProviderChange ? "true" : "false"}
      data-align={align}
      className={className}
    >
      <fieldset disabled={disabled} className="contents">
        <input
          aria-label="Provider ID"
          disabled={!allowProviderChange}
          value={draft.providerId}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              providerId: event.target.value,
            }))
          }
        />
        <input
          aria-label="Model"
          value={draft.model}
          onChange={(event) =>
            setDraft((current) => ({ ...current, model: event.target.value }))
          }
        />
        <input
          aria-label="Reasoning level"
          value={draft.reasoningLevel}
          onChange={(event) => {
            const reasoningLevel = reasoningLevels.find(
              (candidate) => candidate === event.target.value,
            );
            if (reasoningLevel === undefined) return;
            setDraft((current) => ({ ...current, reasoningLevel }));
          }}
        />
        <select
          aria-label="Service tier"
          value={draft.serviceTier ?? ""}
          onChange={(event) =>
            setDraft((current) => {
              const serviceTier = event.target.value;
              if (serviceTier !== "fast" && serviceTier !== "default") {
                const next = { ...current };
                delete next.serviceTier;
                return next;
              }
              return { ...current, serviceTier };
            })
          }
        >
          <option value="">Unsupported</option>
          <option value="default">Default</option>
          <option value="fast">Fast</option>
        </select>
        <button type="button" onClick={() => onChange(draft)}>
          Apply execution selection
        </button>
      </fieldset>
    </div>
  );
}

function TestPermissionModePicker({
  providerId,
  value,
  onChange,
  routing,
  align = "end",
  disabled,
  className,
}: ExperimentalPermissionModePickerProps) {
  return (
    <select
      aria-label="Permission mode"
      value={value}
      disabled={disabled}
      data-testid="bb-permission-mode-picker"
      data-provider-id={providerId}
      data-align={align}
      data-routing-kind={routing?.kind ?? "primary"}
      data-routing-id={
        routing === undefined
          ? ""
          : routing.kind === "host"
            ? routing.hostId
            : routing.environmentId
      }
      className={className}
      onChange={(event) => {
        const permissionMode = event.target.value;
        if (
          permissionMode === "accept-edits" ||
          permissionMode === "auto" ||
          permissionMode === "full"
        ) {
          onChange(permissionMode);
        }
      }}
    >
      <option value="accept-edits">Accept Edits</option>
      <option value="auto">Approve for me</option>
      <option value="full">Full Access</option>
    </select>
  );
}

/**
 * Stand-in for the host-owned source viewer: emits the raw source in a
 * recognizable wrapper carrying the resolved presentation, so plugin tests can
 * assert what they asked the host to render without the real highlighter.
 */
function TestSourceCode({
  content,
  path,
  overflow = "scroll",
  highlightedLines = null,
  className,
}: SourceCodeProps) {
  return (
    <pre
      data-testid="bb-source-code"
      data-path={path}
      data-overflow={overflow}
      data-highlighted-lines={
        highlightedLines === null
          ? ""
          : `${highlightedLines.start}-${highlightedLines.end}`
      }
      className={className}
    >
      {content}
    </pre>
  );
}

/**
 * Stand-in for the host-owned diff viewer: emits the raw patch in a
 * recognizable wrapper carrying the resolved presentation.
 */
function TestDiff({
  patch,
  path,
  view = "unified",
  overflow = "scroll",
  showLineNumbers = true,
  experimental_fullFileContents,
  className,
}: DiffProps) {
  return (
    <pre
      data-testid="bb-diff"
      data-path={path}
      data-view={view}
      data-overflow={overflow}
      data-show-line-numbers={showLineNumbers ? "true" : "false"}
      data-has-full-file-contents={
        experimental_fullFileContents === undefined ? "false" : "true"
      }
      className={className}
    >
      {patch}
    </pre>
  );
}

const testPluginSdkApp = {
  definePluginApp,
  useRpc<
    Contract extends PluginRpcContract = PluginRpcContract,
  >(): PluginRpcClient<Contract> {
    return useSlotEnv("useRpc").rpcClient as PluginRpcClient<Contract>;
  },
  useRealtime(channel: string, handler: (payload: unknown) => void): void {
    const env = useSlotEnv("useRealtime");
    // Latest handler without resubscribing per render, like the host hook.
    const handlerRef = useRef(handler);
    useEffect(() => {
      handlerRef.current = handler;
    });
    useEffect(() => {
      const listener = (payload: unknown) => handlerRef.current(payload);
      let listeners = env.realtimeHandlers.get(channel);
      if (!listeners) {
        listeners = new Set();
        env.realtimeHandlers.set(channel, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, [env, channel]);
  },
  useRealtimeConnectionState(): PluginRealtimeConnectionState {
    const connection = useSlotEnv(
      "useRealtimeConnectionState",
    ).realtimeConnection;
    return useSyncExternalStore(
      connection.subscribe,
      connection.getSnapshot,
      connection.getSnapshot,
    );
  },
  useSettings(): PluginSettingsState {
    return useSlotEnv("useSettings").settingsState;
  },
  useBbContext(): BbContext {
    return useSlotEnv("useBbContext").bbContext;
  },
  useBbNavigate(): BbNavigate {
    return useSlotEnv("useBbNavigate").navigate;
  },
  experimental_useAppPanel(): ExperimentalAppPanel {
    return useSlotEnv("experimental_useAppPanel").appPanel;
  },
  experimental_useFixedTabTarget<Target extends JsonValue>(
    tab: ExperimentalPluginFixedTabReference<Target>,
  ): ExperimentalFixedTabTargetState<Target> | null {
    const store = useSlotEnv("experimental_useFixedTabTarget").fixedTabTarget;
    const state = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
    if (
      state === null ||
      state.panelId !== tab.panelId ||
      state.tabId !== tab.id ||
      tab.experimental_target === undefined
    ) {
      return null;
    }
    try {
      if (!tab.experimental_target.validate(state.target)) return null;
    } catch {
      return null;
    }
    return {
      clear: () => store.clear(state.sequence),
      sequence: state.sequence,
      target: state.target,
    };
  },
  useComposer(): PluginComposerApi {
    const composer = useSlotEnv("useComposer").composer;
    const version = useSyncExternalStore(
      composer.subscribe,
      composer.getVersionSnapshot,
      composer.getVersionSnapshot,
    );
    return useMemo(
      () => ({
        ...composer.api,
        scope: composer.getScope(),
        text: composer.getText(),
      }),
      [composer, version],
    );
  },
  ThreadChat: TestThreadChat,
  Markdown: TestMarkdown,
  experimental_FileLink: TestFileLink,
  UrlLink: TestUrlLink,
  experimental_NewThreadComposer: TestNewThreadComposer,
  experimental_ProviderModelPicker: TestProviderModelPicker,
  experimental_PermissionModePicker: TestPermissionModePicker,
  experimental_SourceCode: TestSourceCode,
  experimental_Diff: TestDiff,
  experimental_useSidebarThreads(): PluginSidebarThreadsState {
    return useSlotEnv("experimental_useSidebarThreads").sidebarThreads;
  },
  experimental_useProviders(): PluginProvidersState {
    return useSlotEnv("experimental_useProviders").providers;
  },
  experimental_useCodeTheme(): PluginCodeThemeState {
    return useSlotEnv("experimental_useCodeTheme").codeTheme;
  },
  experimental_useSidebarThreadActions(): PluginSidebarThreadActions {
    return useSlotEnv("experimental_useSidebarThreadActions").sidebarActions;
  },
  experimental_useSidebarThreadSplit(threadId): PluginSidebarThreadSplit {
    const env = useSlotEnv("experimental_useSidebarThreadSplit");
    return useMemo(
      () => ({
        splitProps: {
          onPointerDown: () => {
            env.sidebarActionCalls.push({ method: "open", threadId });
          },
        },
        isAvailable: true,
        layout: null,
      }),
      [env, threadId],
    );
  },
  experimental_useSidebarThreadPullRequest(
    threadId,
  ): PluginSidebarThreadPullRequestState {
    const env = useSlotEnv("experimental_useSidebarThreadPullRequest");
    return useMemo(
      () => ({
        isLoading: false,
        pullRequest: env.sidebarPullRequests.get(threadId) ?? null,
      }),
      [env, threadId],
    );
  },
  useComposerView(): ComposerView {
    const composer = useSlotEnv("useComposerView").composer;
    const version = useSyncExternalStore(
      composer.subscribe,
      composer.getVersionSnapshot,
      composer.getVersionSnapshot,
    );
    return useMemo(() => {
      const text = composer.getText();
      const attachmentCount = composer.getAttachmentCount();
      return {
        scope: composer.getScope(),
        layout: "expanded",
        draft: {
          text,
          isEmpty: isComposerDraftEmpty(text, attachmentCount),
          attachmentCount,
        },
        run: { isRunning: false, isSubmitting: false },
      };
    }, [composer, version]);
  },
} satisfies PluginSdkApp;

interface PluginRuntimeHost {
  __bbPluginRuntime?: { pluginSdkApp?: unknown };
}

/**
 * Install the test runtime at `globalThis.__bbPluginRuntime.pluginSdkApp`.
 * Idempotent per module instance; must run before the plugin's `app.tsx`
 * (and therefore `@get-bb/plugin-sdk/app`) is imported.
 */
export function installTestPluginRuntime(): void {
  const host = globalThis as PluginRuntimeHost;
  host.__bbPluginRuntime = {
    ...host.__bbPluginRuntime,
    pluginSdkApp: testPluginSdkApp,
  };
}

// ---------------------------------------------------------------------------
// loadPluginApp — run setup, capture typed slot registrations.
// ---------------------------------------------------------------------------

export interface CapturedPluginApp {
  homepageSections: PluginHomepageSectionRegistration[];
  settingsSections: PluginSettingsSectionRegistration[];
  appOverlays: ExperimentalAppOverlayRegistration[];
  navPanels: PluginNavPanelRegistration[];
  threadPanelActions: PluginThreadPanelActionRegistration[];
  newThreadPanelActions: PluginNewThreadPanelActionRegistration[];
  composerCustomizations: ComposerCustomization[];
  pendingInteractions: PluginPendingInteractionRegistration[];
  sidebarFooterActions: PluginSidebarFooterActionRegistration[];
  experimentalSidebarFooterItems: CollectedExperimentalSidebarFooterItem[];
  experimentalSidebarNavigations: ExperimentalSidebarNavigationRegistration[];
  threadLists: PluginThreadListRegistration[];
  threadHeaderActions: PluginThreadHeaderActionRegistration[];
  fileOpeners: PluginFileOpenerRegistration[];
  sourceCodeRenderers: PluginSourceCodeRendererRegistration[];
  diffRenderers: PluginDiffRendererRegistration[];
  messageDirectives: PluginMessageDirectiveRegistration[];
  messageActions: PluginMessageActionRegistration[];
  providerIcons: PluginProviderIconRegistration[];
  timelineRenderers: PluginTimelineRendererRegistration[];
  contentScripts: PluginContentScriptRegistration[];
}

type PluginAppModule = { default: unknown };

export type PluginAppSource =
  | PluginAppDefinition
  | PluginAppModule
  | (() => Promise<PluginAppDefinition | PluginAppModule>);

/**
 * Install the test runtime, resolve the plugin app definition, and capture
 * its slot registrations. Pass a thunk (`() => import("../app.tsx")`) so the
 * plugin module evaluates after the runtime is installed — a static import
 * would bind `definePluginApp` before the installer runs.
 */
export async function loadPluginApp(
  source: PluginAppSource,
): Promise<CapturedPluginApp> {
  installTestPluginRuntime();
  const resolved = typeof source === "function" ? await source() : source;
  const definition = isPluginAppDefinition(resolved)
    ? resolved
    : (resolved as PluginAppModule).default;
  if (!isPluginAppDefinition(definition)) {
    throw new Error(
      "the bundle's default export is not definePluginApp(...) from @get-bb/plugin-sdk/app",
    );
  }
  return collectPluginAppRegistrations(definition);
}

export interface ContentScriptTestMountOptions {
  pluginId: string;
  /** Defaults to 1. Pass the host generation you want the plugin to observe. */
  generation?: number;
  /**
   * Simulate an older compatible host that predates the optional experimental
   * thread-row status API. Current-host behavior is enabled by default.
   */
  omitExperimentalThreadRowStatus?: boolean;
}

export interface ContentScriptThreadRowStatusCall {
  threadId: string;
  status: PluginComposerThreadRowStatus | null;
}

export interface MountedPluginContentScripts {
  inspection: {
    readonly mountedIds: readonly string[];
    readonly signal: AbortSignal;
    readonly disposed: boolean;
    readonly threadRowStatusCalls: readonly ContentScriptThreadRowStatusCall[];
    getThreadRowStatus(threadId: string): PluginComposerThreadRowStatus | null;
  };
  lifecycle: {
    /** Abort, then run returned cleanup functions once in reverse order. */
    dispose(): Promise<void>;
  };
}

/**
 * Mount captured content scripts with host-faithful ordering and rollback.
 * Call this once per simulated app window; each result owns an independent
 * AbortSignal and cleanup lifecycle.
 */
export async function mountPluginContentScripts(
  app: CapturedPluginApp,
  options: ContentScriptTestMountOptions,
): Promise<MountedPluginContentScripts> {
  const controller = new AbortController();
  const generation = options.generation ?? 1;
  const mounted: Array<{
    id: string;
    dispose: PluginContentScriptDisposer | null;
  }> = [];
  const threadRowStatuses = new Map<string, PluginComposerThreadRowStatus>();
  const threadRowStatusCalls: ContentScriptThreadRowStatusCall[] = [];
  let disposed = false;
  const setThreadRowStatus = (threadId: unknown, status: unknown): void => {
    if (controller.signal.aborted) return;
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      console.warn(
        `bb plugin "${options.pluginId}": contentScript.experimental_setThreadRowStatus: "threadId" must be a non-empty string`,
      );
      return;
    }
    const normalizedThreadId = threadId.trim();
    const normalizedStatus = normalizePluginThreadRowStatus(status, (reason) =>
      console.warn(`bb plugin "${options.pluginId}": ${reason}`),
    );
    if (normalizedStatus === undefined) return;
    const recordedStatus =
      normalizedStatus === null ? null : { ...normalizedStatus };
    threadRowStatusCalls.push({
      threadId: normalizedThreadId,
      status: recordedStatus,
    });
    if (recordedStatus === null) {
      threadRowStatuses.delete(normalizedThreadId);
    } else {
      threadRowStatuses.set(normalizedThreadId, recordedStatus);
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    for (const script of [...mounted].reverse()) {
      if (script.dispose === null) continue;
      try {
        await script.dispose();
      } catch (error) {
        console.warn(
          `[plugin:${options.pluginId}] content script "${script.id}" cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    threadRowStatuses.clear();
  };

  try {
    for (const registration of app.contentScripts) {
      const result = await registration.mount({
        pluginId: options.pluginId,
        generation,
        signal: controller.signal,
        ...(!options.omitExperimentalThreadRowStatus
          ? { experimental_setThreadRowStatus: setThreadRowStatus }
          : {}),
      });
      if (result !== undefined && typeof result !== "function") {
        throw new Error(
          `content script "${registration.id}" mount must return a cleanup function, a promise of one, or nothing`,
        );
      }
      mounted.push({ id: registration.id, dispose: result ?? null });
    }
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    inspection: {
      get mountedIds() {
        return mounted.map(({ id }) => id);
      },
      signal: controller.signal,
      get disposed() {
        return disposed;
      },
      get threadRowStatusCalls() {
        return threadRowStatusCalls.map(({ threadId, status }) => ({
          threadId,
          status: status === null ? null : { ...status },
        }));
      },
      getThreadRowStatus(threadId) {
        const status = threadRowStatuses.get(threadId);
        return status === undefined ? null : { ...status };
      },
    },
    lifecycle: { dispose },
  };
}

// ---------------------------------------------------------------------------
// renderSlot — mount one registration's component with mock hook backends.
// ---------------------------------------------------------------------------

export type PluginRpcTestHandlers<Contract extends PluginRpcContract> = {
  [Method in keyof Contract]: (
    input: StandardSchemaV1InferInput<Contract[Method]["input"]>,
  ) =>
    | PluginRpcResult<Contract[Method]>
    | Promise<PluginRpcResult<Contract[Method]>>;
};

export interface RenderSlotOptions<
  Contract extends PluginRpcContract = PluginRpcContract,
> {
  /**
   * Backing handlers for `useRpc().call`: method name → implementation.
   * Inputs and results are JSON-round-tripped like the wire; a method
   * without a handler rejects, and a throwing handler rejects with its
   * message (what the real rpc client surfaces).
   */
  rpc?: PluginRpcTestHandlers<Contract>;
  /** `useSettings()` values; omitted → `{ values: undefined, isLoading: false }`. */
  settings?: Record<string, string | number | boolean>;
  /** `useBbContext()` selection; both default to null. */
  context?: { projectId?: string | null; threadId?: string | null };
  /** Initial `useRealtimeConnectionState()` value; defaults to `connected`. */
  realtimeConnectionState?: PluginRealtimeConnectionState;
  /** Initial state for this render's isolated composer scope and view. */
  composer?: {
    text?: string;
    scope?: PluginComposerScope;
    attachmentCount?: number;
  };
  /**
   * Threads and projects `experimental_useSidebarThreads()` reports. Omitted →
   * a ready, empty list. Pass `{ status: "loading" }` to test that branch.
   */
  sidebarThreads?: Partial<PluginSidebarThreadsState>;
  /**
   * The provider directory `experimental_useProviders()` reports. Omitted →
   * a ready, empty list. Pass `{ status: "loading" }` to test that branch.
   */
  providers?: Partial<PluginProvidersState>;
  /**
   * The code theme `experimental_useCodeTheme()` reports. Omitted → a light
   * mode with no resolved document, the state a plugin sees on first paint.
   */
  codeTheme?: Partial<PluginCodeThemeState>;
  /**
   * Pull requests `experimental_useSidebarThreadPullRequest()` reports, keyed
   * by thread id. Omitted → every thread reports none.
   */
  sidebarPullRequests?: Record<string, PluginSidebarPullRequest>;
  /** Host acceptance for `useBbNavigate().openThreadPanel`. */
  openThreadPanel?: (
    options: Parameters<BbNavigate["openThreadPanel"]>[0],
  ) => boolean;
  /** Host acceptance for URL intents from the hook or `UrlLink`. */
  openUrl?: (url: string) => boolean;
  /** Host acceptance for preview intents from the hook or file link. */
  openFilePreview?: (options: ExperimentalFileOpenOptions) => boolean;
  /** Host acceptance for preferred-external file intents. */
  openFileExternally?: (options: ExperimentalFileOpenOptions) => boolean;
  /** Host acceptance for an owner-scoped fixed-tab selection. */
  experimental_openFixedTab?: (call: ExperimentalFixedTabOpenCall) => boolean;
  /** Initial session target visible to `experimental_useFixedTabTarget`. */
  experimental_fixedTabTarget?: {
    panelId: string;
    tabId: string;
    target: JsonValue;
  };
}

/** Host-originated inputs a slot test can drive deterministically. */
export interface RenderedSlotBehaviorDrivers {
  /**
   * Push a realtime event to `useRealtime(channel, …)` subscribers, wrapped
   * in act. The payload is JSON-round-tripped like `bb.realtime.publish`.
   */
  emitRealtime(channel: string, payload: unknown): Promise<void>;
  /** Drive the lifecycle of the same connection used by realtime events. */
  setRealtimeConnectionState(
    state: PluginRealtimeConnectionState,
  ): Promise<void>;
  /** Replace composer text as a host-originated edit, wrapped in act. */
  setComposerText(text: string): Promise<void>;
  /** Replace the scope snapshots returned by composer hooks, wrapped in act. */
  setComposerScope(scope: PluginComposerScope): Promise<void>;
}

/** Read-only call/write logs produced while the slot is mounted. */
export interface RenderedSlotInspectionState {
  /** Every `useRpc().call`, in order. */
  readonly rpcCalls: RpcCall[];
  /** Every `useBbNavigate()` call, in order. */
  readonly navigateCalls: NavigateCall[];
  /** Every validated `experimental_useAppPanel().openFixedTab` call. */
  readonly experimental_fixedTabOpenCalls: ExperimentalFixedTabOpenCall[];
  /** Every `experimental_useSidebarThreadActions()` call, in order. */
  readonly sidebarActionCalls: SidebarActionCall[];
  /** Everything written through `useComposer()`. */
  readonly composer: ComposerLog;
}

/** Explicit mount controls, separate from behavior inputs and call logs. */
export interface RenderedSlotLifecycleControls {
  rerender(ui: ReactNode): void;
  unmount(): void;
}

/**
 * Testing Library result plus BB-specific helpers. Direct members are
 * retained for compatibility; named views make intent explicit in new tests.
 */
export interface RenderedSlot
  extends
    RenderResult,
    RenderedSlotBehaviorDrivers,
    RenderedSlotInspectionState {
  readonly behavior: RenderedSlotBehaviorDrivers;
  readonly inspection: RenderedSlotInspectionState;
  readonly lifecycle: RenderedSlotLifecycleControls;
}

function strictJsonRoundTrip(value: unknown, label: string): JsonValue {
  const ancestors = new Set<object>();
  function visit(current: unknown, path: string): void {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`${label} at ${path} contains a non-finite number`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new Error(`${label} at ${path} is not a JSON value`);
    }
    if (ancestors.has(current)) {
      throw new Error(`${label} at ${path} is cyclic`);
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        current.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} at ${path} must be a plain JSON object`);
      }
      if (Reflect.ownKeys(current).some((key) => typeof key === "symbol")) {
        throw new Error(`${label} at ${path} contains a symbol key`);
      }
      for (const [key, child] of Object.entries(current)) {
        visit(child, `${path}.${key}`);
      }
    } finally {
      ancestors.delete(current);
    }
  }
  visit(value, "$");
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function renderSlot<
  Props extends object,
  Contract extends PluginRpcContract = PluginRpcContract,
>(
  registration: { component: ComponentType<Props> },
  props: Props,
  options: RenderSlotOptions<Contract> = {},
): RenderedSlot {
  const rpcCalls: RpcCall[] = [];
  const rpcHandlers = (options.rpc ?? {}) as Record<
    string,
    (input: unknown) => unknown
  >;
  const rpcClient: PluginRpcClient = {
    async call(method, input) {
      const normalizedInput =
        input === undefined
          ? null
          : strictJsonRoundTrip(input, `rpc "${method}" input`);
      rpcCalls.push({ method, input: normalizedInput });
      const handler = rpcHandlers[method];
      if (!handler) {
        throw new Error(
          `no rpc handler for "${method}" — add it to renderSlot options.rpc`,
        );
      }
      const result = await handler(normalizedInput);
      return strictJsonRoundTrip(result, `rpc "${method}" result`);
    },
  };

  const realtimeHandlers = new Map<string, Set<(payload: unknown) => void>>();
  let realtimeConnectionState =
    options.realtimeConnectionState ?? ("connected" as const);
  const realtimeConnectionListeners = new Set<() => void>();
  const realtimeConnection: TestRealtimeConnectionStore = {
    getSnapshot: () => realtimeConnectionState,
    subscribe(listener) {
      realtimeConnectionListeners.add(listener);
      return () => realtimeConnectionListeners.delete(listener);
    },
    setState(state) {
      if (state === realtimeConnectionState) return;
      realtimeConnectionState = state;
      for (const listener of realtimeConnectionListeners) listener();
    },
  };

  const navigateCalls: NavigateCall[] = [];
  const experimental_fixedTabOpenCalls: ExperimentalFixedTabOpenCall[] = [];
  let fixedTabTargetSnapshot =
    options.experimental_fixedTabTarget === undefined
      ? null
      : {
          panelId: options.experimental_fixedTabTarget.panelId,
          sequence: 1,
          tabId: options.experimental_fixedTabTarget.tabId,
          target: strictJsonRoundTrip(
            options.experimental_fixedTabTarget.target,
            "fixed tab target",
          ),
        };
  const fixedTabTargetListeners = new Set<() => void>();
  const fixedTabTarget: TestFixedTabTargetStore = {
    getSnapshot: () => fixedTabTargetSnapshot,
    subscribe(listener) {
      fixedTabTargetListeners.add(listener);
      return () => fixedTabTargetListeners.delete(listener);
    },
    clear(sequence) {
      if (fixedTabTargetSnapshot?.sequence !== sequence) return;
      fixedTabTargetSnapshot = null;
      for (const listener of fixedTabTargetListeners) listener();
    },
  };
  const appPanel: ExperimentalAppPanel = {
    openFixedTab(panelOptions) {
      let target: JsonValue | undefined;
      if (panelOptions.target !== undefined) {
        try {
          target = strictJsonRoundTrip(
            panelOptions.target,
            "fixed tab open target",
          );
        } catch {
          return false;
        }
        if (panelOptions.tab.experimental_target === undefined) return false;
        try {
          if (!panelOptions.tab.experimental_target.validate(target)) {
            return false;
          }
        } catch {
          return false;
        }
      }
      const call: ExperimentalFixedTabOpenCall = {
        surface: panelOptions.surface,
        panelId: panelOptions.tab.panelId,
        tabId: panelOptions.tab.id,
        ...(target === undefined ? {} : { target }),
      };
      experimental_fixedTabOpenCalls.push(call);
      const accepted = options.experimental_openFixedTab?.(call) ?? false;
      if (accepted && target !== undefined) {
        fixedTabTargetSnapshot = {
          panelId: panelOptions.tab.panelId,
          sequence: (fixedTabTargetSnapshot?.sequence ?? 0) + 1,
          tabId: panelOptions.tab.id,
          target,
        };
        for (const listener of fixedTabTargetListeners) listener();
      }
      return accepted;
    },
  };
  const sidebarActionCalls: SidebarActionCall[] = [];
  const sidebarPullRequests = new Map(
    Object.entries(options.sidebarPullRequests ?? {}),
  );
  const sidebarThreads: PluginSidebarThreadsState = {
    status: options.sidebarThreads?.status ?? "ready",
    threads: options.sidebarThreads?.threads ?? [],
    projects: options.sidebarThreads?.projects ?? [],
  };
  const providers: PluginProvidersState = {
    status: options.providers?.status ?? "ready",
    providers: options.providers?.providers ?? [],
  };
  const codeTheme: PluginCodeThemeState = {
    mode: options.codeTheme?.mode ?? "light",
    name: options.codeTheme?.name ?? "pierre-light",
    theme: options.codeTheme?.theme ?? null,
  };
  const sidebarActions: PluginSidebarThreadActions = {
    open(threadId, openOptions) {
      sidebarActionCalls.push({
        method: "open",
        threadId,
        ...(openOptions ? { options: { ...openOptions } } : {}),
      });
    },
    openNewThread(newThreadOptions) {
      sidebarActionCalls.push({
        method: "openNewThread",
        ...(newThreadOptions ? { options: { ...newThreadOptions } } : {}),
      });
    },
    async setPinned(threadId, pinned) {
      sidebarActionCalls.push({ method: "setPinned", threadId, pinned });
    },
    async setRead(threadId, read) {
      sidebarActionCalls.push({ method: "setRead", threadId, read });
    },
    async rename(threadId, title) {
      sidebarActionCalls.push({ method: "rename", threadId, title });
    },
    archive(threadId) {
      sidebarActionCalls.push({ method: "archive", threadId });
    },
    requestDelete(threadId) {
      sidebarActionCalls.push({ method: "requestDelete", threadId });
    },
  };
  const navigate: BbNavigate = {
    toThread(threadId) {
      navigateCalls.push({ method: "toThread", threadId });
    },
    toProject(projectId) {
      navigateCalls.push({ method: "toProject", projectId });
    },
    toPluginPanel(path, panelOptions) {
      navigateCalls.push({
        method: "toPluginPanel",
        path,
        ...(panelOptions !== undefined ? { options: panelOptions } : {}),
      });
    },
    toCompose(composeOptions) {
      navigateCalls.push({
        method: "toCompose",
        ...(composeOptions !== undefined ? { options: composeOptions } : {}),
      });
    },
    openThreadPanel(panelOptions) {
      navigateCalls.push({
        method: "openThreadPanel",
        options: panelOptions,
      });
      return options.openThreadPanel?.(panelOptions) ?? false;
    },
    openUrl(url) {
      navigateCalls.push({ method: "openUrl", url });
      return options.openUrl?.(url) ?? false;
    },
    experimental_openFilePreview(fileOptions) {
      navigateCalls.push({
        method: "experimental_openFilePreview",
        options: fileOptions,
      });
      return options.openFilePreview?.(fileOptions) ?? false;
    },
    experimental_openFileExternally(fileOptions) {
      navigateCalls.push({
        method: "experimental_openFileExternally",
        options: fileOptions,
      });
      return options.openFileExternally?.(fileOptions) ?? false;
    },
  };

  const projectId = options.context?.projectId ?? null;
  const threadId = options.context?.threadId ?? null;
  let composerScope: PluginComposerScope =
    options.composer?.scope ??
    (threadId !== null
      ? { kind: "thread", threadId }
      : { kind: "new-thread", projectId });

  let composerText = options.composer?.text ?? "";
  const composerAttachmentCount = options.composer?.attachmentCount ?? 0;
  let composerVersion = 0;
  const composerListeners = new Set<() => void>();
  const notifyComposerListeners = () => {
    composerVersion += 1;
    for (const listener of composerListeners) listener();
  };
  const commitComposerText = (next: string) => {
    if (next === composerText) return;
    composerText = next;
    notifyComposerListeners();
  };
  const composerLog: ComposerLog = {
    get text() {
      return composerText;
    },
    get scope() {
      return composerScope;
    },
    get attachmentCount() {
      return composerAttachmentCount;
    },
    textEffect: null,
    textEffectCalls: [],
    inputLocked: false,
    inputLockCalls: [],
    quotes: [],
    mentions: [],
    focusCount: 0,
    submits: [],
  };
  const composerOwnership = { active: true };
  const composer: TestComposerStore = {
    getAttachmentCount: () => composerAttachmentCount,
    getScope: () => composerScope,
    getText: () => composerText,
    getVersionSnapshot: () => composerVersion,
    subscribe(listener) {
      composerListeners.add(listener);
      return () => composerListeners.delete(listener);
    },
    api: {
      setText(next) {
        commitComposerText(next);
      },
      updateText(updater) {
        commitComposerText(updater(composerText));
      },
      clear() {
        commitComposerText("");
      },
      setTextEffect(effect) {
        if (!composerOwnership.active) return;
        composerLog.textEffect = effect;
        composerLog.textEffectCalls.push(effect);
      },
      setInputLock(locked) {
        if (!composerOwnership.active) return;
        composerLog.inputLocked = locked;
        composerLog.inputLockCalls.push(locked);
      },
      addQuote(text) {
        const trimmed = text.replace(/\r\n|\r/gu, "\n").trim();
        if (trimmed !== "") {
          const block = trimmed
            .split("\n")
            .map((line) => (line.length > 0 ? `> ${line}` : ">"))
            .join("\n");
          commitComposerText(
            composerText === "" ? `${block}\n` : `${composerText}\n${block}\n`,
          );
          composerLog.quotes.push(text);
        }
        composerLog.focusCount += 1;
      },
      insertMention(mention) {
        const label = mention.label.trim() || mention.id;
        const separator =
          composerText.length === 0 || /\s$/u.test(composerText) ? "" : " ";
        commitComposerText(`${composerText}${separator}${label} `);
        composerLog.mentions.push(mention);
        composerLog.focusCount += 1;
      },
      focus() {
        composerLog.focusCount += 1;
      },
      async experimental_submit({ sendAt }) {
        if (!composerOwnership.active) {
          throw new Error("This composer is no longer active.");
        }
        if (composerText.trim() === "") {
          throw new Error("Type a message before scheduling it.");
        }
        if (!Number.isFinite(sendAt) || sendAt <= Date.now()) {
          throw new Error("Pick a time in the future.");
        }
        composerLog.submits.push({ sendAt });
        commitComposerText("");
      },
    },
  };

  const env: SlotEnv = {
    rpcClient,
    rpcCalls,
    realtimeHandlers,
    realtimeConnection,
    settingsState: { values: options.settings, isLoading: false },
    bbContext: { projectId, threadId },
    navigate,
    navigateCalls,
    appPanel,
    experimental_fixedTabOpenCalls,
    fixedTabTarget,
    composer,
    composerLog,
    sidebarThreads,
    sidebarActions,
    sidebarActionCalls,
    sidebarPullRequests,
    providers,
    codeTheme,
  };

  const releaseComposerOwnership = (): void => {
    if (!composerOwnership.active) return;
    composerOwnership.active = false;
    composerLog.textEffect = null;
    composerLog.inputLocked = false;
  };
  const renderSlotTree = (ui: ReactNode): ReactElement => (
    <SlotEnvContext.Provider value={env}>
      <SlotLifecycleGuard onUnmount={releaseComposerOwnership}>
        {ui}
      </SlotLifecycleGuard>
    </SlotEnvContext.Provider>
  );
  const Component = registration.component;
  const element = renderSlotTree(<Component {...props} />);
  const result = render(element);

  const rerenderSlot = (ui: ReactNode): void => {
    result.rerender(renderSlotTree(ui));
  };
  const emitRealtime = async (
    channel: string,
    payload: unknown,
  ): Promise<void> => {
    const normalized =
      payload === undefined
        ? null
        : strictJsonRoundTrip(payload, `realtime "${channel}" payload`);
    const listeners = realtimeHandlers.get(channel);
    await act(async () => {
      for (const listener of [...(listeners ?? [])]) {
        listener(normalized);
      }
    });
  };
  const setRealtimeConnectionState = async (
    state: PluginRealtimeConnectionState,
  ): Promise<void> => {
    await act(async () => realtimeConnection.setState(state));
  };
  const setComposerText = async (text: string): Promise<void> => {
    await act(async () => commitComposerText(text));
  };
  const setComposerScope = async (
    scope: PluginComposerScope,
  ): Promise<void> => {
    await act(async () => {
      composerScope = scope;
      notifyComposerListeners();
    });
  };
  const unmountSlot = (): void => {
    if (!composerOwnership.active) return;
    result.unmount();
  };

  return {
    ...result,
    rerender: rerenderSlot,
    unmount: unmountSlot,
    rpcCalls,
    emitRealtime,
    setRealtimeConnectionState,
    setComposerText,
    setComposerScope,
    navigateCalls,
    experimental_fixedTabOpenCalls,
    sidebarActionCalls,
    composer: composerLog,
    behavior: {
      emitRealtime,
      setRealtimeConnectionState,
      setComposerText,
      setComposerScope,
    },
    inspection: {
      rpcCalls,
      navigateCalls,
      experimental_fixedTabOpenCalls,
      sidebarActionCalls,
      composer: composerLog,
    },
    lifecycle: { rerender: rerenderSlot, unmount: unmountSlot },
  };
}
