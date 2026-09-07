import { providerRecoveryKindSchema } from "@bb/domain";
import { z } from "zod";

export const BRIDGE_JSON_RPC_ERRORS = {
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  BRIDGE_ERROR: -32000,
  NO_ACTIVE_TURN: -32001,
  SESSION_NOT_RESTORABLE: -32002,
  FORK_CHECKPOINT_UNSUPPORTED: -32003,
} as const;

export const providerRecoveryHintSchema = z.object({
  kind: providerRecoveryKindSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type ProviderRecoveryHint = z.infer<typeof providerRecoveryHintSchema>;

export const bridgeErrorDataSchema = z
  .object({ recovery: providerRecoveryHintSchema.optional() })
  .passthrough();
export type BridgeErrorData = z.infer<typeof bridgeErrorDataSchema>;
