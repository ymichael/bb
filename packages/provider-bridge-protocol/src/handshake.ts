import { providerForkSchema } from "@bb/domain";
import { z } from "zod";
import { PROVIDER_BRIDGE_PROTOCOL_VERSION } from "./version.js";

export const bridgeGrammarVersionsSchema = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([min, max]) => min <= max, {
    message: "grammarVersions must be an ascending [min, max] range",
  });
export type BridgeGrammarVersions = z.infer<typeof bridgeGrammarVersionsSchema>;

export function negotiateGrammarVersion(
  runtime: BridgeGrammarVersions,
  bridge: BridgeGrammarVersions,
): number | null {
  const min = Math.max(runtime[0], bridge[0]);
  const max = Math.min(runtime[1], bridge[1]);
  return min <= max ? max : null;
}

export const bridgeSteerModeSchema = z.enum(["inject", "queue"]);
export type BridgeSteerMode = z.infer<typeof bridgeSteerModeSchema>;

export const bridgeCapabilitiesSchema = z
  .object({
    sessionRestore: z.boolean().default(false),
    threadArchive: z.boolean().default(false),
    threadRename: z.boolean().default(false),
    threadGoalClear: z.boolean().default(false),
    fork: providerForkSchema.default("none"),
    approvalEnforcedBy: z.enum(["runtime", "provider"]).default("runtime"),
    grammarVersions: bridgeGrammarVersionsSchema.default([
      PROVIDER_BRIDGE_PROTOCOL_VERSION,
      PROVIDER_BRIDGE_PROTOCOL_VERSION,
    ]),
    steerMode: bridgeSteerModeSchema.default("queue"),
    skills: z
      .object({ configure: z.boolean().default(false) })
      .default({ configure: false }),
  })
  .passthrough();

export type BridgeCapabilities = z.infer<typeof bridgeCapabilitiesSchema>;

export const initializeParamsSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    client: z.object({ name: z.string().min(1), version: z.string().min(1) }),
    grammarVersions: bridgeGrammarVersionsSchema.default([
      PROVIDER_BRIDGE_PROTOCOL_VERSION,
      PROVIDER_BRIDGE_PROTOCOL_VERSION,
    ]),
  })
  .passthrough();

export const initializeResultSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    capabilities: z.preprocess(
      (value) => value ?? {},
      bridgeCapabilitiesSchema,
    ),
  })
  .passthrough();

export type InitializeResult = z.infer<typeof initializeResultSchema>;
