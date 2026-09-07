import { atom } from "jotai";
import type { BbDesktopBrowserRevealRequest } from "@bb/desktop-contract";

export const desktopBrowserRevealAtom =
  atom<BbDesktopBrowserRevealRequest | null>(null);
