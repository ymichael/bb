import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import "@xterm/xterm/css/xterm.css";
import type {
  IDisposable,
  ITerminalAddon,
  ITheme,
  Terminal as XTermTerminal,
} from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import type {
  TerminalServerMessage,
  TerminalSession,
} from "@bb/server-contract";
import { useAppThemeEpoch } from "@/hooks/useAppTheme";
import { usePreferredTheme } from "@/hooks/useTheme";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { useAppNavigationHost } from "@/lib/app-navigation-host";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  anchorPointFromMouseEvent,
  type MessageProseSelection,
} from "@/components/thread/timeline/SelectableMessageProse.js";
import { TimelineSelectionMenu } from "@/components/thread/timeline/TimelineSelectionMenu.js";
import { buildTerminalWebSocketUrl } from "./terminal-websocket-url";
import { TerminalWebSocketTransport } from "@bb/client-core";
import { TerminalLinkOpenDialog } from "./TerminalLinkOpenDialog";
import {
  createTerminalOsc8LinkHandler,
  requestTerminalLinkOpen,
  type TerminalLinkTarget,
} from "./terminal-links";

export const TERMINAL_FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
export const TERMINAL_UNICODE_VERSION = "11";
export const TERMINAL_ALLOW_PROPOSED_API = true;
const TERMINAL_SELECTION_DRAG_DIRECTION_THRESHOLD_PX = 4;
const TERMINAL_TOUCH_FOCUS_MAX_DURATION_MS = 700;
const TERMINAL_TOUCH_FOCUS_MOVEMENT_THRESHOLD_PX = 10;

type TerminalFitScheduler = () => void;

interface ShouldFocusTerminalAfterAsyncMountArgs {
  currentFocusIsAvailable: boolean;
  hasExplicitFocusRequest: boolean;
  focusMovedDuringMount: boolean;
  isPanelOpen: boolean;
}

export function shouldFocusTerminalAfterAsyncMount({
  currentFocusIsAvailable,
  hasExplicitFocusRequest,
  focusMovedDuringMount,
  isPanelOpen,
}: ShouldFocusTerminalAfterAsyncMountArgs): boolean {
  if (!isPanelOpen) {
    return false;
  }
  if (focusMovedDuringMount && currentFocusIsAvailable) {
    return false;
  }
  return hasExplicitFocusRequest || !currentFocusIsAvailable;
}

interface WebglRendererAddon extends ITerminalAddon {
  onContextLoss: (listener: () => void) => IDisposable;
}

type TerminalAddonLoader = Pick<XTermTerminal, "loadAddon">;
interface TerminalWebglAddonModule {
  WebglAddon: new () => WebglRendererAddon;
}
type TerminalWebglAddonImporter = () => Promise<TerminalWebglAddonModule>;

export async function loadOptionalTerminalWebglAddon(
  importAddon: TerminalWebglAddonImporter,
): Promise<TerminalWebglAddonModule | null> {
  try {
    return await importAddon();
  } catch {
    return null;
  }
}

export function loadTerminalWebglRenderer(
  terminal: TerminalAddonLoader,
  createAddon: () => WebglRendererAddon,
): boolean {
  let addon: WebglRendererAddon | null = null;
  let contextLossDisposable: IDisposable | null = null;
  try {
    addon = createAddon();
    contextLossDisposable = addon.onContextLoss(() => {
      contextLossDisposable?.dispose();
      addon?.dispose();
    });
    terminal.loadAddon(addon);
    return true;
  } catch {
    contextLossDisposable?.dispose();
    addon?.dispose();
    return false;
  }
}

interface TerminalSelectionAnchorPoint {
  x: number;
  y: number;
}

interface TerminalTouchPoint extends TerminalSelectionAnchorPoint {
  identifier: number;
}

interface TerminalTouchFocusGesture {
  identifier: number;
  maximumMovementPx: number;
  startedAt: number;
  startPoint: TerminalSelectionAnchorPoint;
}

interface FocusTerminalFromTouchReleaseArgs {
  changedTouches: readonly TerminalTouchPoint[];
  focus: () => void;
  gesture: TerminalTouchFocusGesture | null;
  releasedAt: number;
  remainingTouchCount: number;
}

