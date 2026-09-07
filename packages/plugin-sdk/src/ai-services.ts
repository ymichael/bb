/**
 * `@get-bb/plugin-sdk/ai-services` — the contract between bb's AI-services
 * feature (server-side helper inference: thread titles, commit messages;
 * voice transcription) and a plugin that serves them from a host.
 *
 * A plugin registers one or more services with
 * `bb.experimental_aiServices.register({ id, displayName, kinds })` in its
 * `server.ts`, and implements the methods below in its `bb.host` entry
 * (`experimental_defineHostEntry({ contract: experimental_aiServicesHostContract, ... })`).
 * Core routes the user's configured `BB_INFERENCE` / `BB_TRANSCRIPTION`
 * (`<serviceId>/<model>`) to the plugin that registered `serviceId` and calls
 * the method on the primary host. The `serviceId` travels on every call so one
 * plugin can serve several services from one host entry.
 *
 * Failures are part of the result, not thrown: a thrown error reaches core as
 * an opaque transport failure, while a `{ ok: false, code }` result lets core
 * apply its retry and fallback policy (timeouts and rate limits fall back to
 * the configured fallback model; auth failures do not).
 */
import { z } from "zod";
import { jsonObjectSchema } from "@bb/domain";
import { defineRpcContract } from "./rpc-contract.js";

/** Why a call did not produce a result; core's retry policy keys on it. */
export const experimental_aiServiceErrorCodeSchema = z.enum([
  /** The service did not answer within the request's `timeoutMs`. */
  "timeout",
  /** The upstream rejected the request for rate or quota reasons; retryable. */
  "rate_limited",
  /** The upstream is down or overloaded; retryable. */
  "service_unavailable",
  /** No usable credentials on this host; the user must sign in. Not retryable. */
  "auth_required",
  /** The upstream rejected the request (bad model, bad input, policy). Not retryable. */
  "request_failed",
  /** The upstream answered, but not with something that satisfies the request. */
  "invalid_response",
]);
export type ExperimentalAiServiceErrorCode = z.infer<
  typeof experimental_aiServiceErrorCodeSchema
>;

const failureSchema = z
  .object({
    ok: z.literal(false),
    code: experimental_aiServiceErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();

export const experimental_aiInferenceCompleteInputSchema = z
  .object({
    serviceId: z.string().min(1),
    /** The model segment of the user's `<serviceId>/<model>` setting. */
    model: z.string().min(1),
    /** Helper inference is short and latency-bound; no reasoning. */
    reasoningEffort: z.literal("none"),
    prompt: z.string().min(1),
    /** A JSON Schema object the structured result must satisfy. */
    outputSchema: jsonObjectSchema,
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ExperimentalAiInferenceCompleteInput = z.infer<
  typeof experimental_aiInferenceCompleteInputSchema
>;

export const experimental_aiInferenceCompleteOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      model: z.string().min(1),
      value: jsonObjectSchema,
    })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiInferenceCompleteOutput = z.infer<
  typeof experimental_aiInferenceCompleteOutputSchema
>;

export const experimental_aiVoiceTranscribeInputSchema = z
  .object({
    serviceId: z.string().min(1),
    model: z.string().min(1),
    audioBase64: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().min(1),
    prompt: z.string().nullable(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ExperimentalAiVoiceTranscribeInput = z.infer<
  typeof experimental_aiVoiceTranscribeInputSchema
>;

export const experimental_aiVoiceTranscribeOutputSchema = z.union([
  z
    .object({ ok: z.literal(true), model: z.string().min(1), text: z.string() })
    .strict(),
  failureSchema,
]);
export type ExperimentalAiVoiceTranscribeOutput = z.infer<
  typeof experimental_aiVoiceTranscribeOutputSchema
>;

/**
 * The host RPC methods an AI-service plugin implements. A plugin that
 * registers only `inference` still builds against the full contract; the
 * unregistered method may answer `{ ok: false, code: "request_failed" }`.
 */
export const experimental_aiServicesHostContract = defineRpcContract({
  "ai.inference.complete": {
    input: experimental_aiInferenceCompleteInputSchema,
    output: experimental_aiInferenceCompleteOutputSchema,
  },
  "ai.voice.transcribe": {
    input: experimental_aiVoiceTranscribeInputSchema,
    output: experimental_aiVoiceTranscribeOutputSchema,
  },
});
export type ExperimentalAiServicesHostContract =
  typeof experimental_aiServicesHostContract;
