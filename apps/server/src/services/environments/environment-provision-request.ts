import { z } from "zod";
import { environmentProvisionCommandSchema } from "@bb/host-daemon-contract";
import type { EnvironmentProvisionCommand } from "@bb/host-daemon-contract";

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

export const environmentProvisionRequestSchema = z.discriminatedUnion("mode", [
  directEnvironmentProvisionRequestSchema,
  sandboxHostEnvironmentProvisionRequestSchema,
]);

export type EnvironmentProvisionRequest =
  | DirectEnvironmentProvisionRequest
  | SandboxHostEnvironmentProvisionRequest;

export function buildDirectEnvironmentProvisionRequest(
  command: EnvironmentProvisionCommand,
): DirectEnvironmentProvisionRequest {
  return {
    mode: "direct",
    command,
  };
}

export function buildSandboxHostEnvironmentProvisionRequest(args: {
  command: EnvironmentProvisionCommand;
  sandboxType: string;
}): SandboxHostEnvironmentProvisionRequest {
  return {
    mode: "sandbox-host",
    sandboxType: args.sandboxType,
    command: args.command,
  };
}
