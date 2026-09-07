import {
  createBbSdk,
  createBuiltinPlanCommandTextInput,
  type BbSdk,
  type BbSdkAreas,
} from "./core.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  BbRealtimeSocketFactory,
  BbSdkContext,
  BbSdkTransport,
} from "./transport.js";

export interface CreateBrowserTransportArgs {
  baseUrl?: string;
  fetch?: typeof fetch;
  realtimeUrl?: string;
  websocket?: BbRealtimeSocketFactory;
}

export interface CreateBrowserBbSdkArgs extends CreateBrowserTransportArgs {
  context?: BbSdkContext;
}

export type BrowserBbSdk = BbSdkAreas;

export function createBrowserTransport(
  args: CreateBrowserTransportArgs = {},
): BbSdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl,
    fetch: args.fetch,
    realtimeUrl: args.realtimeUrl,
    runtime: "browser",
    websocket: args.websocket,
  });
}

export function createBrowserBbSdk(
  args: CreateBrowserBbSdkArgs = {},
): BrowserBbSdk {
  return createBbSdk({
    context: args.context,
    transport: createBrowserTransport(args),
  });
}

export const bb = createBrowserBbSdk();

export { BbHttpError, BbRequestTimeoutError } from "./response.js";
export type { BbHttpErrorArgs } from "./response.js";
export { createBbSdk, createBuiltinPlanCommandTextInput, createHttpTransport };
export type { BbSdk, BbSdkAreas, BbSdkContext, BbSdkTransport };
export type * from "./areas/skills.js";
export type * from "./public-types.js";
