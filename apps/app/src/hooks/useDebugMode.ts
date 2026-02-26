import {
  createElement,
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const DEBUG_MODE_STORAGE_KEY = "beanbag.debug-mode";

function readDebugMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === "true";
}

interface DebugModeContextValue {
  debugMode: boolean;
  setDebugMode: Dispatch<SetStateAction<boolean>>;
  toggleDebugMode: () => void;
}

const DebugModeContext = createContext<DebugModeContextValue | null>(null);

export function DebugModeProvider({ children }: { children: ReactNode }) {
  const [debugMode, setDebugModeState] = useState<boolean>(() => readDebugMode());

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, String(debugMode));
  }, [debugMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== DEBUG_MODE_STORAGE_KEY) return;
      setDebugModeState(readDebugMode());
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const toggleDebugMode = useCallback(() => {
    setDebugModeState((current) => !current);
  }, []);

  const value = useMemo<DebugModeContextValue>(
    () => ({
      debugMode,
      setDebugMode: setDebugModeState,
      toggleDebugMode,
    }),
    [debugMode, toggleDebugMode],
  );

  return createElement(DebugModeContext.Provider, { value }, children);
}

export function useDebugMode() {
  const context = useContext(DebugModeContext);
  if (!context) {
    throw new Error("useDebugMode must be used within a DebugModeProvider.");
  }

  return context;
}
