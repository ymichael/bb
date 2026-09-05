import type { PluginEnvironmentProviderProgress } from "@get-bb/plugin-sdk/environment-provider";
import { z } from "zod";
import type { ProgressCallback } from "./transcript.js";

export const environmentHostProgressSchema = z
  .object({
    operationId: z.string().min(1),
    type: z.enum(["step", "output"]),
    text: z.string(),
    status: z.enum(["started", "completed", "failed"]).nullable(),
  })
  .strict();

export type EnvironmentHostProgress = z.infer<
  typeof environmentHostProgressSchema
>;

export function createHostProgress(args: {
  operationId: string;
  emit: (progress: EnvironmentHostProgress) => Promise<void>;
}): ProgressCallback {
  return (entry) => {
    void args
      .emit({
        operationId: args.operationId,
        type: entry.type,
        text: entry.text,
        status: entry.status ?? null,
      })
      .catch(() => undefined);
  };
}

export function reportHostProgress(
  report: PluginEnvironmentProviderProgress,
  progress: EnvironmentHostProgress,
): void {
  if (progress.type === "output") {
    report.log(progress.text);
  } else if (progress.status !== "failed") {
    report.step(progress.text);
  }
}
