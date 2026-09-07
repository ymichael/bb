import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  defaultAppSettings,
  isAppKeybindingAvailableForClient,
  isMacKeyboardPlatform,
  matchesAppShortcut,
  type AppCommandContext,
  type AppCommandContextKey,
  type AppCommandId,
  type AppDefaultKeybindings,
  type AppKeybindings,
  type AppShortcut,
} from "@bb/domain";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import {
  formatAppShortcut,
  formatAppShortcutAria,
  isEditableKeyboardTarget,
  matchesAppCommandContext,
  type AppShortcutPresentation,
} from "@/lib/app-keybindings";

interface AppCommandInvocation {
  target: EventTarget | null;
}

type AppCommandHandler = (invocation: AppCommandInvocation) => boolean;

interface AppCommandHandlerRegistration {
  handler: AppCommandHandler;
  priority: number;
  sequence: number;
}

interface AppCommandProviderValue {
  dispatch: (command: AppCommandId, target: EventTarget | null) => boolean;
  getShortcut: (command: AppCommandId) => AppShortcut | null;
  handleKeyboardEvent: (event: KeyboardEvent) => boolean;
  isCommandAvailable: (
    command: AppCommandId,
    target: EventTarget | null,
  ) => boolean;
  registerContext: (
    key: AppCommandContextKey,
    source: symbol,
    active: boolean,
  ) => void;
  registerHandler: (
    command: AppCommandId,
    registration: Omit<AppCommandHandlerRegistration, "sequence">,
  ) => () => void;
}

const AppCommandContextValue = createContext<AppCommandProviderValue | null>(
  null,
);
const AppCommandModifierHeldContext = createContext(false);

const EMPTY_KEYBINDINGS: AppKeybindings = [];
const EMPTY_DEFAULT_KEYBINDINGS: AppDefaultKeybindings = [];
const SHORTCUT_HINT_HOLD_DELAY_MS = 700;

const EMPTY_CONTEXT: AppCommandContext = {
  mainSurface: false,
  modalOpen: false,
  editableFocus: false,
  terminalFocus: false,
  browserFocus: false,
  modelPickerOpen: false,
  questionOpen: false,
  promptAvailable: false,
  splitActive: false,
  webSurface: false,
  macPlatform: false,
};

function browserPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

const OPEN_MODAL_SELECTOR = [
  '[aria-modal="true"]:not([inert]):not([inert] *):not([data-state="closed"])',
  '[role="dialog"][data-state="open"]:not([inert]):not([inert] *)',
].join(", ");

function hasOpenModal(): boolean {
  return document.querySelector(OPEN_MODAL_SELECTOR) !== null;
}

