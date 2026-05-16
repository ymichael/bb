import { z } from "zod";

export const featureFlagsSchema = z.object({
  askUserQuestion: z.boolean(),
  terminals: z.boolean(),
});
export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

export const defaultFeatureFlags: FeatureFlags = {
  askUserQuestion: false,
  terminals: false,
};
