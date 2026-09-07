import {
  focusManager,
  MutationCache,
  QueryClient,
  type QueryClientConfig,
} from "@tanstack/react-query";
import {
  getMutationErrorMeta,
  showMutationErrorToast,
} from "./mutation-errors";
import { createBrowserLifecycleFetchController } from "@/hooks/cache-owners/browser-lifecycle-cache-owner";
import {
  shouldRetryTransientReadQuery,
  TRANSIENT_READ_RETRY_DELAY_MS,
} from "@/hooks/queries/query-helpers";

interface CreateAppQueryClientOptions {
  defaultOptions?: QueryClientConfig["defaultOptions"];
  showMutationErrorToasts?: boolean;
  shouldRefetchOnWindowFocus?: () => boolean;
}

interface AppQueryClientBrowserEventCleanup {
  cleanup: () => void;
}

let appFocusEventsInstalled = false;

function installAppFocusEvents(): void {
  if (appFocusEventsInstalled) {
    return;
  }
  appFocusEventsInstalled = true;

  focusManager.setEventListener((handleFocus) => {
    if (typeof window === "undefined" || !window.addEventListener) {
      return;
    }

    const listener = () => handleFocus();
    window.addEventListener("visibilitychange", listener, false);
    window.addEventListener("pageshow", listener, false);

    return () => {
      window.removeEventListener("visibilitychange", listener);
      window.removeEventListener("pageshow", listener);
    };
  });
}

export function installAppQueryClientBrowserEvents(
  queryClient: QueryClient,
): AppQueryClientBrowserEventCleanup {
  installAppFocusEvents();

  if (typeof window === "undefined" || typeof document === "undefined") {
    return { cleanup: () => {} };
  }

  const fetchController = createBrowserLifecycleFetchController(queryClient);
  const handlePageHide = () => {
    fetchController.suspend();
  };
  const handlePageShow = () => {
    fetchController.resume();
  };
  const handleWindowFocus = () => {
    fetchController.resume();
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      fetchController.suspend();
      return;
    }
    if (document.visibilityState === "visible") {
      fetchController.resume();
    }
  };

  window.addEventListener("pagehide", handlePageHide, false);
  window.addEventListener("pageshow", handlePageShow, false);
  window.addEventListener("focus", handleWindowFocus, false);
  document.addEventListener("visibilitychange", handleVisibilityChange, false);

  return {
    cleanup: () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    },
  };
}

export function createAppQueryClient(
  options: CreateAppQueryClientOptions = {},
): QueryClient {
  installAppFocusEvents();

  const defaultOptions = options.defaultOptions;
  const showMutationErrorToasts = options.showMutationErrorToasts ?? true;
  const shouldRefetchOnWindowFocus = options.shouldRefetchOnWindowFocus;

  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (!showMutationErrorToasts) {
          return;
        }

        const meta = getMutationErrorMeta(mutation.meta);
        if (meta.showErrorToast === false) {
          return;
        }

        showMutationErrorToast({
          error,
          fallbackMessage: meta.errorMessage ?? "Request failed.",
          lifecycleOperation: meta.lifecycleOperation,
        });
      },
    }),
    defaultOptions: {
      ...defaultOptions,
      queries: {
        staleTime: 2000,
        refetchOnWindowFocus:
          shouldRefetchOnWindowFocus === undefined
            ? true
            : () => shouldRefetchOnWindowFocus(),
        refetchOnReconnect:
          shouldRefetchOnWindowFocus === undefined
            ? true
            : () => shouldRefetchOnWindowFocus(),
        retry: shouldRetryTransientReadQuery,
        retryDelay: TRANSIENT_READ_RETRY_DELAY_MS,
        ...defaultOptions?.queries,
      },
    },
  });
}
