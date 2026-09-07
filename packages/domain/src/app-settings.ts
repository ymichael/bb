import { z } from "zod";
import { isValidGitBranchName } from "./git-checkout.js";

export const MANAGED_BRANCH_PREFIX_MAX_LENGTH = 64;

export const DEFAULT_MANAGED_BRANCH_PREFIX = "bb/";

export const managedBranchPrefixSchema = z
  .string()
  .max(MANAGED_BRANCH_PREFIX_MAX_LENGTH)
  .refine((prefix) => isValidGitBranchName(`${prefix}slug-thr_id`), {
    message: "Prefix must start a valid git branch name",
  });

export const appSettingsSchema = z
  .object({
    showKeyboardHints: z.boolean(),
    steerActiveThreadOnEnter: z.boolean(),
    showUnhandledProviderEvents: z.boolean(),
    providerOrder: z.array(z.string().min(1)),
    defaultProviderId: z.string().min(1).nullable(),
    streamerMode: z.boolean(),
    managedBranchPrefix: managedBranchPrefixSchema,
  })
  .strict();
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultAppSettings: AppSettings = {
  showKeyboardHints: true,
  steerActiveThreadOnEnter: true,
  showUnhandledProviderEvents: false,
  providerOrder: [],
  defaultProviderId: null,
  streamerMode: false,
  managedBranchPrefix: DEFAULT_MANAGED_BRANCH_PREFIX,
};
