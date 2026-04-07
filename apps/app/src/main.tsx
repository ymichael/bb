import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { Toaster } from "./components/ui/sonner";
import { initializePreferredTheme } from "./hooks/useTheme";
import { createAppQueryClient } from "./lib/query-client";
import "./app.css";

const DIFF_WORKER_POOL_MAX_SIZE = 8;
const DIFF_WORKER_POOL_MIN_SIZE = 1;

function getDiffWorkerPoolSize(): number {
  const hardwareConcurrency =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  if (hardwareConcurrency === undefined || hardwareConcurrency <= 2) {
    return DIFF_WORKER_POOL_MIN_SIZE;
  }
  return Math.max(
    DIFF_WORKER_POOL_MIN_SIZE,
    Math.min(DIFF_WORKER_POOL_MAX_SIZE, hardwareConcurrency - 1),
  );
}

function createDiffWorker(): Worker {
  return new Worker(
    new URL("@pierre/diffs/worker/worker-portable.js", import.meta.url),
    { name: "pierre-diffs-worker" },
  );
}

const queryClient = createAppQueryClient();

initializePreferredTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WorkerPoolContextProvider
        poolOptions={{
          workerFactory: createDiffWorker,
          poolSize: getDiffWorkerPoolSize(),
        }}
        highlighterOptions={{}}
      >
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </WorkerPoolContextProvider>
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  </StrictMode>
);