export function AppCommandProvider({ children }: { children: ReactNode }) {
  const systemConfig = useSystemConfig();
  const keybindings = systemConfig.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const defaultKeybindings =
    systemConfig.data?.defaultKeybindings ?? EMPTY_DEFAULT_KEYBINDINGS;
  const showKeyboardHints =
    systemConfig.data?.generalSettings?.showKeyboardHints ??
    defaultAppSettings.showKeyboardHints;
  const isDesktop = getBbDesktopInfo() !== null;
  const [isShortcutHintModifierHeld, setIsShortcutHintModifierHeld] =
    useState(false);
  const modifierHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const shortcutHintModifierHeldRef = useRef(false);
  const keybindingsRef = useRef(keybindings);
  const handlersRef = useRef(
    new Map<AppCommandId, Map<symbol, AppCommandHandlerRegistration>>(),
  );
  const activeContextsRef = useRef(
    new Map<AppCommandContextKey, Set<symbol>>(),
  );
  const sequenceRef = useRef(0);
  const attemptedEventsRef = useRef(new WeakSet<KeyboardEvent>());
  const clearShortcutHintHoldRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!showKeyboardHints) return;
    const isMac = isMacKeyboardPlatform(browserPlatform());
    const isShortcutHintModifier = (key: string) =>
      key === "Control" || (isMac && key === "Meta");
    const clearModifierHold = () => {
      if (modifierHoldTimerRef.current !== null) {
        clearTimeout(modifierHoldTimerRef.current);
        modifierHoldTimerRef.current = null;
      }
      shortcutHintModifierHeldRef.current = false;
      setIsShortcutHintModifierHeld(false);
    };
    clearShortcutHintHoldRef.current = clearModifierHold;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isShortcutHintModifier(event.key)) {
        if (
          modifierHoldTimerRef.current !== null ||
          shortcutHintModifierHeldRef.current
        ) {
          clearModifierHold();
        }
        return;
      }
      if (
        modifierHoldTimerRef.current !== null ||
        shortcutHintModifierHeldRef.current
      ) {
        return;
      }
      const otherModifierHeld =
        event.shiftKey ||
        event.altKey ||
        (event.key === "Meta" ? event.ctrlKey : event.metaKey);
      if (otherModifierHeld) {
        clearModifierHold();
        return;
      }
      modifierHoldTimerRef.current = setTimeout(() => {
        modifierHoldTimerRef.current = null;
        shortcutHintModifierHeldRef.current = true;
        setIsShortcutHintModifierHeld(true);
      }, SHORTCUT_HINT_HOLD_DELAY_MS);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (isShortcutHintModifier(event.key)) clearModifierHold();
    };
    const handleBlur = () => clearModifierHold();

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      clearModifierHold();
      clearShortcutHintHoldRef.current = () => {};
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [showKeyboardHints]);

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  const registerHandler = useCallback<
    AppCommandProviderValue["registerHandler"]
  >((command, registration) => {
    const token = Symbol(command);
    const registrations = handlersRef.current.get(command) ?? new Map();
    sequenceRef.current += 1;
    registrations.set(token, {
      ...registration,
      sequence: sequenceRef.current,
    });
    handlersRef.current.set(command, registrations);
    return () => {
      registrations.delete(token);
      if (registrations.size === 0) {
        handlersRef.current.delete(command);
      }
    };
  }, []);

  const registerContext = useCallback<
    AppCommandProviderValue["registerContext"]
  >((key, source, active) => {
    const sources = activeContextsRef.current.get(key) ?? new Set<symbol>();
    if (active) {
      sources.add(source);
      activeContextsRef.current.set(key, sources);
      return;
    }
    sources.delete(source);
    if (sources.size === 0) {
      activeContextsRef.current.delete(key);
    }
  }, []);

  const dispatch = useCallback(
    (command: AppCommandId, target: EventTarget | null): boolean => {
      const registrations = handlersRef.current.get(command);
      if (!registrations) return false;
      const ordered = [...registrations.values()].sort(
        (left, right) =>
          right.priority - left.priority || right.sequence - left.sequence,
      );
      for (const registration of ordered) {
        if (registration.handler({ target })) return true;
      }
      return false;
    },
    [],
  );

  const currentContext = useCallback(
    (target: EventTarget | null): AppCommandContext => {
      const next = { ...EMPTY_CONTEXT };
      next.mainSurface = true;
      next.modalOpen = hasOpenModal();
      next.editableFocus = isEditableKeyboardTarget(target);
      next.terminalFocus =
        target instanceof HTMLElement &&
        target.closest("[data-app-terminal]") !== null;
      next.browserFocus =
        target instanceof HTMLElement &&
        target.closest("[data-app-browser]") !== null;
      next.webSurface = !isDesktop;
      next.macPlatform = isMacKeyboardPlatform(browserPlatform());
      for (const key of activeContextsRef.current.keys()) {
        next[key] = true;
      }
      return next;
    },
    [isDesktop],
  );

  const isCommandAvailable = useCallback(
    (command: AppCommandId, target: EventTarget | null): boolean => {
      const registrations = handlersRef.current.get(command);
      if (registrations === undefined || registrations.size === 0) return false;
      const isMac = isMacKeyboardPlatform(browserPlatform());
      const applicable = defaultKeybindings.filter(
        (binding) =>
          binding.command === command &&
          isAppKeybindingAvailableForClient(binding, { isDesktop, isMac }),
      );
      if (applicable.length === 0) return false;
      const context = currentContext(target);
      return applicable.some((binding) =>
        binding.when.all.every((key) => context[key]),
      );
    },
    [currentContext, defaultKeybindings, isDesktop],
  );

  const getShortcut = useCallback(
    (command: AppCommandId): AppShortcut | null => {
      const isMac = isMacKeyboardPlatform(browserPlatform());
      let binding;
      for (let index = keybindings.length - 1; index >= 0; index -= 1) {
        const candidate = keybindings[index];
        if (
          candidate?.command === command &&
          isAppKeybindingAvailableForClient(candidate, { isDesktop, isMac })
        ) {
          binding = candidate;
          break;
        }
      }
      return binding?.shortcut ?? null;
    },
    [isDesktop, keybindings],
  );

  const handleKeyboardEvent = useCallback(
    (event: KeyboardEvent): boolean => {
      if (event.defaultPrevented || event.isComposing || event.repeat) {
        return false;
      }
      if (attemptedEventsRef.current.has(event)) return false;
      attemptedEventsRef.current.add(event);
      const bindings = keybindingsRef.current;
      let context: AppCommandContext | null = null;
      const isMac = isMacKeyboardPlatform(browserPlatform());
      for (let index = bindings.length - 1; index >= 0; index -= 1) {
        const binding = bindings[index];
        if (!binding) continue;
        if (!isAppKeybindingAvailableForClient(binding, { isDesktop, isMac })) {
          continue;
        }
        if (!matchesAppShortcut(event, binding.shortcut, isMac)) continue;
        context ??= currentContext(event.target);
        if (!matchesAppCommandContext(binding, context)) continue;
        if (!dispatch(binding.command, event.target)) return false;
        clearShortcutHintHoldRef.current();
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    },
    [currentContext, dispatch, isDesktop],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      handleKeyboardEvent(event);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyboardEvent]);

  useEffect(() => {
    const desktop = getBbDesktopInfo();
    if (!desktop?.onAppCommand) return;
    return desktop.onAppCommand((command) => {
      dispatch(command, null);
    });
  }, [dispatch]);

  const value = useMemo<AppCommandProviderValue>(
    () => ({
      dispatch,
      getShortcut,
      handleKeyboardEvent,
      isCommandAvailable,
      registerContext,
      registerHandler,
    }),
    [
      dispatch,
      getShortcut,
      handleKeyboardEvent,
      isCommandAvailable,
      registerContext,
      registerHandler,
    ],
  );

  return (
    <AppCommandContextValue.Provider value={value}>
      <AppCommandModifierHeldContext.Provider
        value={isShortcutHintModifierHeld}
      >
        {children}
      </AppCommandModifierHeldContext.Provider>
    </AppCommandContextValue.Provider>
  );
}

