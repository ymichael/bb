import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import type {
  BbDesktopBrowserApi,
  BbDesktopBrowserControl,
  BbDesktopBrowserFindInPageRequest,
  BbDesktopBrowserState,
  BbDesktopBrowserViewportBounds,
  BbDesktopBrowserViewBounds,
} from "@bb/desktop-contract";
import {
  BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH,
  clampBbDesktopBrowserViewBounds,
} from "@bb/desktop-contract";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { getBbDesktopInfo, getDesktopBrowserApi } from "@/lib/bb-desktop";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  getBrowserUrlSecurity,
  getBrowserUrlHost,
  resolveBrowserAddressInput,
} from "@/lib/browser-url";
import { useBrowserHistory } from "@/lib/browser-history";
import { BROWSER_VIEW_BOUNDS_SYNC_EVENT } from "@/lib/browser-view-bounds-sync";
import { useIsBrowserDimmingModalOpen } from "@/hooks/useBrowserDimmingModal";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { BrowserFindBar, type BrowserFindMatches } from "./BrowserFindBar";
import { BrowserNewTabScreen } from "./BrowserNewTabScreen";
import {
  registerBrowserView,
  type BrowserViewVisibilityCoordinator,
} from "./browserViewVisibilityCoordinator";
import { SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS } from "./panelChromeClasses";
import type { UpdateBrowserTabArgs } from "./useThreadFileTabs";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { isLocalOnlyUrl } from "@/lib/loopback-hostname";

interface BrowserTabContentProps {
  tabId: string;
  existingOnly?: true;
  initialUrl: string;
  addressFocusRequest: BrowserAddressFocusRequest | null;
  onAddressFocusRequestConsumed?: (request: BrowserAddressFocusRequest) => void;
  canShowNativeBrowserView: boolean;
  canHandleBrowserCommands?: boolean;
  onNativeFocus?: () => void;
  visibilityCoordinator: BrowserViewVisibilityCoordinator | null;
  environmentId: string | null;
  threadId: string;
  onUpdate: (args: UpdateBrowserTabArgs) => void;
}

export interface BrowserAddressFocusRequest {
  requestId: number;
  tabId: string;
}

interface BrowserChromeProps {
  addressDraft: string;
  isEditing: boolean;
  state: BbDesktopBrowserState | null;
  currentUrl: string;
  addressInputRef: RefObject<HTMLInputElement | null>;
  onAddressChange: (value: string) => void;
  onAddressFocus: () => void;
  onAddressBlur: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
  onForward: () => void;
  onReloadOrStop: () => void;
  onOpenExternal: () => void;
  locationShortcut: AppShortcutPresentation | null;
  reloadShortcut: AppShortcutPresentation | null;
}

interface NavButtonProps {
  icon: "ChevronLeft" | "ChevronRight" | "RotateCcw" | "X" | "ExternalLink";
  label: string;
  disabled?: boolean;
  onClick: () => void;
  shortcut?: AppShortcutPresentation | null;
}

interface BrowserViewBoundsFromElementArgs {
  element: HTMLElement;
}

interface BrowserViewBoundsEqualArgs {
  a: BbDesktopBrowserViewBounds;
  b: BbDesktopBrowserViewBounds;
}

interface SyncBrowserViewPlacementArgs {
  force: boolean;
}

interface BrowserViewAttachIdentity {
  environmentId: string | null;
  tabId: string;
  threadId: string;
}

interface BrowserPageLoadErrorProps {
  errorText: string;
  onOpenExternal: () => void;
  onRetry: () => void;
  url: string;
}

const EMPTY_BROWSER_VIEW_BOUNDS: BbDesktopBrowserViewBounds = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};

