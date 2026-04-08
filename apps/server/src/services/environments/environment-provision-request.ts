import { z } from "zod";
import { environmentProvisionCommandSchema } from "@bb/host-daemon-contract";

export const directEnvironmentProvisionRequestSchema = z.object({
  mode: z.literal("direct"),
  command: environmentProvisionCommandSchema,
});
export type DirectEnvironmentProvisionRequest = z.infer<
  typeof directEnvironmentProvisionRequestSchema
>;

export const sandboxHostEnvironmentProvisionRequestSchema = z.object({
  mode: z.literal("sandbox-host"),
  sandboxType: z.string(),
  command: environmentProvisionCommandSchema,
});
export type SandboxHostEnvironmentProvisionRequest = z.infer<
  typeof sandboxHostEnvironmentProvisionRequestSchema
>;

export const wrappedEnvironmentProvisionRequestSchema = z.discriminatedUnion(
  "mode",
  [
    directEnvironmentProvisionRequestSchema,
    sandboxHostEnvironmentProvisionRequestSchema,
  ],
);

export type EnvironmentProvisionRequest =
  | DirectEnvironmentProvisionRequest
  | SandboxHostEnvironmentProvisionRequest;

export const environmentProvisionRequestSchema = z.union([
  environmentProvisionCommandSchema,
  wrappedEnvironmentProvisionRequestSchema,
]);

export function buildDirectEnvironmentProvisionRequest(
  command: typeof environmentProvisionCommandSchema._type,
): DirectEnvironmentProvisionRequest {
  return {
    mode: "direct",
    command,
  };
}

export function buildSandboxHostEnvironmentProvisionRequest(args: {
  command: typeof environmentProvisionCommandSchema._type;
  sandboxType: string;
}): SandboxHostEnvironmentProvisionRequest {
  return {
    mode: "sandbox-host",
    sandboxType: args.sandboxType,
    command: args.command,
  };
}

export function normalizeEnvironmentProvisionRequest(
  payload: z.infer<typeof environmentProvisionRequestSchema>,
): EnvironmentProvisionRequest {
  if ("type" in payload) {
    return buildDirectEnvironmentProvisionRequest(payload);
  }

  return payload;
}
