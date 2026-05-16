import { z } from "zod";

export const THREAD_TERMINAL_PANEL_STATE_STORAGE_PREFIX =
  "bb.thread.terminalPanelState";
export const THREAD_TERMINAL_PANEL_STATE_STORAGE_VERSION = 1;
export const THREAD_TERMINAL_PANEL_IDLE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_PANEL_HEIGHT_PERCENT = 32;
export const MIN_TERMINAL_PANEL_HEIGHT_PERCENT = 18;
export const MAX_TERMINAL_PANEL_HEIGHT_PERCENT = 70;

const threadTerminalPanelStateSchema = z
  .object({
    version: z.literal(THREAD_TERMINAL_PANEL_STATE_STORAGE_VERSION),
    isOpen: z.boolean(),
    activeTerminalId: z.string().min(1).nullable(),
    panelHeightPercent: z
      .number()
      .int()
      .min(MIN_TERMINAL_PANEL_HEIGHT_PERCENT)
      .max(MAX_TERMINAL_PANEL_HEIGHT_PERCENT),
    lastUsedAt: z.number().int().nonnegative(),
  })
  .strict();

export interface ThreadTerminalPanelState {
  version: typeof THREAD_TERMINAL_PANEL_STATE_STORAGE_VERSION;
  isOpen: boolean;
  activeTerminalId: string | null;
  panelHeightPercent: number;
  lastUsedAt: number;
}

interface ThreadTerminalPanelStorageKeyArgs {
  threadId: string;
}

interface CreateThreadTerminalPanelStateArgs {
  activeTerminalId?: string | null;
  isOpen?: boolean;
  lastUsedAt?: number;
  panelHeightPercent?: number;
}

interface ParseThreadTerminalPanelStateArgs {
  initialValue: ThreadTerminalPanelState;
  now: number;
  storedValue: string | null;
}

interface ParseThreadTerminalPanelStateForStorageResult {
  shouldPrune: boolean;
  state: ThreadTerminalPanelState;
}

interface SerializeThreadTerminalPanelStateArgs {
  state: ThreadTerminalPanelState;
}

interface IsThreadTerminalPanelStateExpiredArgs {
  now: number;
  state: ThreadTerminalPanelState;
}

interface PruneThreadTerminalPanelStorageArgs {
  now: number;
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

export function createEmptyThreadTerminalPanelState(
  args: CreateThreadTerminalPanelStateArgs = {},
): ThreadTerminalPanelState {
  return {
    version: THREAD_TERMINAL_PANEL_STATE_STORAGE_VERSION,
    isOpen: args.isOpen ?? false,
    activeTerminalId: args.activeTerminalId ?? null,
    panelHeightPercent:
      args.panelHeightPercent ?? DEFAULT_TERMINAL_PANEL_HEIGHT_PERCENT,
    lastUsedAt: args.lastUsedAt ?? 0,
  };
}

export const EMPTY_THREAD_TERMINAL_PANEL_STATE =
  createEmptyThreadTerminalPanelState();

export function getThreadTerminalPanelStateStorageKey({
  threadId,
}: ThreadTerminalPanelStorageKeyArgs): string {
  return `${THREAD_TERMINAL_PANEL_STATE_STORAGE_PREFIX}-${normalizeStorageSegment(
    threadId,
  )}-${THREAD_TERMINAL_PANEL_STATE_STORAGE_VERSION}`;
}

export function isThreadTerminalPanelStateStorageKey(key: string): boolean {
  return (
    key.startsWith(`${THREAD_TERMINAL_PANEL_STATE_STORAGE_PREFIX}-`) &&
    key.endsWith(`-${THREAD_TERMINAL_PANEL_STATE_STORAGE_VERSION}`)
  );
}

export function isThreadTerminalPanelStateExpired({
  now,
  state,
}: IsThreadTerminalPanelStateExpiredArgs): boolean {
  return now - state.lastUsedAt > THREAD_TERMINAL_PANEL_IDLE_EXPIRY_MS;
}

export function parseThreadTerminalPanelState({
  initialValue,
  now,
  storedValue,
}: ParseThreadTerminalPanelStateArgs): ThreadTerminalPanelState {
  return parseThreadTerminalPanelStateForStorage({
    initialValue,
    now,
    storedValue,
  }).state;
}

function parseThreadTerminalPanelStateForStorage({
  initialValue,
  now,
  storedValue,
}: ParseThreadTerminalPanelStateArgs): ParseThreadTerminalPanelStateForStorageResult {
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

  const stateResult = threadTerminalPanelStateSchema.safeParse(parsedValue);
  if (!stateResult.success) {
    return {
      shouldPrune: true,
      state: initialValue,
    };
  }

  if (isThreadTerminalPanelStateExpired({ now, state: stateResult.data })) {
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

export function serializeThreadTerminalPanelState({
  state,
}: SerializeThreadTerminalPanelStateArgs): string {
  return JSON.stringify(state);
}

export function pruneThreadTerminalPanelStorage({
  now,
}: PruneThreadTerminalPanelStorageArgs): void {
  const localStorage = getLocalStorage();
  if (!localStorage) {
    return;
  }

  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && isThreadTerminalPanelStateStorageKey(key)) {
      keys.push(key);
    }
  }

  for (const key of keys) {
    const result = parseThreadTerminalPanelStateForStorage({
      initialValue: EMPTY_THREAD_TERMINAL_PANEL_STATE,
      now,
      storedValue: localStorage.getItem(key),
    });
    if (result.shouldPrune) {
      localStorage.removeItem(key);
    }
  }
}