function terminalTouchMovement(
  startPoint: TerminalSelectionAnchorPoint,
  currentPoint: TerminalSelectionAnchorPoint,
): number {
  return Math.hypot(
    currentPoint.x - startPoint.x,
    currentPoint.y - startPoint.y,
  );
}

export function startTerminalTouchFocusGesture(
  touches: readonly TerminalTouchPoint[],
  startedAt: number,
): TerminalTouchFocusGesture | null {
  const touch = touches.length === 1 ? touches[0] : undefined;
  if (touch === undefined) {
    return null;
  }
  return {
    identifier: touch.identifier,
    maximumMovementPx: 0,
    startedAt,
    startPoint: { x: touch.x, y: touch.y },
  };
}

export function updateTerminalTouchFocusGesture(
  gesture: TerminalTouchFocusGesture | null,
  touches: readonly TerminalTouchPoint[],
): TerminalTouchFocusGesture | null {
  const touch = touches.length === 1 ? touches[0] : undefined;
  if (
    gesture === null ||
    touch === undefined ||
    touch.identifier !== gesture.identifier
  ) {
    return null;
  }
  return {
    ...gesture,
    maximumMovementPx: Math.max(
      gesture.maximumMovementPx,
      terminalTouchMovement(gesture.startPoint, touch),
    ),
  };
}

export function focusTerminalFromTouchRelease({
  changedTouches,
  focus,
  gesture,
  releasedAt,
  remainingTouchCount,
}: FocusTerminalFromTouchReleaseArgs): boolean {
  if (remainingTouchCount !== 0) {
    return false;
  }
  const completedGesture = updateTerminalTouchFocusGesture(
    gesture,
    changedTouches,
  );
  if (completedGesture === null) {
    return false;
  }
  const duration = releasedAt - completedGesture.startedAt;
  if (
    duration < 0 ||
    duration >= TERMINAL_TOUCH_FOCUS_MAX_DURATION_MS ||
    completedGesture.maximumMovementPx >
      TERMINAL_TOUCH_FOCUS_MOVEMENT_THRESHOLD_PX
  ) {
    return false;
  }
  focus();
  return true;
}

function terminalTouchPoints(
  touches: ReactTouchEvent<HTMLDivElement>["touches"],
): TerminalTouchPoint[] {
  return Array.from(touches, (touch) => ({
    identifier: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
  }));
}

interface TerminalSelectionAnchor {
  point: TerminalSelectionAnchorPoint;
  side: "top" | "bottom";
}

interface HasVisibleTerminalSizeArgs {
  containerElement: HTMLElement;
  entries?: readonly ResizeObserverEntry[];
}

function readResolvedCssColor(
  probe: HTMLElement,
  varName: string,
): string | undefined {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  if (!raw) {
    return undefined;
  }
  probe.style.color = raw;
  return getComputedStyle(probe).color;
}

type TerminalCssColorReader = (name: string) => string | undefined;

export function buildTerminalThemeFromCssColors(
  get: TerminalCssColorReader,
): ITheme {
  return {
    background: get("--sidebar"),
    foreground: get("--foreground"),
    cursor: get("--foreground"),
    cursorAccent: get("--sidebar"),
    selectionBackground: get("--muted"),
    black: get("--ansi-0"),
    red: get("--ansi-1"),
    green: get("--ansi-2"),
    yellow: get("--ansi-3"),
    blue: get("--ansi-4"),
    magenta: get("--ansi-5"),
    cyan: get("--ansi-6"),
    white: get("--ansi-7"),
    brightBlack: get("--ansi-8"),
    brightRed: get("--ansi-9"),
    brightGreen: get("--ansi-10"),
    brightYellow: get("--ansi-11"),
    brightBlue: get("--ansi-12"),
    brightMagenta: get("--ansi-13"),
    brightCyan: get("--ansi-14"),
    brightWhite: get("--ansi-15"),
  };
}

function buildTerminalTheme(): ITheme {
  if (typeof document === "undefined") {
    return {};
  }
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const get = (name: string) => readResolvedCssColor(probe, name);
  const theme = buildTerminalThemeFromCssColors(get);
  probe.remove();
  return theme;
}

