import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ExperimentalFileOpenOptions } from "@get-bb/plugin-sdk";
import { AppNavigationHostProvider } from "@/lib/app-navigation-host";

const MAX_PENDING_EXTERNAL_FILE_INTENTS = 32;
const LazyAppFileExternalNavigationDispatcher = lazy(() =>
  import("./AppFileExternalNavigationDispatcher").then(
    ({ AppFileExternalNavigationDispatcher }) => ({
      default: AppFileExternalNavigationDispatcher,
    }),
  ),
);

interface ExternalFileIntentRequest {
  id: number;
  intent: ExperimentalFileOpenOptions;
}

export function AppFileExternalNavigationHost({
  children,
}: {
  children: ReactNode;
}) {
  const [queue, setQueue] = useState<ExternalFileIntentRequest[]>([]);
  const queueRef = useRef(queue);
  const nextRequestIdRef = useRef(0);
  const replaceQueue = useCallback((next: ExternalFileIntentRequest[]) => {
    queueRef.current = next;
    setQueue(next);
  }, []);
  const openFileExternally = useCallback(
    (intent: ExperimentalFileOpenOptions): boolean => {
      if (queueRef.current.length >= MAX_PENDING_EXTERNAL_FILE_INTENTS) {
        return false;
      }
      const request = { id: nextRequestIdRef.current, intent };
      nextRequestIdRef.current += 1;
      replaceQueue([...queueRef.current, request]);
      return true;
    },
    [replaceQueue],
  );
  const current = queue[0] ?? null;
  const settleCurrent = useCallback(() => {
    replaceQueue(queueRef.current.slice(1));
  }, [replaceQueue]);

  const capabilities = useMemo(
    () => ({ openFileExternally }),
    [openFileExternally],
  );
  return (
    <AppNavigationHostProvider capabilities={capabilities}>
      {children}
      {current === null ? null : (
        <Suspense fallback={null}>
          <LazyAppFileExternalNavigationDispatcher
            key={current.id}
            intent={current.intent}
            onSettled={settleCurrent}
          />
        </Suspense>
      )}
    </AppNavigationHostProvider>
  );
}
