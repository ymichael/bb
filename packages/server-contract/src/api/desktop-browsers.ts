import { desktopBrowserNavigationUrlSchema } from "@bb/host-daemon-contract";
import { z } from "zod";

const id = z.string().min(1).max(256);

export const desktopBrowserHostRequestSchema = z
  .object({ hostId: id })
  .strict();
export const desktopBrowserScopeSchema = desktopBrowserHostRequestSchema
  .extend({
    instanceId: id,
    generation: id,
    threadId: id,
  })
  .strict();
export const desktopBrowserTabRequestSchema = desktopBrowserScopeSchema
  .extend({ tabId: id })
  .strict();
export const desktopBrowserCreateRequestSchema = desktopBrowserScopeSchema
  .extend({
    url: desktopBrowserNavigationUrlSchema
      .pipe(z.string().max(4096))
      .default("about:blank"),
    presentation: z.enum(["hidden", "reveal"]).default("hidden"),
  })
  .strict();
export const desktopBrowserAcquireRequestSchema = desktopBrowserScopeSchema
  .extend({
    tabIds: z
      .array(id)
      .min(1)
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length),
    controllerLabel: z.string().trim().min(1).max(100),
    ttlMs: z.number().int().min(1000).max(1800000).default(300000),
    allowPersonal: z.boolean().default(false),
  })
  .strict();
export const desktopBrowserLeaseRequestSchema = desktopBrowserScopeSchema
  .extend({ leaseId: id })
  .strict();

export type ExperimentalDesktopBrowserHostRequest = z.infer<
  typeof desktopBrowserHostRequestSchema
>;
export type ExperimentalDesktopBrowserScope = z.infer<
  typeof desktopBrowserScopeSchema
>;
export type ExperimentalDesktopBrowserTabRequest = z.infer<
  typeof desktopBrowserTabRequestSchema
>;
export type ExperimentalDesktopBrowserCreateRequest = z.infer<
  typeof desktopBrowserCreateRequestSchema
>;
export type ExperimentalDesktopBrowserAcquireRequest = z.infer<
  typeof desktopBrowserAcquireRequestSchema
>;
export type ExperimentalDesktopBrowserLeaseRequest = z.infer<
  typeof desktopBrowserLeaseRequestSchema
>;

export type ExperimentalDesktopBrowserCreateInput = z.input<
  typeof desktopBrowserCreateRequestSchema
>;
export type ExperimentalDesktopBrowserAcquireInput = z.input<
  typeof desktopBrowserAcquireRequestSchema
>;
export type ExperimentalDesktopBrowserLease =
  ExperimentalDesktopBrowserScope & {
    leaseId: string;
    tabIds: string[];
    controllerLabel: string;
    expiresAt: number;
  };
export type ExperimentalDesktopBrowserInstances = {
  instances: (import("@bb/host-daemon-contract").DesktopBrowserInstance & {
    hostId: string;
  })[];
};
export type ExperimentalDesktopBrowserTabs =
  import("@bb/host-daemon-contract").DesktopBrowserResult<"desktop.browser.list_tabs">;
export type ExperimentalDesktopBrowserCreated =
  import("@bb/host-daemon-contract").DesktopBrowserResult<"desktop.browser.create_tab">;
export type ExperimentalDesktopBrowserCapture =
  import("@bb/host-daemon-contract").DesktopBrowserResult<"desktop.browser.capture_tab">;
export type ExperimentalDesktopBrowserConnection = {
  hostId: string;
  wsEndpoint: string;
  expiresAt: number;
};
