import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface NewManagerDialogState {
  isOpen: boolean;
  /** Project to seed the form with when the dialog opens. */
  initialProjectId: string | null;
}

export interface NewManagerDialogController {
  state: NewManagerDialogState;
  open: (projectId: string) => void;
  setOpen: (open: boolean) => void;
}

const newManagerDialogContext =
  createContext<NewManagerDialogController | null>(null);

interface NewManagerDialogProviderProps {
  children: ReactNode;
}

export function NewManagerDialogProvider({
  children,
}: NewManagerDialogProviderProps) {
  const [state, setState] = useState<NewManagerDialogState>({
    isOpen: false,
    initialProjectId: null,
  });

  const open = useCallback((projectId: string) => {
    setState({ isOpen: true, initialProjectId: projectId });
  }, []);

  // Radix Dialog hands open=false through onOpenChange when dismissed; we
  // ignore open=true because opening always needs to be paired with a
  // projectId via open().
  const setOpen = useCallback((nextOpen: boolean) => {
    if (nextOpen) return;
    setState((current) => ({ ...current, isOpen: false }));
  }, []);

  const controller = useMemo<NewManagerDialogController>(
    () => ({ state, open, setOpen }),
    [state, open, setOpen],
  );

  return (
    <newManagerDialogContext.Provider value={controller}>
      {children}
    </newManagerDialogContext.Provider>
  );
}

export function useNewManagerDialog(): NewManagerDialogController {
  const value = useContext(newManagerDialogContext);
  if (!value) {
    throw new Error("NewManagerDialogProvider is required");
  }
  return value;
}
