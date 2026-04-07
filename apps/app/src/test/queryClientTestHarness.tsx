import { Provider as JotaiProvider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { createAppQueryClient } from "@/lib/query-client";

interface QueryClientTestWrapperProps {
  children: ReactNode;
}

type QueryClientTestWrapper = (props: QueryClientTestWrapperProps) => JSX.Element;

export interface QueryClientTestHarness {
  queryClient: QueryClient;
  wrapper: QueryClientTestWrapper;
}

export function createQueryClientTestHarness(): QueryClientTestHarness {
  const queryClient = createAppQueryClient({
    defaultOptions: {
      mutations: {
        retry: false,
      },
      queries: {
        gcTime: Infinity,
        retry: false,
      },
    },
  });

  const wrapper: QueryClientTestWrapper = ({ children }) => (
    <JotaiProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </JotaiProvider>
  );

  return {
    queryClient,
    wrapper,
  };
}