interface ThreadTerminalViewProps {
  autoFocus: boolean;
  isPanelOpen: boolean;
  onAutoFocusHandled?: () => void;
  onOpenLink?: MarkdownPreviewLinkHandler;
  onSelectionAddToChat?: (text: string) => void;
  onSessionChange?: (session: TerminalSession) => void;
  onTitleChange?: TerminalTitleChangeHandler;
  onUserInput?: () => void;
  session: TerminalSession;
}

type TerminalTitleChangeHandler = (title: string) => void;

interface WriteTerminalStatusArgs {
  terminal: XTermTerminal;
  text: string;
}

interface WriteTerminalSessionStatusNoticeArgs {
  lastNotice: TerminalSessionStatusNoticeRef;
  session: TerminalSession;
  terminal: XTermTerminal;
}

interface TerminalOutputWriteArgs {
  data: string | Uint8Array;
  isReplay: boolean;
  replayWriteState: TerminalReplayWriteState;
  terminal: XTermTerminal;
}

interface ForwardTerminalDataArgs {
  data: string;
  onInput: (dataBase64: string) => void;
  onUserInput?: () => void;
  replayWriteState: TerminalReplayWriteState;
  sessionStatus: TerminalSession["status"];
}

interface OpenTerminalWebLinkArgs {
  onOpenLink: MarkdownPreviewLinkHandler;
  uri: string;
}

interface TerminalContextMenuState {
  link: TerminalLinkTarget | null;
  selectionText: string;
}

interface CaptureTerminalContextMenuStateArgs {
  link: TerminalLinkTarget | null;
  terminal: Pick<XTermTerminal, "getSelection"> | null;
}

interface TerminalReplayWriteState {
  suppressedWriteCount: number;
}

type TerminalSessionStatusNotice = "disconnected" | "exited";
type TerminalSessionStatusNoticeRef = {
  current: TerminalSessionStatusNotice | null;
};

interface HandleTerminalServerMessageArgs {
  message: TerminalServerMessage;
  onSessionChange?: (session: TerminalSession) => void;
  replayNextSeq: number | null;
  replayWriteState: TerminalReplayWriteState;
  setReplayNextSeq: (nextSeq: number) => void;
  terminal: XTermTerminal;
}

function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function encodeTerminalInputChunks(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += TERMINAL_DATA_MAX_BYTES
  ) {
    chunks.push(
      encodeBytesBase64(
        bytes.subarray(
          offset,
          Math.min(offset + TERMINAL_DATA_MAX_BYTES, bytes.byteLength),
        ),
      ),
    );
  }
  return chunks;
}

export function forwardTerminalData({
  data,
  onInput,
  onUserInput,
  replayWriteState,
  sessionStatus,
}: ForwardTerminalDataArgs): void {
  if (
    replayWriteState.suppressedWriteCount > 0 ||
    sessionStatus !== "running"
  ) {
    return;
  }

  onUserInput?.();
  for (const dataBase64 of encodeTerminalInputChunks(data)) {
    onInput(dataBase64);
  }
}

export function decodeTerminalOutputBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hasVisibleTerminalSize({
  containerElement,
  entries,
}: HasVisibleTerminalSizeArgs): boolean {
  const entry = entries?.[0];
  const width = entry?.contentRect.width ?? containerElement.clientWidth;
  const height = entry?.contentRect.height ?? containerElement.clientHeight;
  return width > 0 && height > 0;
}

function terminalSelectionAnchorFromPointerRelease(
  startPoint: TerminalSelectionAnchorPoint | null,
  releaseEvent: Pick<MouseEvent, "clientX" | "clientY">,
): TerminalSelectionAnchor | null {
  const releasePoint = anchorPointFromMouseEvent(releaseEvent);
  if (releasePoint === null) {
    return null;
  }

  return {
    point: releasePoint,
    side:
      startPoint !== null &&
      releasePoint.y - startPoint.y >
        TERMINAL_SELECTION_DRAG_DIRECTION_THRESHOLD_PX
        ? "bottom"
        : "top",
  };
}

