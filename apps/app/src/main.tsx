import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { DebugModeProvider } from "./hooks/useDebugMode";
import "./app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DebugModeProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </DebugModeProvider>
    </QueryClientProvider>
  </StrictMode>
);
