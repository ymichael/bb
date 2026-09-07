import {
  compareBridgeVersions,
  isBridgeUsable,
  NATIVE_BRIDGE_GLOBAL,
  parseNativeShellHandshake,
  parseShellToPageEvent,
  safeAreaInsetsSchema,
  shareResultSchema,
  type BridgeHapticKind,
  type BridgeSharePayload,
  type NativeScreen,
  type NativeCapability,
  type NativeShellHandshake,
  type SafeAreaInsets,
  type ShellToPageEvent,
} from "@bb/mobile-bridge";

interface NativeBridgeGlobal {
  post(message: unknown): void;
  request(kind: string, payload: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  safeArea?: unknown;
}

export interface NativeShell {
  handshake: NativeShellHandshake;
  safeArea(): SafeAreaInsets;
  has(capability: NativeCapability): boolean;
  post(message: unknown): void;
  request(kind: string, payload: unknown): Promise<unknown>;
  subscribe(listener: (event: ShellToPageEvent) => void): () => void;
}

function readBridgeGlobal(): NativeBridgeGlobal | null {
  if (typeof window === "undefined") return null;
  const root = (window as unknown as Record<string, unknown>)[
    NATIVE_BRIDGE_GLOBAL
  ];
  if (typeof root !== "object" || root === null) return null;
  const native = (root as Record<string, unknown>).native;
  if (typeof native !== "object" || native === null) return null;
  const candidate = native as Partial<NativeBridgeGlobal>;
  if (
    typeof candidate.post !== "function" ||
    typeof candidate.request !== "function" ||
    typeof candidate.subscribe !== "function"
  ) {
    return null;
  }
  return native as NativeBridgeGlobal;
}

function pickHandshakeFields(bridge: NativeBridgeGlobal): unknown {
  const source = bridge as unknown as Record<string, unknown>;
  return {
    bridgeVersion: source.bridgeVersion,
    appVersion: source.appVersion,
    platform: source.platform,
    profileMode: source.profileMode,
    secureContext: source.secureContext,
    safeArea: source.safeArea,
    capabilities: source.capabilities,
  };
}

function buildNativeShell(): NativeShell | null {
  const bridge = readBridgeGlobal();
  if (bridge === null) return null;
  const handshake = parseNativeShellHandshake(pickHandshakeFields(bridge));
  if (handshake === null) return null;
  if (!isBridgeUsable(compareBridgeVersions(handshake.bridgeVersion))) {
    return null;
  }
  const capabilities = new Set<NativeCapability>(handshake.capabilities);
  return {
    handshake,
    safeArea: () => {
      const live = safeAreaInsetsSchema.safeParse(bridge.safeArea);
      return live.success ? live.data : handshake.safeArea;
    },
    has: (capability) => capabilities.has(capability),
    post: (message) => bridge.post(message),
    request: (kind, payload) => bridge.request(kind, payload),
    subscribe: (listener) =>
      bridge.subscribe((event) => {
        const parsed = parseShellToPageEvent(event);
        if (parsed !== null) listener(parsed);
      }),
  };
}

let cached: NativeShell | null | undefined;

export function getNativeShell(): NativeShell | null {
  if (cached === undefined) cached = buildNativeShell();
  return cached;
}

export function resetNativeShellForTests(): void {
  cached = undefined;
}

export function isInsideNativeShell(): boolean {
  return getNativeShell() !== null;
}

export function shellHaptic(kind: BridgeHapticKind): void {
  const shell = getNativeShell();
  if (shell === null || !shell.has("haptic")) return;
  shell.post({ type: "haptic", kind });
}

export function shellSetBadge(count: number): void {
  const normalized = Math.max(0, Math.trunc(count));
  const shell = getNativeShell();
  if (shell !== null && shell.has("badge")) {
    shell.post({ type: "badge", count: normalized });
    return;
  }
  if (typeof navigator === "undefined") return;
  const badging = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  const update =
    normalized === 0
      ? badging.clearAppBadge?.()
      : badging.setAppBadge?.(normalized);
  void update?.catch(() => undefined);
}

export function shellOpenExternal(url: string): boolean {
  const shell = getNativeShell();
  if (shell === null || !shell.has("open-external")) return false;
  shell.post({ type: "open-external", url });
  return true;
}

export async function shellShare(
  payload: BridgeSharePayload,
): Promise<boolean | null> {
  const shell = getNativeShell();
  if (shell !== null && shell.has("share")) {
    try {
      const result = await shell.request("share", payload);
      return shareResultSchema.parse(result).shared;
    } catch {
      return null;
    }
  }
  if (typeof navigator === "undefined" || navigator.share === undefined) {
    return null;
  }
  try {
    await navigator.share(payload);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return false;
    }
    return null;
  }
}

export function shellOpenNative(screen: NativeScreen): boolean {
  const shell = getNativeShell();
  if (shell === null || !shell.has("open-native")) return false;
  shell.post({ type: "open-native", screen });
  return true;
}

export function canOpenNativeScreen(): boolean {
  const shell = getNativeShell();
  return shell !== null && shell.has("open-native");
}

export function shellReportReady(path: string): void {
  getNativeShell()?.post({ type: "ready", path });
}

export function shellReportPath(title: string, path: string): void {
  getNativeShell()?.post({ type: "title", title, path });
}
