import { createBrowserBbSdk, type BrowserBbSdk } from "@bb/sdk/browser";
import type { ServerProfile } from "../profiles/profile";
import {
  createMobileRealtime,
  type CreateMobileRealtimeOptions,
  type MobileRealtime,
} from "../realtime/mobile-realtime";
import { realtimeUrlForServer } from "../realtime/realtime-url";
import { createMobileFetch, type MobileFetchOptions } from "./mobile-fetch";

export interface MobileSdk {
  sdk: BrowserBbSdk;
  realtime: MobileRealtime;
  fetch: typeof fetch;
}

export interface CreateMobileSdkOptions {
  fetch?: typeof fetch;
  onAuthFailure?: MobileFetchOptions["onAuthFailure"];
  realtime?: Omit<CreateMobileRealtimeOptions, "url">;
}

export function createMobileSdk(
  profile: Pick<ServerProfile, "serverUrl">,
  options: CreateMobileSdkOptions = {},
): MobileSdk {
  const baseFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const mobileFetch = createMobileFetch(baseFetch, {
    onAuthFailure: options.onAuthFailure,
  });
  const sdk = createBrowserBbSdk({
    baseUrl: profile.serverUrl,
    fetch: mobileFetch,
  });
  const realtime = createMobileRealtime({
    ...options.realtime,
    url: realtimeUrlForServer(profile.serverUrl),
  });
  return { sdk, realtime, fetch: mobileFetch };
}