function roundedBoundsFromRect(rect: DOMRect): BbDesktopBrowserViewBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function browserViewportBounds(): BbDesktopBrowserViewportBounds {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function browserViewBoundsFromElement(
  args: BrowserViewBoundsFromElementArgs,
): BbDesktopBrowserViewBounds {
  return clampBbDesktopBrowserViewBounds({
    bounds: roundedBoundsFromRect(args.element.getBoundingClientRect()),
    viewport: browserViewportBounds(),
  });
}

function browserViewBoundsEqual(args: BrowserViewBoundsEqualArgs): boolean {
  return (
    args.a.x === args.b.x &&
    args.a.y === args.b.y &&
    args.a.width === args.b.width &&
    args.a.height === args.b.height
  );
}

function browserPageLoadErrorTitle(args: {
  errorText: string;
  url: string;
}): string {
  if (isLocalOnlyUrl(args.url)) {
    return "Server not reachable";
  }
  if (args.errorText.includes("ERR_BLOCKED_BY_CLIENT")) {
    return "Page blocked";
  }
  return "Page unavailable";
}

function NavButton({
  icon,
  label,
  disabled,
  onClick,
  shortcut,
}: NavButtonProps) {
  const accessibleLabel = shortcut ? `${label} (${shortcut.label})` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={accessibleLabel}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      className={cn(
        "flex shrink-0 items-center justify-center transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
        CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
      )}
    >
      <Icon name={icon} aria-hidden />
    </button>
  );
}

function BrowserChrome({
  addressDraft,
  isEditing,
  state,
  currentUrl,
  addressInputRef,
  onAddressChange,
  onAddressFocus,
  onAddressBlur,
  onSubmit,
  onBack,
  onForward,
  onReloadOrStop,
  onOpenExternal,
  locationShortcut,
  reloadShortcut,
}: BrowserChromeProps) {
  const isLoading = state?.isLoading ?? false;
  const security = getBrowserUrlSecurity(currentUrl);
  const addressValue = isEditing ? addressDraft : currentUrl;
  return (
    <div
      data-testid="browser-tab-nav-bar"
      data-state="expanded"
      role="region"
      aria-label="Browser navigation"
      tabIndex={-1}
      className={cn(
        "relative h-11 shrink-0 overflow-hidden focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring max-md:pointer-coarse:h-[52px]",
        SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS,
      )}
    >
      <div
        data-testid="browser-tab-nav-controls"
        className={cn(
          "absolute inset-x-0 top-0 flex h-11 translate-y-0 items-center gap-1 py-1.5 pl-2 pr-4 opacity-100 max-md:pointer-coarse:h-[52px]",
        )}
      >
        <NavButton
          icon="ChevronLeft"
          label="Go back"
          disabled={!(state?.canGoBack ?? false)}
          onClick={onBack}
        />
        <NavButton
          icon="ChevronRight"
          label="Go forward"
          disabled={!(state?.canGoForward ?? false)}
          onClick={onForward}
        />
        <NavButton
          icon={isLoading ? "X" : "RotateCcw"}
          label={isLoading ? "Stop loading" : "Reload"}
          shortcut={isLoading ? null : reloadShortcut}
          onClick={onReloadOrStop}
        />
        <form onSubmit={onSubmit} className="min-w-0 flex-1">
          <div className="flex h-8 items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 max-md:pointer-coarse:h-10">
            {security === "secure" ? (
              <Icon
                name="Lock"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  "text-success",
                )}
                aria-label="Secure connection"
              />
            ) : security === "insecure" ? (
              <Icon
                name="AlertTriangle"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  "text-warning",
                )}
                aria-label="Connection not secure"
              />
            ) : (
              <Icon
                name="Search"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  "text-muted-foreground",
                )}
                aria-hidden
              />
            )}
            <input
              ref={addressInputRef}
              type="text"
              value={addressValue}
              onChange={(event) => onAddressChange(event.target.value)}
              onFocus={onAddressFocus}
              onBlur={onAddressBlur}
              placeholder="Enter a URL"
              aria-label={
                locationShortcut
                  ? `Address and search bar (${locationShortcut.label})`
                  : "Address and search bar"
              }
              aria-keyshortcuts={locationShortcut?.ariaKeyshortcuts}
              autoComplete="off"
              spellCheck={false}
              className={cn(
                "min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground",
                COARSE_POINTER_TEXT_SM_CLASS,
              )}
            />
          </div>
        </form>
        <NavButton
          icon="ExternalLink"
          label="Open in external browser"
          disabled={currentUrl.length === 0}
          onClick={onOpenExternal}
        />
        {isLoading ? (
          <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
            <span className="block h-full w-1/3 animate-pulse bg-ring/70 motion-reduce:animate-none" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function BrowserUnavailable() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
        <Icon name="Globe" className="size-6" aria-hidden />
      </span>
      <div className="text-sm font-medium text-foreground">
        Browser tabs need the desktop app
      </div>
      <p
        className={cn(
          "max-w-xs text-muted-foreground",
          COARSE_POINTER_TEXT_SM_CLASS,
        )}
      >
        The in-app web browser runs in the bb desktop app. Open this thread
        there to browse the web.
      </p>
    </div>
  );
}