function buildTerminalSelection({
  anchor,
  containerElement,
  text,
}: {
  anchor: TerminalSelectionAnchor | null;
  containerElement: HTMLElement;
  text: string;
}): MessageProseSelection | null {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return null;
  }

  const selection: MessageProseSelection = {
    text: trimmedText,
    rect:
      anchor === null
        ? containerElement.getBoundingClientRect()
        : new DOMRect(anchor.point.x, anchor.point.y, 0, 0),
  };
  if (anchor !== null) {
    selection.anchorPoint = anchor.point;
    selection.anchorSide = anchor.side;
  }
  return selection;
}

function writeTerminalStatus({
  terminal,
  text,
}: WriteTerminalStatusArgs): void {
  terminal.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
}

function writeTerminalSessionStatusNotice({
  lastNotice,
  session,
  terminal,
}: WriteTerminalSessionStatusNoticeArgs): void {
  switch (session.status) {
    case "disconnected":
      if (lastNotice.current === "disconnected") {
        return;
      }
      lastNotice.current = "disconnected";
      writeTerminalStatus({ terminal, text: "Terminal disconnected" });
      return;
    case "exited":
      if (lastNotice.current === "exited") {
        return;
      }
      lastNotice.current = "exited";
      writeTerminalStatus({
        terminal,
        text:
          session.exitCode === null
            ? "Terminal exited"
            : `Terminal exited with code ${session.exitCode}`,
      });
      return;
    case "starting":
    case "running":
      lastNotice.current = null;
      return;
  }
}

function openTerminalWebLink({
  onOpenLink,
  uri,
}: OpenTerminalWebLinkArgs): void {
  if (onOpenLink({ href: uri })) {
    return;
  }
  openUrlInExternalBrowser(uri);
}

export function captureTerminalContextMenuState({
  link,
  terminal,
}: CaptureTerminalContextMenuStateArgs): TerminalContextMenuState {
  return {
    link,
    selectionText: terminal?.getSelection() ?? "",
  };
}

export function writeTerminalOutput({
  data,
  isReplay,
  replayWriteState,
  terminal,
}: TerminalOutputWriteArgs): void {
  if (!isReplay) {
    terminal.write(data);
    return;
  }

  replayWriteState.suppressedWriteCount += 1;
  terminal.write(data, () => {
    replayWriteState.suppressedWriteCount -= 1;
  });
}

function handleTerminalServerMessage({
  message,
  onSessionChange,
  replayNextSeq,
  replayWriteState,
  setReplayNextSeq,
  terminal,
}: HandleTerminalServerMessageArgs): void {
  switch (message.type) {
    case "attached":
      onSessionChange?.(message.session);
      setReplayNextSeq(message.nextSeq);
      return;
    case "pong":
      return;
    case "session-updated":
      onSessionChange?.(message.session);
      return;
    case "output":
      writeTerminalOutput({
        data: decodeTerminalOutputBytes(message.chunk.dataBase64),
        isReplay: replayNextSeq !== null && message.chunk.seq < replayNextSeq,
        replayWriteState,
        terminal,
      });
      return;
    case "error":
      writeTerminalStatus({
        terminal,
        text: `Terminal error: ${message.message}`,
      });
      return;
    case "exited":
      onSessionChange?.(message.session);
      writeTerminalStatus({
        terminal,
        text:
          message.session.exitCode === null
            ? "Terminal exited"
            : `Terminal exited with code ${message.session.exitCode}`,
      });
      return;
  }
}

