import { z } from "zod";

const id = z.string().min(1).max(256);
export const desktopBrowserInstanceSchema = z.object({
  instanceId: id,
  generation: id,
  label: z.string().min(1).max(256),
});
export const desktopBrowserProfileSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("automation"), id }),
  z.object({ kind: z.literal("personal") }),
]);
export const desktopBrowserLeaseSchema = z.object({
  leaseId: id,
  controllerLabel: z.string().min(1).max(256),
  expiresAt: z.number().int().positive(),
});
export type DesktopBrowserLease = z.infer<typeof desktopBrowserLeaseSchema>;
export const desktopBrowserTabSchema = z.object({
  tabId: id,
  threadId: id,
  url: z.string().max(32768),
  title: z.string().max(8192),
  control: desktopBrowserLeaseSchema.nullable(),
  profile: desktopBrowserProfileSchema,
  presentation: z.enum(["hidden", "reveal"]),
});
const target = { instanceId: id, generation: id, threadId: id };
const tabTarget = { ...target, tabId: id };
const leaseTarget = { ...target, leaseId: id };
const tabIds = z
  .array(id)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);
export const desktopBrowserNavigationUrlSchema = z
  .string()
  .max(32768)
  .refine((value) => {
    if (value === "about:blank") return true;
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Expected an HTTP(S) URL or about:blank");
export const desktopBrowserCommandSchemas = {
  "desktop.browser.list_instances": z
    .object({ type: z.literal("desktop.browser.list_instances") })
    .strict(),
  "desktop.browser.list_tabs": z
    .object({ type: z.literal("desktop.browser.list_tabs"), ...target })
    .strict(),
  "desktop.browser.create_tab": z
    .object({
      type: z.literal("desktop.browser.create_tab"),
      ...tabTarget,
      url: desktopBrowserNavigationUrlSchema,
      profile: desktopBrowserProfileSchema,
      presentation: z.enum(["hidden", "reveal"]),
    })
    .strict(),
  "desktop.browser.reveal_tab": z
    .object({ type: z.literal("desktop.browser.reveal_tab"), ...tabTarget })
    .strict(),
  "desktop.browser.close_tab": z
    .object({ type: z.literal("desktop.browser.close_tab"), ...tabTarget })
    .strict(),
  "desktop.browser.capture_tab": z
    .object({ type: z.literal("desktop.browser.capture_tab"), ...tabTarget })
    .strict(),
  "desktop.browser.acquire_control": z
    .object({
      type: z.literal("desktop.browser.acquire_control"),
      ...leaseTarget,
      tabIds,
      controllerLabel: z.string().min(1).max(256),
      expiresAt: z.number().int().positive(),
    })
    .strict(),
  "desktop.browser.open_connection": z
    .object({
      type: z.literal("desktop.browser.open_connection"),
      ...leaseTarget,
      tabIds,
    })
    .strict(),
  "desktop.browser.release_control": z
    .object({
      type: z.literal("desktop.browser.release_control"),
      ...leaseTarget,
    })
    .strict(),
};
export const desktopBrowserCommandSchema = z.discriminatedUnion("type", [
  desktopBrowserCommandSchemas["desktop.browser.list_instances"],
  desktopBrowserCommandSchemas["desktop.browser.list_tabs"],
  desktopBrowserCommandSchemas["desktop.browser.create_tab"],
  desktopBrowserCommandSchemas["desktop.browser.reveal_tab"],
  desktopBrowserCommandSchemas["desktop.browser.close_tab"],
  desktopBrowserCommandSchemas["desktop.browser.capture_tab"],
  desktopBrowserCommandSchemas["desktop.browser.acquire_control"],
  desktopBrowserCommandSchemas["desktop.browser.open_connection"],
  desktopBrowserCommandSchemas["desktop.browser.release_control"],
]);
const ok = z.object({ ok: z.literal(true) });
export const desktopBrowserResultSchemas = {
  "desktop.browser.list_instances": z.object({
    instances: z.array(desktopBrowserInstanceSchema).max(100),
  }),
  "desktop.browser.list_tabs": z.object({
    tabs: z.array(desktopBrowserTabSchema).max(1000),
  }),
  "desktop.browser.create_tab": z.object({ tab: desktopBrowserTabSchema }),
  "desktop.browser.reveal_tab": ok,
  "desktop.browser.close_tab": ok,
  "desktop.browser.capture_tab": z.object({
    mimeType: z.literal("image/jpeg"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    base64: z.string().max(16 * 1024 * 1024),
  }),
  "desktop.browser.acquire_control": z.object({
    lease: desktopBrowserLeaseSchema,
  }),
  "desktop.browser.open_connection": z.object({
    expiresAt: z.number().int().positive(),
    wsEndpoint: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "ws:" &&
          url.hostname === "127.0.0.1" &&
          !url.username &&
          !url.password
        );
      }),
  }),
  "desktop.browser.release_control": ok,
};
export type DesktopBrowserCommand = z.infer<typeof desktopBrowserCommandSchema>;
export type DesktopBrowserCommandType = DesktopBrowserCommand["type"];
export type DesktopBrowserResult<
  T extends DesktopBrowserCommandType = DesktopBrowserCommandType,
> = z.infer<(typeof desktopBrowserResultSchemas)[T]>;
export type DesktopBrowserInstance = z.infer<
  typeof desktopBrowserInstanceSchema
>;
export type DesktopBrowserTab = z.infer<typeof desktopBrowserTabSchema>;
export type DesktopBrowserProfile = z.infer<typeof desktopBrowserProfileSchema>;

export const DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE =
  "desktop-browser-broker.json";
export const desktopBrowserBrokerDescriptorSchema = z
  .object({
    version: z.literal(1),
    hostId: id,
    serverUrl: z.string().url(),
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "ws:" &&
          url.hostname === "127.0.0.1" &&
          url.pathname === "/desktop-browser" &&
          !url.username &&
          !url.password
        );
      }),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type DesktopBrowserBrokerDescriptor = z.infer<
  typeof desktopBrowserBrokerDescriptorSchema
>;
export const desktopBrowserRegistrationSchema = z
  .object({
    type: z.literal("register"),
    hostId: id,
    serverUrl: z.string().url(),
    instances: z.array(desktopBrowserInstanceSchema).max(100),
  })
  .strict();
export const desktopBrowserBrokerRequestSchema = z
  .object({
    type: z.literal("request"),
    requestId: id,
    command: desktopBrowserCommandSchema,
  })
  .strict();
export type DesktopBrowserBrokerRequest = z.infer<
  typeof desktopBrowserBrokerRequestSchema
>;
export const desktopBrowserBrokerResponseSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("result"), requestId: id, result: z.unknown() })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      requestId: id,
      message: z.string().max(8192),
    })
    .strict(),
]);

export const desktopBrowserChangedSchema = z
  .object({
    type: z.literal("desktop-browser.changed"),
    instanceId: id,
    generation: id,
    threadId: id,
    tabs: z.array(desktopBrowserTabSchema).max(1000),
  })
  .strict();
export type DesktopBrowserChanged = z.infer<typeof desktopBrowserChangedSchema>;