function BrowserPageLoadError({
  errorText,
  onOpenExternal,
  onRetry,
  url,
}: BrowserPageLoadErrorProps) {
  const host = getBrowserUrlHost(url);
  const title = browserPageLoadErrorTitle({ errorText, url });
  const message = isLocalOnlyUrl(url)
    ? `The browser could not reach ${host || "this local server"}. Start the server, then reload.`
    : "The browser could not load this page. Try reloading or opening it externally.";

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex w-full max-w-sm flex-col items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-lg border border-border bg-surface-recessed text-muted-foreground">
          <Icon name="Globe" className="size-6" aria-hidden />
        </span>
        <div>
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p
            className={cn(
              "mt-1 text-muted-foreground",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
          >
            {message}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-state-hover"
          >
            <Icon name="RotateCcw" className="size-3.5" aria-hidden />
            Reload
          </button>
          <button
            type="button"
            onClick={onOpenExternal}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
            Open externally
          </button>
        </div>
        <p className="max-w-full truncate pt-1 font-mono text-[11px] text-subtle-foreground">
          {errorText}
        </p>
      </div>
    </div>
  );
}

export function BrowserTabContent({
  tabId,
  existingOnly,
  initialUrl,
  addressFocusRequest,
  onAddressFocusRequestConsumed,
  canShowNativeBrowserView,
  canHandleBrowserCommands = canShowNativeBrowserView,
  onNativeFocus,
  visibilityCoordinator,
  environmentId,
  threadId,
  onUpdate,
}: BrowserTabContentProps) {
  const locationShortcut = useAppCommandShortcut("browser.focusLocation");
  const reloadShortcut = useAppCommandShortcut("browser.reload");
  const findShortcut = useAppCommandShortcut("browser.find");
  const desktopBrowser = useMemo<BbDesktopBrowserApi | null>(
    () => getDesktopBrowserApi(),
    [],
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const isPointerCoarse = usePointerCoarse();
  const {
    entries: recent,
    recordVisit,
    clear: clearRecent,
  } = useBrowserHistory(threadId);

  const [state, setState] = useState<BbDesktopBrowserState | null>(null);
  const [control, setControl] = useState<BbDesktopBrowserControl | null>(null);
  useEffect(() => {
    let current = true;
    let receivedEvent = false;
    setControl(null);
    const accept = (next: {
      tabId: string;
      threadId: string;
      control: BbDesktopBrowserControl | null;
    }) => {
      if (current && next.tabId === tabId && next.threadId === threadId)
        setControl(next.control);
    };
    const unsubscribe = desktopBrowser?.onControl?.((next) => {
      if (next.tabId !== tabId || next.threadId !== threadId) return;
      receivedEvent = true;
      accept(next);
    });
    void desktopBrowser
      ?.getControl?.(tabId)
      .then((next) => {
        if (next !== null && !receivedEvent) accept(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [desktopBrowser, tabId, threadId]);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [addressDraft, setAddressDraft] = useState(initialUrl);
  const [isEditing, setIsEditing] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const isFindOpenRef = useRef(false);
  isFindOpenRef.current = isFindOpen;
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<BrowserFindMatches | null>(
    null,
  );
  const [resizeSnapshotUrl, setResizeSnapshotUrl] = useState<string | null>(
    null,
  );

  const onUpdateRef = useRef(onUpdate);
  const recordVisitRef = useRef(recordVisit);
  onUpdateRef.current = onUpdate;
  recordVisitRef.current = recordVisit;
  const initialUrlRef = useRef(initialUrl);
  const [attachedBrowserViewIdentity, setAttachedBrowserViewIdentity] =
    useState<BrowserViewAttachIdentity | null>(null);
  const isBrowserViewAttached =
    attachedBrowserViewIdentity !== null &&
    attachedBrowserViewIdentity.environmentId === environmentId &&
    attachedBrowserViewIdentity.tabId === tabId &&
    attachedBrowserViewIdentity.threadId === threadId;

  const hasPage = currentUrl.length > 0;
  const supportsNativePaneFocus =
    desktopBrowser?.focus !== undefined &&
    desktopBrowser.onFocus !== undefined &&
    desktopBrowser.setVisibleWithoutFocus !== undefined;
  const pageLoadErrorText = state?.errorText ?? null;
  const hasPageLoadError = pageLoadErrorText !== null && hasPage;
  const isBrowserDimmingModalOpen = useIsBrowserDimmingModalOpen();
  const lastSentBoundsRef = useRef<BbDesktopBrowserViewBounds | null>(null);

  const readBounds = useCallback(() => {
    const element = contentRef.current;
    if (element === null) {
      return null;
    }
    return browserViewBoundsFromElement({ element });
  }, []);

  const sendBounds = useCallback(
    (bounds: BbDesktopBrowserViewBounds) => {
      if (desktopBrowser === null) {
        return;
      }
      lastSentBoundsRef.current = bounds;
      desktopBrowser.setBounds({ tabId, bounds });
    },
    [desktopBrowser, tabId],
  );

  const syncPlacement = useCallback(
    ({ force }: SyncBrowserViewPlacementArgs) => {
      const bounds = readBounds();
      if (bounds === null) {
        return;
      }
      const lastSentBounds = lastSentBoundsRef.current;
      if (
        !force &&
        lastSentBounds !== null &&
        browserViewBoundsEqual({ a: lastSentBounds, b: bounds })
      ) {
        return;
      }
      sendBounds(bounds);
    },
    [readBounds, sendBounds],
  );

  const syncBounds = useCallback(() => {
    syncPlacement({ force: true });
  }, [syncPlacement]);

  const syncBoundsIfChanged = useCallback(() => {
    syncPlacement({ force: false });
  }, [syncPlacement]);

  const syncInitialBounds = useCallback(() => {
    const bounds = readBounds();
    lastSentBoundsRef.current = bounds;
    return bounds ?? EMPTY_BROWSER_VIEW_BOUNDS;
  }, [readBounds]);

  useEffect(() => {
    if (desktopBrowser === null) {
      return;
    }
    const initialBounds = syncInitialBounds();
    const mountUrl = initialUrlRef.current;
    registerBrowserView({ environmentId, tabId, threadId });
    desktopBrowser.attach({
      tabId,
      threadId,
      ...(existingOnly === true ? { existingOnly } : {}),
      url: mountUrl,
      bounds: initialBounds,
      visible: false,
    });
    setAttachedBrowserViewIdentity({ environmentId, tabId, threadId });

    let lastSeenState: BbDesktopBrowserState | null = null;
    const unsubscribe = desktopBrowser.onState((nextState) => {
      if (nextState.tabId !== tabId) {
        return;
      }
      if (
        lastSeenState !== null &&
        (lastSeenState.url !== nextState.url ||
          (nextState.isLoading && !lastSeenState.isLoading))
      ) {
        setFindMatches(null);
      }
      lastSeenState = nextState;
      setState(nextState);
      setCurrentUrl(nextState.url);
      onUpdateRef.current({
        tabId,
        url: nextState.url,
        title: nextState.title,
      });
      if (!nextState.isLoading && nextState.url.length > 0) {
        recordVisitRef.current({
          url: nextState.url,
          title: nextState.title,
        });
      }
    });

    const unsubscribeSnapshot = desktopBrowser.onSnapshot?.((snapshot) => {
      if (snapshot.tabId !== tabId) {
        return;
      }
      setResizeSnapshotUrl(snapshot.dataUrl);
    });

    const unsubscribeFindResult = desktopBrowser.onFindResult?.((result) => {
      if (result.tabId !== tabId) {
        return;
      }
      setFindMatches({
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });
    });

    return () => {
      unsubscribe();
      unsubscribeSnapshot?.();
      unsubscribeFindResult?.();
      if (isFindOpenRef.current) {
        desktopBrowser.stopFindInPage?.({ tabId, action: "clearSelection" });
      }
      visibilityCoordinator?.release(tabId);
    };
  }, [
    desktopBrowser,
    environmentId,
    syncInitialBounds,
    visibilityCoordinator,
    tabId,
    threadId,
    existingOnly,
  ]);

  useEffect(() => {
    const element = contentRef.current;
    if (element === null || desktopBrowser === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      syncBoundsIfChanged();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [desktopBrowser, syncBoundsIfChanged]);

  useEffect(() => {
    if (desktopBrowser === null) {
      return;
    }

    window.addEventListener(
      BROWSER_VIEW_BOUNDS_SYNC_EVENT,
      syncBoundsIfChanged,
    );
    window.addEventListener("resize", syncBoundsIfChanged);

    return () => {
      window.removeEventListener(
        BROWSER_VIEW_BOUNDS_SYNC_EVENT,
        syncBoundsIfChanged,
      );
      window.removeEventListener("resize", syncBoundsIfChanged);
    };
  }, [desktopBrowser, syncBoundsIfChanged]);

  const isViewVisible =
    canShowNativeBrowserView &&
    (canHandleBrowserCommands || supportsNativePaneFocus) &&
    hasPage &&
    !hasPageLoadError &&
    isBrowserViewAttached &&
    !isBrowserDimmingModalOpen;
  useLayoutEffect(() => {
    if (visibilityCoordinator === null) {
      return;
    }
    if (isViewVisible) {
      visibilityCoordinator.show(tabId, syncBounds, {
        focus: canHandleBrowserCommands,
      });
      return () => {
        visibilityCoordinator.hide(tabId);
      };
    }
    visibilityCoordinator.hide(tabId);
  }, [
    canHandleBrowserCommands,
    visibilityCoordinator,
    tabId,
    isViewVisible,
    syncBounds,
  ]);

  useEffect(() => {
    if (desktopBrowser?.onFocus === undefined || onNativeFocus === undefined) {
      return;
    }
    return desktopBrowser.onFocus((focusedTabId) => {
      if (focusedTabId === tabId) onNativeFocus();
    });
  }, [desktopBrowser, onNativeFocus, tabId]);

  useEffect(() => {
    if (!isViewVisible || !canHandleBrowserCommands) return;
    desktopBrowser?.focus?.(tabId);
  }, [canHandleBrowserCommands, desktopBrowser, isViewVisible, tabId]);

  useEffect(() => {
    if (addressFocusRequest === null) {
      return;
    }
    if (addressFocusRequest.tabId !== tabId) {
      return;
    }
    if (isPointerCoarse) {
      onAddressFocusRequestConsumed?.(addressFocusRequest);
      return;
    }

    setAddressDraft(currentUrl);
    setIsEditing(true);
    addressInputRef.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      addressInputRef.current?.focus({ preventScroll: true });
      onAddressFocusRequestConsumed?.(addressFocusRequest);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    addressFocusRequest,
    currentUrl,
    isPointerCoarse,
    onAddressFocusRequestConsumed,
    tabId,
  ]);

  const navigateToInput = useCallback(
    (rawInput: string) => {
      const url = resolveBrowserAddressInput(rawInput);
      if (url === null) {
        return;
      }
      setCurrentUrl(url);
      setIsEditing(false);
      desktopBrowser?.navigate({ tabId, url });
    },
    [desktopBrowser, tabId],
  );

  const handleAddressSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      navigateToInput(addressDraft);
    },
    [addressDraft, navigateToInput],
  );

  const handleAddressFocus = useCallback(() => {
    setAddressDraft(currentUrl);
    setIsEditing(true);
  }, [currentUrl]);

  const handleReloadOrStop = useCallback(() => {
    if (state?.isLoading ?? false) {
      desktopBrowser?.stop(tabId);
      return;
    }
    desktopBrowser?.reload(tabId);
  }, [desktopBrowser, state?.isLoading, tabId]);

  const handleFocusLocation = useCallback((): boolean => {
    if (!canHandleBrowserCommands || desktopBrowser === null) return false;
    setAddressDraft(currentUrl);
    setIsEditing(true);
    addressInputRef.current?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      addressInputRef.current?.focus({ preventScroll: true });
      addressInputRef.current?.select();
    });
    return true;
  }, [canHandleBrowserCommands, currentUrl, desktopBrowser]);

  useAppCommandHandler("browser.focusLocation", handleFocusLocation, 100);

  const canFindInPage =
    canShowNativeBrowserView &&
    desktopBrowser !== null &&
    desktopBrowser.findInPage !== undefined &&
    hasPage;

  const runFind = useCallback(
    (args: Omit<BbDesktopBrowserFindInPageRequest, "tabId">) => {
      desktopBrowser?.findInPage?.({ tabId, ...args });
    },
    [desktopBrowser, tabId],
  );

  const clearFind = useCallback(() => {
    desktopBrowser?.stopFindInPage?.({ tabId, action: "clearSelection" });
    setFindMatches(null);
  }, [desktopBrowser, tabId]);

  const focusFindInput = useCallback(() => {
    findInputRef.current?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus({ preventScroll: true });
      findInputRef.current?.select();
    });
  }, []);

  const handleFindQueryChange = useCallback(
    (rawQuery: string) => {
      const query = rawQuery.slice(0, BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH);
      setFindQuery(query);
      if (query.length === 0) {
        clearFind();
        return;
      }
      runFind({ text: query, forward: true, newSession: true });
    },
    [clearFind, runFind],
  );

  const handleFindNext = useCallback(() => {
    if (findQuery.length === 0) return;
    runFind({ text: findQuery, forward: true, newSession: false });
  }, [findQuery, runFind]);

  const handleFindPrevious = useCallback(() => {
    if (findQuery.length === 0) return;
    runFind({ text: findQuery, forward: false, newSession: false });
  }, [findQuery, runFind]);

  const handleCloseFind = useCallback(() => {
    setIsFindOpen(false);
    clearFind();
  }, [clearFind]);

  const handleOpenFind = useCallback((): boolean => {
    if (!canFindInPage) return false;
    setIsFindOpen(true);
    if (findQuery.length > 0) {
      runFind({ text: findQuery, forward: true, newSession: true });
    }
    focusFindInput();
    return true;
  }, [canFindInPage, findQuery, focusFindInput, runFind]);

  useAppCommandHandler("browser.find", handleOpenFind, 100);

  useEffect(() => {
    if (isFindOpen && !canFindInPage) {
      setIsFindOpen(false);
      clearFind();
    }
  }, [canFindInPage, clearFind, isFindOpen]);
  useAppCommandHandler(
    "browser.reload",
    () => {
      if (!canHandleBrowserCommands || desktopBrowser === null || !hasPage) {
        return false;
      }
      desktopBrowser.reload(tabId);
      return true;
    },
    100,
  );

  const handleOpenExternal = useCallback(() => {
    getBbDesktopInfo()?.openExternalUrl(currentUrl);
  }, [currentUrl]);

  if (desktopBrowser === null) {
    return <BrowserUnavailable />;
  }

  return (
    <div data-app-browser className="flex h-full min-h-0 flex-col">
      <BrowserChrome
        addressDraft={addressDraft}
        isEditing={isEditing}
        state={state}
        currentUrl={currentUrl}
        addressInputRef={addressInputRef}
        onAddressChange={setAddressDraft}
        onAddressFocus={handleAddressFocus}
        onAddressBlur={() => setIsEditing(false)}
        onSubmit={handleAddressSubmit}
        onBack={() => {
          desktopBrowser.goBack(tabId);
        }}
        onForward={() => {
          desktopBrowser.goForward(tabId);
        }}
        onReloadOrStop={handleReloadOrStop}
        onOpenExternal={handleOpenExternal}
        locationShortcut={locationShortcut}
        reloadShortcut={reloadShortcut}
      />
      {control !== null ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-recessed px-3 py-2 text-xs"
        >
          <span className="min-w-0 flex-1 truncate">
            {control.controllerLabel} is controlling this tab
          </span>
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-state-hover"
            onClick={() => desktopBrowser.releaseControl?.(tabId)}
          >
            Stop
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-state-hover"
            onClick={() => {
              desktopBrowser.releaseControl?.(tabId);
              desktopBrowser.focus?.(tabId);
            }}
          >
            Take over
          </button>
        </div>
      ) : null}
      {isFindOpen ? (
        <BrowserFindBar
          inputRef={findInputRef}
          query={findQuery}
          matches={findMatches}
          onQueryChange={handleFindQueryChange}
          onFindNext={handleFindNext}
          onFindPrevious={handleFindPrevious}
          onClose={handleCloseFind}
          shortcut={findShortcut}
        />
      ) : null}
      <div ref={contentRef} className="relative min-h-0 flex-1">
        {hasPageLoadError ? (
          <BrowserPageLoadError
            errorText={pageLoadErrorText}
            onOpenExternal={handleOpenExternal}
            onRetry={handleReloadOrStop}
            url={currentUrl}
          />
        ) : hasPage && !isBrowserDimmingModalOpen ? null : (
          <BrowserNewTabScreen
            onNavigateInput={navigateToInput}
            recent={recent}
            onClearRecent={clearRecent}
          />
        )}
        {hasPage && resizeSnapshotUrl !== null ? (
          <img
            src={resizeSnapshotUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 size-full"
          />
        ) : null}
      </div>
    </div>
  );
}
