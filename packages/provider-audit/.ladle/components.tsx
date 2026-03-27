import type { GlobalProvider } from "@ladle/react";
import { ThemeState } from "@ladle/react";
import "./ladle.css";

export const Provider: GlobalProvider = ({ globalState, children }) => {
  const isDark = globalState.theme === ThemeState.Dark;
  return (
    <div className={`${isDark ? "dark" : ""} min-h-screen bg-background text-foreground`}>
      {children}
    </div>
  );
};
