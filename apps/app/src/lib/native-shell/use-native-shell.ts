import type { SafeAreaInsets } from "@bb/mobile-bridge";
import { useEffect, useState } from "react";
import { getNativeShell, type NativeShell } from "./native-shell";

export function useNativeShell(): NativeShell | null {
  return getNativeShell();
}

export function useNativeSafeArea(): SafeAreaInsets | null {
  const shell = useNativeShell();
  const [insets, setInsets] = useState<SafeAreaInsets | null>(
    () => shell?.safeArea() ?? null,
  );
  useEffect(() => {
    if (shell === null) return;
    return shell.subscribe((event) => {
      if (event.type === "safe-area") setInsets(event.safeArea);
    });
  }, [shell]);
  return insets;
}

export function useNativeShellResume(onResume: () => void): void {
  const shell = useNativeShell();
  useEffect(() => {
    if (shell === null) return;
    return shell.subscribe((event) => {
      if (event.type === "resume") onResume();
    });
  }, [onResume, shell]);
}
