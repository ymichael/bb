import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppToaster } from "./components/AppToaster";
import { initializePreferredTheme } from "./hooks/useTheme";
import {
  createDiffWorker,
  getDiffWorkerPoolSize,
} from "./lib/diff-worker-pool";
import { createAppQueryClient } from "./lib/query-client";
import "./app.css";

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
      <AppToaster position="bottom-right" />
    </QueryClientProvider>
  </StrictMode>,
);
