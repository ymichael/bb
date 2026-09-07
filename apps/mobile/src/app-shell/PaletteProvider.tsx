import { isBuiltInThemeId, type BuiltInThemeId } from "@bb/domain";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSystemConfig } from "@/data/system/system-queries";
import { useProfiles } from "./ProfilesProvider";

interface PaletteContextValue {
  palette: BuiltInThemeId;
  setPalette: (palette: BuiltInThemeId) => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

export function PaletteProvider({
  children,
}: {
  children: (palette: BuiltInThemeId) => ReactNode;
}) {
  const [palette, setPalette] = useState<BuiltInThemeId>("default");
  const value = useMemo(() => ({ palette, setPalette }), [palette]);
  return (
    <PaletteContext.Provider value={value}>
      {children(palette)}
    </PaletteContext.Provider>
  );
}

function usePaletteSetter(): (palette: BuiltInThemeId) => void {
  const value = useContext(PaletteContext);
  if (!value) {
    throw new Error("usePaletteSetter must be used inside <PaletteProvider>");
  }
  return value.setPalette;
}

function paletteFromThemeId(themeId: string): BuiltInThemeId {
  return isBuiltInThemeId(themeId) ? themeId : "default";
}

function ActiveServerPaletteSync() {
  const setPalette = usePaletteSetter();
  const config = useSystemConfig();
  const themeId = config.data?.appearance.themeId;
  useEffect(() => {
    if (themeId !== undefined) setPalette(paletteFromThemeId(themeId));
  }, [themeId, setPalette]);
  return null;
}

export function ServerPaletteSync() {
  const { connection } = useProfiles();
  return connection ? <ActiveServerPaletteSync /> : null;
}
