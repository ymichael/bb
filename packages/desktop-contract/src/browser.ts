import { z } from "zod";

export const BB_DESKTOP_BROWSER_MAX_URL_LENGTH = 4096;
export const BB_DESKTOP_BROWSER_MAX_TITLE_LENGTH = 1024;

export const bbDesktopBrowserTargetSchema = z
  .object({
    hostId: z.string().min(1),
    instanceId: z.string().min(1),
    generation: z.string().min(1),
  })
  .strict();
export type BbDesktopBrowserTarget = z.infer<
  typeof bbDesktopBrowserTargetSchema
>;

export const bbDesktopBrowserControlSchema = z
  .object({
    leaseId: z.string().min(1),
    controllerLabel: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type BbDesktopBrowserControl = z.infer<
  typeof bbDesktopBrowserControlSchema
>;
export const bbDesktopBrowserControlStateSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    control: bbDesktopBrowserControlSchema.nullable(),
  })
  .strict();
export type BbDesktopBrowserControlState = z.infer<
  typeof bbDesktopBrowserControlStateSchema
>;
export const bbDesktopBrowserRevealRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    desktopTarget: bbDesktopBrowserTargetSchema,
  })
  .strict();
export type BbDesktopBrowserRevealRequest = z.infer<
  typeof bbDesktopBrowserRevealRequestSchema
>;

const bbDesktopBrowserViewBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  })
  .strict();
export type BbDesktopBrowserViewBounds = z.infer<
  typeof bbDesktopBrowserViewBoundsSchema
>;

export interface BbDesktopBrowserViewportBounds {
  width: number;
  height: number;
}

interface ClampIntegerToRangeArgs {
  max: number;
  min: number;
  value: number;
}

interface ClampBbDesktopBrowserViewBoundsArgs {
  bounds: BbDesktopBrowserViewBounds;
  viewport: BbDesktopBrowserViewportBounds;
}

function clampIntegerToRange(args: ClampIntegerToRangeArgs): number {
  return Math.min(Math.max(args.value, args.min), args.max);
}

export function clampBbDesktopBrowserViewBounds(
  args: ClampBbDesktopBrowserViewBoundsArgs,
): BbDesktopBrowserViewBounds {
  const viewportRight = Math.max(0, Math.round(args.viewport.width));
  const viewportBottom = Math.max(0, Math.round(args.viewport.height));
  const x = clampIntegerToRange({
    value: args.bounds.x,
    min: 0,
    max: viewportRight,
  });
  const y = clampIntegerToRange({
    value: args.bounds.y,
    min: 0,
    max: viewportBottom,
  });
  const right = clampIntegerToRange({
    value: args.bounds.x + args.bounds.width,
    min: x,
    max: viewportRight,
  });
  const bottom = clampIntegerToRange({
    value: args.bounds.y + args.bounds.height,
    min: y,
    max: viewportBottom,
  });

  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

export const bbDesktopBrowserAttachRequestSchema = z
  .object({
    tabId: z.string().min(1),
    threadId: z.string().min(1),
    url: z.string().max(BB_DESKTOP_BROWSER_MAX_URL_LENGTH),
    existingOnly: z.literal(true).optional(),
    bounds: bbDesktopBrowserViewBoundsSchema,
    visible: z.boolean(),
  })
  .strict();
export type BbDesktopBrowserAttachRequest = z.infer<
  typeof bbDesktopBrowserAttachRequestSchema
>;

export const bbDesktopBrowserNavigateRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(BB_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type BbDesktopBrowserNavigateRequest = z.infer<
  typeof bbDesktopBrowserNavigateRequestSchema
>;

export const bbDesktopBrowserSetBoundsRequestSchema = z
  .object({
    tabId: z.string().min(1),
    bounds: bbDesktopBrowserViewBoundsSchema,
  })
  .strict();
export type BbDesktopBrowserSetBoundsRequest = z.infer<
  typeof bbDesktopBrowserSetBoundsRequestSchema
>;

export const bbDesktopBrowserSetVisibleRequestSchema = z
  .object({
    tabId: z.string().min(1),
    visible: z.boolean(),
  })
  .strict();
export type BbDesktopBrowserSetVisibleRequest = z.infer<
  typeof bbDesktopBrowserSetVisibleRequestSchema
>;

export const bbDesktopBrowserTabRefSchema = z
  .object({
    tabId: z.string().min(1),
  })
  .strict();
export type BbDesktopBrowserTabRef = z.infer<
  typeof bbDesktopBrowserTabRefSchema
>;

export const bbDesktopBrowserStateSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().max(BB_DESKTOP_BROWSER_MAX_URL_LENGTH),
    title: z.string().max(BB_DESKTOP_BROWSER_MAX_TITLE_LENGTH).nullable(),
    isLoading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    errorText: z.string().max(BB_DESKTOP_BROWSER_MAX_TITLE_LENGTH).nullable(),
  })
  .strict();
export type BbDesktopBrowserState = z.infer<typeof bbDesktopBrowserStateSchema>;