export function useAppCommandHandler(
  command: AppCommandId,
  handler: AppCommandHandler,
  priority = 0,
  enabled = true,
): void {
  const registerHandler = useContext(AppCommandContextValue)?.registerHandler;
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    if (!registerHandler || !enabled) return;
    return registerHandler(command, {
      handler: (invocation) => handlerRef.current(invocation),
      priority,
    });
  }, [command, enabled, priority, registerHandler]);
}

export function useIndexedAppCommandHandlers(
  commands: readonly AppCommandId[],
  handler: (index: number, invocation: AppCommandInvocation) => boolean,
  priority = 0,
  enabled = true,
): void {
  const registerHandler = useContext(AppCommandContextValue)?.registerHandler;
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    if (!registerHandler || !enabled) return;
    const unregister = commands.map((command, index) =>
      registerHandler(command, {
        handler: (invocation) => handlerRef.current(index, invocation),
        priority,
      }),
    );
    return () => {
      unregister.forEach((dispose) => dispose());
    };
  }, [commands, enabled, priority, registerHandler]);
}

export function useAppCommandKeyDispatch(): (event: KeyboardEvent) => boolean {
  const handleKeyboardEvent = useContext(
    AppCommandContextValue,
  )?.handleKeyboardEvent;
  return useCallback(
    (event: KeyboardEvent) => handleKeyboardEvent?.(event) ?? false,
    [handleKeyboardEvent],
  );
}

export interface AppCommandRunner {
  dispatch: (command: AppCommandId, target: EventTarget | null) => boolean;
  isCommandAvailable: (
    command: AppCommandId,
    target: EventTarget | null,
  ) => boolean;
}

export function useAppCommandRunner(): AppCommandRunner {
  const value = useContext(AppCommandContextValue);
  return useMemo(
    () => ({
      dispatch: (command, target) => value?.dispatch(command, target) ?? false,
      isCommandAvailable: (command, target) =>
        value?.isCommandAvailable(command, target) ?? false,
    }),
    [value],
  );
}

export function useAppCommandContext(
  key: AppCommandContextKey,
  active: boolean,
): void {
  const registerContext = useContext(AppCommandContextValue)?.registerContext;
  const sourceRef = useRef(Symbol(key));
  useEffect(() => {
    if (!registerContext) return;
    const source = sourceRef.current;
    registerContext(key, source, active);
    return () => registerContext(key, source, false);
  }, [active, key, registerContext]);
}

export function useAppCommandShortcut(
  command: AppCommandId,
): AppShortcutPresentation | null {
  const value = useContext(AppCommandContextValue);
  return useMemo(() => {
    const shortcut = value?.getShortcut(command);
    if (!shortcut) return null;
    const platform = browserPlatform();
    return {
      ariaKeyshortcuts: formatAppShortcutAria(shortcut, platform),
      label: formatAppShortcut(shortcut, platform),
    };
  }, [command, value]);
}

export function useIsAppCommandModifierHeld(): boolean {
  return useContext(AppCommandModifierHeldContext);
}

export function useAppCommandShortcuts(
  commands: readonly AppCommandId[],
): ReadonlyMap<AppCommandId, AppShortcutPresentation> {
  const value = useContext(AppCommandContextValue);
  return useMemo(() => {
    const presentations = new Map<AppCommandId, AppShortcutPresentation>();
    const platform = browserPlatform();
    for (const command of commands) {
      const shortcut = value?.getShortcut(command);
      if (!shortcut) continue;
      presentations.set(command, {
        ariaKeyshortcuts: formatAppShortcutAria(shortcut, platform),
        label: formatAppShortcut(shortcut, platform),
      });
    }
    return presentations;
  }, [commands, value]);
}
