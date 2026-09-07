import { z } from "zod";

export const HAPTIC_KINDS = [
  "selection",
  "impact-light",
  "impact-medium",
  "impact-heavy",
  "success",
  "warning",
  "error",
] as const;

export const hapticKindSchema = z.enum(HAPTIC_KINDS);
export type BridgeHapticKind = z.infer<typeof hapticKindSchema>;

const httpUrlSchema = z.string().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "url must be http or https");

const sharePayloadSchema = z
  .object({
    title: z.string().max(200).optional(),
    text: z.string().max(4000).optional(),
    url: httpUrlSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.text !== undefined || value.url !== undefined,
    "A share needs text or a url",
  );

export type BridgeSharePayload = z.infer<typeof sharePayloadSchema>;

const bridgeRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("share"), payload: sharePayloadSchema }).strict(),
]);

export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeRequestKind = BridgeRequest["kind"];

export const NATIVE_SCREENS = ["device-settings"] as const;
export const nativeScreenSchema = z.enum(NATIVE_SCREENS);
export type NativeScreen = z.infer<typeof nativeScreenSchema>;

export const pageToShellMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), path: z.string() }).strict(),
  z
    .object({
      type: z.literal("title"),
      title: z.string().max(300),
      path: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("haptic"), kind: hapticKindSchema }).strict(),
  z
    .object({ type: z.literal("badge"), count: z.number().int().min(0) })
    .strict(),
  z.object({ type: z.literal("open-external"), url: httpUrlSchema }).strict(),
  z
    .object({ type: z.literal("open-native"), screen: nativeScreenSchema })
    .strict(),
  z
    .object({
      type: z.literal("request"),
      id: z.string().min(1).max(64),
      request: bridgeRequestSchema,
    })
    .strict(),
]);

export type PageToShellMessage = z.infer<typeof pageToShellMessageSchema>;
export type PageToShellMessageType = PageToShellMessage["type"];

export type ParsedPageMessage =
  | { ok: true; message: PageToShellMessage }
  | { ok: false; reason: string };

export function parsePageToShellMessage(raw: unknown): ParsedPageMessage {
  if (typeof raw !== "string") {
    return { ok: false, reason: "message was not a string" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "message was not JSON" };
  }
  const parsed = pageToShellMessageSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "unknown" };
  }
  return { ok: true, message: parsed.data };
}
