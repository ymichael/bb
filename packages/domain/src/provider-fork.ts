import { z } from "zod";

export const PROVIDER_FORK_VALUES = ["none", "tip", "checkpoint"] as const;

export const providerForkSchema = z.enum(PROVIDER_FORK_VALUES);

export type ProviderFork = (typeof PROVIDER_FORK_VALUES)[number];