export const bbDesktopBrowserOpenTabRequestSchema = z
  .object({
    url: z.string().min(1).max(BB_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type BbDesktopBrowserOpenTabRequest = z.infer<
  typeof bbDesktopBrowserOpenTabRequestSchema
>;

export const bbDesktopBrowserScopedOpenTabRequestSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1).max(BB_DESKTOP_BROWSER_MAX_URL_LENGTH),
  })
  .strict();
export type BbDesktopBrowserScopedOpenTabRequest = z.infer<
  typeof bbDesktopBrowserScopedOpenTabRequestSchema
>;

const BB_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH = 8_388_608;

export const bbDesktopBrowserSnapshotSchema = z
  .object({
    tabId: z.string().min(1),
    dataUrl: z
      .string()
      .max(BB_DESKTOP_BROWSER_MAX_SNAPSHOT_DATA_URL_LENGTH)
      .nullable(),
  })
  .strict();
export type BbDesktopBrowserSnapshot = z.infer<
  typeof bbDesktopBrowserSnapshotSchema
>;

export const BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH = 1024;

export const bbDesktopBrowserFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    text: z.string().min(1).max(BB_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH),
    forward: z.boolean(),
    newSession: z.boolean(),
  })
  .strict();
export type BbDesktopBrowserFindInPageRequest = z.infer<
  typeof bbDesktopBrowserFindInPageRequestSchema
>;

export const bbDesktopBrowserStopFindInPageRequestSchema = z
  .object({
    tabId: z.string().min(1),
    action: z.enum(["clearSelection", "keepSelection", "activateSelection"]),
  })
  .strict();
export type BbDesktopBrowserStopFindInPageRequest = z.infer<
  typeof bbDesktopBrowserStopFindInPageRequestSchema
>;

export const bbDesktopBrowserFindResultSchema = z
  .object({
    tabId: z.string().min(1),
    requestId: z.number().int(),
    activeMatchOrdinal: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
    finalUpdate: z.boolean(),
  })
  .strict();
export type BbDesktopBrowserFindResult = z.infer<
  typeof bbDesktopBrowserFindResultSchema
>;

export type BbDesktopBrowserStateHandler = (
  state: BbDesktopBrowserState,
) => void;
export type BbDesktopBrowserOpenTabHandler = (
  request: BbDesktopBrowserOpenTabRequest,
) => void;
export type BbDesktopBrowserScopedOpenTabHandler = (
  request: BbDesktopBrowserScopedOpenTabRequest,
) => void;
export type BbDesktopBrowserSnapshotHandler = (
  snapshot: BbDesktopBrowserSnapshot,
) => void;
export type BbDesktopBrowserFocusHandler = (tabId: string) => void;
export type BbDesktopBrowserFindResultHandler = (
  result: BbDesktopBrowserFindResult,
) => void;
export type BbDesktopBrowserUnsubscribe = () => void;

export interface BbDesktopBrowserApi {
  getTarget?(): Promise<BbDesktopBrowserTarget | null>;
  getControl?(tabId: string): Promise<BbDesktopBrowserControlState | null>;
  releaseControl?(tabId: string): void;
  onControl?(
    listener: (state: BbDesktopBrowserControlState) => void,
  ): BbDesktopBrowserUnsubscribe;
  onReveal?(
    listener: (request: BbDesktopBrowserRevealRequest) => void,
  ): BbDesktopBrowserUnsubscribe;
  attach(request: BbDesktopBrowserAttachRequest): void;
  detach(tabId: string): void;
  navigate(request: BbDesktopBrowserNavigateRequest): void;
  goBack(tabId: string): void;
  goForward(tabId: string): void;
  reload(tabId: string): void;
  stop(tabId: string): void;
  focus?(tabId: string): void;
  setBounds(request: BbDesktopBrowserSetBoundsRequest): void;
  setVisible(request: BbDesktopBrowserSetVisibleRequest): void;
  setVisibleWithoutFocus?(request: BbDesktopBrowserSetVisibleRequest): void;
  onState(listener: BbDesktopBrowserStateHandler): BbDesktopBrowserUnsubscribe;
  onOpenTab(
    listener: BbDesktopBrowserOpenTabHandler,
  ): BbDesktopBrowserUnsubscribe;
  onScopedOpenTab?(
    listener: BbDesktopBrowserScopedOpenTabHandler,
  ): BbDesktopBrowserUnsubscribe;
  onFocus?(listener: BbDesktopBrowserFocusHandler): BbDesktopBrowserUnsubscribe;
  onSnapshot?(
    listener: BbDesktopBrowserSnapshotHandler,
  ): BbDesktopBrowserUnsubscribe;
  findInPage?(request: BbDesktopBrowserFindInPageRequest): void;
  stopFindInPage?(request: BbDesktopBrowserStopFindInPageRequest): void;
  onFindResult?(
    listener: BbDesktopBrowserFindResultHandler,
  ): BbDesktopBrowserUnsubscribe;
}
