import { z } from "zod";

export const threadIdentityResultSchema = z.object({
  providerThreadId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
});

type ThreadIdentityResult = z.infer<typeof threadIdentityResultSchema>;

interface ResolveThreadIdentityResultArgs {
  result: ThreadIdentityResult;
  threadId: string;
}

export function resolveThreadIdentityResult(
  args: ResolveThreadIdentityResultArgs,
): string | undefined {
  if (args.result.providerThreadId) {
    return args.result.providerThreadId;
  }
  if (args.result.threadId && args.result.threadId !== args.threadId) {
    return args.result.threadId;
  }
  return undefined;
}
