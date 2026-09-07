import { useEffect, useMemo } from "react";
import type { GlobalProvider } from "@ladle/react";
import { ThemeState } from "@ladle/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { AppToaster } from "../src/components/AppToaster";
import { RouteNavigationProvider } from "../src/components/ui/app-route-anchor";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { setPreferredTheme } from "../src/hooks/useTheme";
import {
  createDiffWorker,
  getDiffWorkerPoolSize,
} from "../src/lib/diff-worker-pool";
import { createAppQueryClient } from "../src/lib/query-client";
import "./ladle.css";

if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("theme")) {
    const stored = window.localStorage.getItem("bb.theme");
    if (stored === "light" || stored === "dark") {
      params.set("theme", stored);
      const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
      window.history.replaceState(null, "", next);
    }
  }
}

export const Provider: GlobalProvider = ({ globalState, children }) => {
  const isDark = globalState.theme === ThemeState.Dark;
  useEffect(() => {
    setPreferredTheme(isDark ? "dark" : "light");
  }, [isDark]);
  const store = useMemo(() => createStore(), []);
  const queryClient = useMemo(
    () =>
      createAppQueryClient({
        showMutationErrorToasts: false,
        defaultOptions: {
          mutations: {
            retry: false,
          },
          queries: {
            gcTime: Infinity,
            retry: false,
          },
        },
      }),
    [],
  );

  return (
    <MemoryRouter initialEntries={["/"]}>
      {}
      <RouteNavigationProvider>
        <JotaiProvider store={store}>
          <QueryClientProvider client={queryClient}>
            <WorkerPoolContextProvider
              poolOptions={{
                workerFactory: createDiffWorker,
                poolSize: getDiffWorkerPoolSize(),
              }}
              highlighterOptions={{}}
            >
              <TooltipProvider delayDuration={300} disableHoverableContent>
                <div className="min-h-screen text-foreground">
                  {children}
                  <AppToaster position="bottom-right" />
                </div>
              </TooltipProvider>
            </WorkerPoolContextProvider>
          </QueryClientProvider>
        </JotaiProvider>
      </RouteNavigationProvider>
    </MemoryRouter>
  );
};