export function ThreadTerminalView({
  autoFocus,
  isPanelOpen,
  onAutoFocusHandled,
  onOpenLink,
  onSelectionAddToChat,
  onSessionChange,
  onTitleChange,
  onUserInput,
  session,
}: ThreadTerminalViewProps) {
  const [activeSelection, setActiveSelection] =
    useState<MessageProseSelection | null>(null);
  const [hoveredTerminalLink, setHoveredTerminalLink] =
    useState<TerminalLinkTarget | null>(null);
  const [pendingTerminalLink, setPendingTerminalLink] =
    useState<TerminalLinkTarget | null>(null);
  const [contextMenuState, setContextMenuState] =
    useState<TerminalContextMenuState>({
      link: null,
      selectionText: "",
    });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const hoveredTerminalLinkRef = useRef<TerminalLinkTarget | null>(null);
  const pointerIsDownRef = useRef(false);
  const pointerStartPointRef = useRef<TerminalSelectionAnchorPoint | null>(
    null,
  );
  const touchFocusGestureRef = useRef<TerminalTouchFocusGesture | null>(null);
  const lastPointerReleaseAnchorRef = useRef<TerminalSelectionAnchor | null>(
    null,
  );
  const onSessionChangeRef = useRef<
    ((session: TerminalSession) => void) | undefined
  >(onSessionChange);
  const onTitleChangeRef = useRef<TerminalTitleChangeHandler | undefined>(
    onTitleChange,
  );
  const onUserInputRef = useRef<(() => void) | undefined>(onUserInput);
  const onAutoFocusHandledRef = useRef<(() => void) | undefined>(
    onAutoFocusHandled,
  );
  const autoFocusRef = useRef(autoFocus);
  const isPanelOpenRef = useRef(isPanelOpen);
  const sessionStatusRef = useRef<TerminalSession["status"]>(session.status);
  const sessionRef = useRef(session);
  const lastStatusNoticeRef = useRef<TerminalSessionStatusNotice | null>(null);
  const scheduleFitRef = useRef<TerminalFitScheduler | null>(null);
  const preferredTheme = usePreferredTheme();
  const appThemeEpoch = useAppThemeEpoch();
  const appNavigation = useAppNavigationHost();
  const handleOpenLinkByPreference = useCallback<MarkdownPreviewLinkHandler>(
    ({ href }) => appNavigation.openUrl({ url: href }),
    [appNavigation],
  );
  const effectiveOnOpenLink = onOpenLink ?? handleOpenLinkByPreference;
  const onOpenLinkRef = useRef<MarkdownPreviewLinkHandler>(effectiveOnOpenLink);

  autoFocusRef.current = autoFocus;
  isPanelOpenRef.current = isPanelOpen;
  sessionStatusRef.current = session.status;
  sessionRef.current = session;
  onAutoFocusHandledRef.current = onAutoFocusHandled;
  onOpenLinkRef.current = effectiveOnOpenLink;
  onSessionChangeRef.current = onSessionChange;
  onTitleChangeRef.current = onTitleChange;
  onUserInputRef.current = onUserInput;

  const reportTerminalSelection = useCallback(
    (anchor: TerminalSelectionAnchor | null) => {
      const terminal = terminalRef.current;
      const container = containerRef.current;
      if (!terminal || !container) {
        setActiveSelection(null);
        return;
      }
      setActiveSelection(
        buildTerminalSelection({
          anchor,
          containerElement: container,
          text: terminal.getSelection(),
        }),
      );
    },
    [],
  );

  const clearTerminalSelection = useCallback(() => {
    terminalRef.current?.clearSelection();
    setActiveSelection(null);
  }, []);

  const updateHoveredTerminalLink = useCallback(
    (target: TerminalLinkTarget | null) => {
      hoveredTerminalLinkRef.current = target;
      setHoveredTerminalLink(target);
    },
    [],
  );

  const openTerminalLink = useCallback((uri: string) => {
    openTerminalWebLink({
      onOpenLink: onOpenLinkRef.current,
      uri,
    });
  }, []);

  const confirmTerminalLinkOpen = useCallback(
    (target: TerminalLinkTarget) => {
      setPendingTerminalLink(null);
      openTerminalLink(target.uri);
    },
    [openTerminalLink],
  );

  const requestOpenTerminalLink = useCallback(
    (target: TerminalLinkTarget) => {
      requestTerminalLinkOpen({
        openLink: openTerminalLink,
        requestConfirmation: setPendingTerminalLink,
        target,
      });
    },
    [openTerminalLink],
  );

  const captureTerminalContextMenu = useCallback(() => {
    setContextMenuState(
      captureTerminalContextMenuState({
        link: hoveredTerminalLinkRef.current,
        terminal: terminalRef.current,
      }),
    );
  }, []);

  const copyTerminalContextValue = useCallback(
    (text: string, successMessage: string) => {
      void copyToClipboardWithToast(text, {
        successMessage,
        errorMessage: "Failed to copy",
      });
    },
    [],
  );

  const handleSelectionAddToChat = useCallback(
    (text: string) => {
      onSelectionAddToChat?.(text);
      clearTerminalSelection();
    },
    [clearTerminalSelection, onSelectionAddToChat],
  );

  const handleTerminalPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      pointerIsDownRef.current = true;
      pointerStartPointRef.current =
        anchorPointFromMouseEvent(event);
    },
    [],
  );

  const handleTerminalPointerRelease = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const anchor = terminalSelectionAnchorFromPointerRelease(
        pointerStartPointRef.current,
        event,
      );
      lastPointerReleaseAnchorRef.current = anchor;
      pointerIsDownRef.current = false;
      pointerStartPointRef.current = null;
      window.requestAnimationFrame(() => {
        reportTerminalSelection(anchor);
      });
    },
    [reportTerminalSelection],
  );

  const handleTerminalPointerCancel = useCallback(() => {
    pointerIsDownRef.current = false;
    pointerStartPointRef.current = null;
    window.requestAnimationFrame(() => {
      reportTerminalSelection(lastPointerReleaseAnchorRef.current);
    });
  }, [reportTerminalSelection]);

  const handleTerminalTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      touchFocusGestureRef.current = startTerminalTouchFocusGesture(
        terminalTouchPoints(event.touches),
        event.timeStamp,
      );
    },
    [],
  );

  const handleTerminalTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      touchFocusGestureRef.current = updateTerminalTouchFocusGesture(
        touchFocusGestureRef.current,
        terminalTouchPoints(event.touches),
      );
    },
    [],
  );

  const handleTerminalTouchEnd = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const gesture = touchFocusGestureRef.current;
      touchFocusGestureRef.current = null;
      focusTerminalFromTouchRelease({
        changedTouches: terminalTouchPoints(event.changedTouches),
        focus: () => terminalRef.current?.focus(),
        gesture,
        releasedAt: event.timeStamp,
        remainingTouchCount: event.touches.length,
      });
    },
    [],
  );

  const handleTerminalTouchCancel = useCallback(() => {
    touchFocusGestureRef.current = null;
  }, []);

  useEffect(() => {
    touchFocusGestureRef.current = null;
    setActiveSelection(null);
    updateHoveredTerminalLink(null);
    setPendingTerminalLink(null);
    setContextMenuState({ link: null, selectionText: "" });
  }, [session.id, updateHoveredTerminalLink]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const activeElementAtMount = document.activeElement;

    let disposed = false;
    let transport: TerminalWebSocketTransport | null = null;
    let terminal: XTermTerminal | null = null;
    let fitAddon: FitAddon | null = null;
    let replayNextSeq: number | null = null;
    const replayWriteState: TerminalReplayWriteState = {
      suppressedWriteCount: 0,
    };
    let resizeAnimationFrame: number | null = null;
    let selectionAnimationFrame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let selectionChangeDisposable: { dispose: () => void } | null = null;

    async function mountTerminal(
      containerElement: HTMLDivElement,
    ): Promise<void> {
      const requiredModulesPromise = Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
        import("@xterm/addon-unicode11"),
      ]);
      const webglAddonModulePromise = loadOptionalTerminalWebglAddon(
        () => import("@xterm/addon-webgl"),
      );
      const [
        { Terminal },
        { FitAddon: LoadedFitAddon },
        { WebLinksAddon },
        { Unicode11Addon },
      ] = await requiredModulesPromise;
      const webglAddonModule = await webglAddonModulePromise;
      if (disposed) {
        return;
      }

      const osc8LinkHandler = createTerminalOsc8LinkHandler({
        onActivate: requestOpenTerminalLink,
        onHover: (target) => {
          if (!disposed) {
            updateHoveredTerminalLink(target);
          }
        },
      });

      terminal = new Terminal({
        allowProposedApi: TERMINAL_ALLOW_PROPOSED_API,
        convertEol: true,
        cursorBlink: true,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: 12,
        linkHandler: osc8LinkHandler,
        scrollback: 10_000,
        theme: buildTerminalTheme(),
      });
      terminalRef.current = terminal;
      fitAddon = new LoadedFitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
      terminal.loadAddon(
        new WebLinksAddon(
          (event, uri) => {
            if (event.button !== 0) {
              return;
            }
            requestOpenTerminalLink({ source: "detected-url", uri });
          },
          {
            hover: (_event, uri) => {
              updateHoveredTerminalLink({ source: "detected-url", uri });
            },
            leave: () => {
              updateHoveredTerminalLink(null);
            },
          },
        ),
      );
      if (webglAddonModule !== null) {
        loadTerminalWebglRenderer(
          terminal,
          () => new webglAddonModule.WebglAddon(),
        );
      }
      terminal.open(containerElement);
      writeTerminalSessionStatusNotice({
        lastNotice: lastStatusNoticeRef,
        session: sessionRef.current,
        terminal,
      });
      const fitTerminal = () => {
        if (!fitAddon || !terminal) {
          return;
        }
        if (!hasVisibleTerminalSize({ containerElement })) {
          return;
        }
        fitAddon.fit();
        transport?.sendResize(terminal.cols, terminal.rows);
      };
      const scheduleFit: TerminalFitScheduler = () => {
        if (resizeAnimationFrame !== null) {
          return;
        }
        resizeAnimationFrame = window.requestAnimationFrame(() => {
          resizeAnimationFrame = null;
          fitTerminal();
        });
      };
      fitTerminal();
      scheduleFitRef.current = scheduleFit;
      const currentActiveElement = document.activeElement;
      if (
        shouldFocusTerminalAfterAsyncMount({
          currentFocusIsAvailable:
            currentActiveElement !== null &&
            currentActiveElement !== document.body &&
            currentActiveElement.isConnected,
          hasExplicitFocusRequest: autoFocusRef.current,
          focusMovedDuringMount: currentActiveElement !== activeElementAtMount,
          isPanelOpen: isPanelOpenRef.current,
        })
      ) {
        terminal.focus();
        onAutoFocusHandledRef.current?.();
      }

      const activeTerminal = terminal;
      let hasOpened = false;
      let reconnectNoticeVisible = false;
      const activeTransport = new TerminalWebSocketTransport({
        onConnectionState: (state) => {
          if (disposed) {
            return;
          }
          if (state === "reconnecting" && !reconnectNoticeVisible) {
            reconnectNoticeVisible = true;
            writeTerminalStatus({
              terminal: activeTerminal,
              text: "Terminal connection lost; reconnecting...",
            });
            return;
          }
          if (state === "open") {
            if (hasOpened && reconnectNoticeVisible) {
              writeTerminalStatus({
                terminal: activeTerminal,
                text: "Terminal reconnected",
              });
            }
            hasOpened = true;
            reconnectNoticeVisible = false;
          }
        },
        onInputOverflow: (maxBytes) => {
          writeTerminalStatus({
            terminal: activeTerminal,
            text: `Terminal input queue is full (${maxBytes} bytes); input was not sent`,
          });
        },
        onInvalidMessage: () => {
          writeTerminalStatus({
            terminal: activeTerminal,
            text: "Terminal received an invalid server message",
          });
        },
        onMessage: (message) => {
          handleTerminalServerMessage({
            message,
            onSessionChange: onSessionChangeRef.current,
            replayNextSeq,
            replayWriteState,
            setReplayNextSeq: (nextSeq) => {
              replayNextSeq = nextSeq;
            },
            terminal: activeTerminal,
          });
        },
        onSequenceGap: () => {
          activeTerminal.reset();
          writeTerminalStatus({
            terminal: activeTerminal,
            text: "Some terminal output was unavailable after reconnect",
          });
        },
        shouldReconnect: () =>
          !disposed && sessionStatusRef.current === "running",
        url: buildTerminalWebSocketUrl({ terminalId: session.id }),
      });
      transport = activeTransport;
      activeTransport.sendResize(activeTerminal.cols, activeTerminal.rows);
      activeTransport.start();
      const sendTerminalInput = (dataBase64: string) =>
        activeTransport.sendInput(dataBase64);
      activeTerminal.onData((data) => {
        forwardTerminalData({
          data,
          onInput: sendTerminalInput,
          onUserInput: onUserInputRef.current,
          replayWriteState,
          sessionStatus: sessionStatusRef.current,
        });
      });
      activeTerminal.onTitleChange((title) => {
        if (replayWriteState.suppressedWriteCount > 0) {
          return;
        }
        if (sessionStatusRef.current !== "running") {
          return;
        }
        onTitleChangeRef.current?.(title);
      });
      const scheduleSelectionReport = () => {
        if (pointerIsDownRef.current || selectionAnimationFrame !== null) {
          return;
        }
        selectionAnimationFrame = window.requestAnimationFrame(() => {
          selectionAnimationFrame = null;
          reportTerminalSelection(lastPointerReleaseAnchorRef.current);
        });
      };
      selectionChangeDisposable = activeTerminal.onSelectionChange(
        scheduleSelectionReport,
      );

      resizeObserver = new ResizeObserver((entries) => {
        if (!hasVisibleTerminalSize({ containerElement, entries })) {
          return;
        }
        scheduleFit();
      });
      resizeObserver.observe(containerElement);
    }

    void mountTerminal(container).catch((error) => {
      if (!disposed) {
        container.textContent =
          error instanceof Error ? error.message : String(error);
      }
    });

    return () => {
      disposed = true;
      if (resizeAnimationFrame !== null) {
        window.cancelAnimationFrame(resizeAnimationFrame);
      }
      if (selectionAnimationFrame !== null) {
        window.cancelAnimationFrame(selectionAnimationFrame);
      }
      resizeObserver?.disconnect();
      selectionChangeDisposable?.dispose();
      transport?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      scheduleFitRef.current = null;
    };
  }, [
    reportTerminalSelection,
    requestOpenTerminalLink,
    session.id,
    session.threadId,
    updateHoveredTerminalLink,
  ]);

  useEffect(() => {
    if (!isPanelOpen || !autoFocus) {
      return;
    }
    const terminal = terminalRef.current;
    if (terminal !== null) {
      terminal.focus();
      onAutoFocusHandledRef.current?.();
    }
    scheduleFitRef.current?.();
  }, [autoFocus, isPanelOpen]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    writeTerminalSessionStatusNotice({
      lastNotice: lastStatusNoticeRef,
      session,
      terminal,
    });
  }, [session]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.options.theme = buildTerminalTheme();
  }, [preferredTheme, appThemeEpoch]);

  const contextMenuLink = contextMenuState.link;
  const contextMenuSelectionText = contextMenuState.selectionText;
  const hasTerminalContextMenuTarget =
    hoveredTerminalLink !== null || activeSelection !== null;

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) {
          setContextMenuState({ link: null, selectionText: "" });
        }
      }}
    >
      <ContextMenuTrigger asChild disabled={!hasTerminalContextMenuTarget}>
        <div
          className="h-full min-h-0 w-full overflow-hidden bg-sidebar p-2"
          onContextMenuCapture={captureTerminalContextMenu}
          onPointerDown={handleTerminalPointerDown}
          onPointerUp={handleTerminalPointerRelease}
          onPointerCancel={handleTerminalPointerCancel}
          onTouchStart={handleTerminalTouchStart}
          onTouchMove={handleTerminalTouchMove}
          onTouchEnd={handleTerminalTouchEnd}
          onTouchCancel={handleTerminalTouchCancel}
        >
          <div
            ref={containerRef}
            className="h-full min-h-0 w-full overflow-hidden"
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-36">
        {contextMenuLink !== null ? (
          <>
            <ContextMenuItem
              onSelect={() => requestOpenTerminalLink(contextMenuLink)}
            >
              Open Link
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                copyTerminalContextValue(contextMenuLink.uri, "Link copied")
              }
            >
              Copy Link
            </ContextMenuItem>
          </>
        ) : null}
        {contextMenuLink !== null && contextMenuSelectionText.length > 0 ? (
          <ContextMenuSeparator />
        ) : null}
        {contextMenuSelectionText.length > 0 ? (
          <ContextMenuItem
            onSelect={() =>
              copyTerminalContextValue(
                contextMenuSelectionText,
                "Selection copied",
              )
            }
          >
            Copy
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
      <TimelineSelectionMenu
        selection={activeSelection}
        onAddToChat={
          onSelectionAddToChat === undefined
            ? undefined
            : handleSelectionAddToChat
        }
        onDismiss={clearTerminalSelection}
      />
      <TerminalLinkOpenDialog
        target={pendingTerminalLink}
        onConfirm={confirmTerminalLinkOpen}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTerminalLink(null);
          }
        }}
      />
    </ContextMenu>
  );
}
