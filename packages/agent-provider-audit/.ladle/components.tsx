import type { GlobalProvider } from "@ladle/react";
import { ThemeState } from "@ladle/react";
import { cn } from "@bb/ui-core";
import "./ladle.css";

export const Provider: GlobalProvider = ({ globalState, children }) => {
  const isDark = globalState.theme === ThemeState.Dark;
  return (
    <div className={cn(isDark && "dark", "min-h-screen bg-background text-foreground")}>
      {children}
    </div>
  );
};
