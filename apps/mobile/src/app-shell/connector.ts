import {
  createActiveProfileConnector,
  type ActiveProfileConnector,
} from "@/lib/connection";
import { nativeAppState, nativeCookieStore } from "@/lib/native";
import { getAppProfileClientRegistry } from "./client-registry";
import { createSessionScheduler } from "@/lib/session";

let instance: ActiveProfileConnector | null = null;

export function getActiveProfileConnector(): ActiveProfileConnector {
  if (!instance) {
    instance = createActiveProfileConnector({
      registry: getAppProfileClientRegistry(),
      appState: nativeAppState,
      createSessionScheduler: () =>
        createSessionScheduler({ cookieStore: nativeCookieStore }),
    });
  }
  return instance;
}

export function waitForActiveConnection(profileId: string): Promise<boolean> {
  const timeoutMs = 5_000;
  const connector = getActiveProfileConnector();
  if (connector.getSnapshot()?.profile.id === profileId) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const unsubscribe = connector.subscribe(() => {
      if (connector.getSnapshot()?.profile.id === profileId) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
