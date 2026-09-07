import { z } from "zod";
import { MOBILE_BRIDGE_VERSION } from "./version.js";

export const safeAreaInsetsSchema = z
  .object({
    top: z.number().nonnegative(),
    right: z.number().nonnegative(),
    bottom: z.number().nonnegative(),
    left: z.number().nonnegative(),
  })
  .strict();

export type SafeAreaInsets = z.infer<typeof safeAreaInsetsSchema>;

export const NATIVE_CAPABILITIES = [
  "haptic",
  "badge",
  "share",
  "open-external",
  "safe-area",
  "open-native",
] as const;

export const nativeCapabilitySchema = z.enum(NATIVE_CAPABILITIES);
export type NativeCapability = z.infer<typeof nativeCapabilitySchema>;

export const nativeShellHandshakeSchema = z
  .object({
    bridgeVersion: z.number().int().positive(),
    appVersion: z.string().min(1),
    platform: z.enum(["ios", "android"]),
    profileMode: z.enum(["direct", "connect"]),
    secureContext: z.boolean(),
    safeArea: safeAreaInsetsSchema,
    capabilities: z.array(nativeCapabilitySchema).readonly(),
  })
  .strict();

export type NativeShellHandshake = z.infer<typeof nativeShellHandshakeSchema>;

export function parseNativeShellHandshake(
  value: unknown,
): NativeShellHandshake | null {
  const parsed = nativeShellHandshakeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function currentBridgeVersion(): number {
  return MOBILE_BRIDGE_VERSION;
}
