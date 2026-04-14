import {
  MutationCache,
  QueryClient,
  type QueryClientConfig,
} from "@tanstack/react-query";
import {
  getMutationErrorMeta,
  showMutationErrorToast,
} from "./mutation-errors";

export interface CreateAppQueryClientOptions {
  defaultOptions?: QueryClientConfig["defaultOptions"];
  showMutationErrorToasts?: boolean;
}

export function createAppQueryClient(
  options: CreateAppQueryClientOptions = {},
): QueryClient {
  const defaultOptions = options.defaultOptions;
  const showMutationErrorToasts = options.showMutationErrorToasts ?? true;

  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (!showMutationErrorToasts) {
          return;
        }

        // Set `showErrorToast: false` when the call site handles mutation errors itself.
        const meta = getMutationErrorMeta(mutation.meta);
        if (meta.showErrorToast === false) {
          return;
        }

        showMutationErrorToast({
          error,
          fallbackMessage: meta.errorMessage ?? "Request failed.",
        });
      },
    }),
    defaultOptions: {
      ...defaultOptions,
      queries: {
        staleTime: 2000,
        refetchOnWindowFocus: true,
        retry: 0,
        ...defaultOptions?.queries,
      },
    },
  });
}
