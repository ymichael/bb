import { Provider as JotaiProvider } from "jotai";
import {
  QueryClient,
  QueryClientProvider,
  type QueryClientConfig,
} from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { createAppQueryClient } from "@/lib/query-client";

interface QueryClientTestWrapperProps {
  children: ReactNode;
}

type QueryClientTestWrapper = (
  props: QueryClientTestWrapperProps,
) => JSX.Element;

interface QueryClientTestHarness {
  queryClient: QueryClient;
  wrapper: QueryClientTestWrapper;
}

export function createQueryClientTestHarness(
  overrides?: QueryClientConfig["defaultOptions"],
): QueryClientTestHarness {
  const queryClient = createAppQueryClient({
    defaultOptions: {
      mutations: {
        retry: false,
        ...overrides?.mutations,
      },
      queries: {
        gcTime: Infinity,
        retry: false,
        ...overrides?.queries,
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
