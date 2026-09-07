import {
  listAccountServers,
  type AccountServerWithUrl,
  type ConnectCredential,
} from "@bb/connect-client";
import { useCallback, useEffect, useState } from "react";
import { describeEnrollmentError, type EnrollmentFailure } from "./enrollment";

export type AccountServersState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; servers: AccountServerWithUrl[]; selfHandle: string }
  | { status: "error"; failure: EnrollmentFailure };

export function useAccountServers(credential: ConnectCredential | null): {
  state: AccountServersState;
  reload: () => void;
} {
  const [nonce, setNonce] = useState(0);
  const serverUrl = credential?.serverUrl ?? null;
  const handle = credential?.handle ?? null;
  const secret = credential?.credential ?? null;
  const key =
    serverUrl !== null && handle !== null && secret !== null
      ? `${serverUrl} ${handle} ${secret} ${nonce}`
      : null;
  const [settled, setSettled] = useState<{
    key: string;
    state: AccountServersState;
  } | null>(null);

  useEffect(() => {
    if (serverUrl === null || handle === null || secret === null) return;
    const requestKey = `${serverUrl} ${handle} ${secret} ${nonce}`;
    let cancelled = false;
    listAccountServers({ serverUrl, handle, credential: secret })
      .then((result) => {
        if (cancelled) return;
        setSettled({
          key: requestKey,
          state: {
            status: "ready",
            servers: result.servers,
            selfHandle: result.selfHandle,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSettled({
          key: requestKey,
          state: { status: "error", failure: describeEnrollmentError(error) },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, handle, secret, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const state: AccountServersState =
    key === null
      ? { status: "idle" }
      : settled !== null && settled.key === key
        ? settled.state
        : { status: "loading" };
  return { state, reload };
}
