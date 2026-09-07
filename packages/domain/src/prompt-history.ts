import { z } from "zod";
import { promptInputSchema, type PromptInput } from "./shared-types.js";

export const PROMPT_HISTORY_ENTRY_LIMIT = 50;

const promptHistoryScopeValues = ["project", "thread"] as const;
const promptHistoryScopeSchema = z.enum(promptHistoryScopeValues);
export type PromptHistoryScope = z.infer<typeof promptHistoryScopeSchema>;

export const promptHistoryEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number(),
  input: z.array(promptInputSchema).min(1),
});
export type PromptHistoryEntry = z.infer<typeof promptHistoryEntrySchema>;

interface PromptHistoryComparableEntry {
  input: readonly PromptInput[];
}

interface TakeVisiblePromptHistoryEntriesArgs<
  TEntry extends PromptHistoryComparableEntry,
> {
  entries: readonly TEntry[];
  limit: number;
}

export function arePromptHistoryInputsEqual(
  left: readonly PromptInput[],
  right: readonly PromptInput[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function takeVisiblePromptHistoryEntries<
  TEntry extends PromptHistoryComparableEntry,
>({ entries, limit }: TakeVisiblePromptHistoryEntriesArgs<TEntry>): TEntry[] {
  if (limit <= 0 || entries.length === 0) {
    return [];
  }

  const visibleEntries: TEntry[] = [];
  for (const entry of entries) {
    const lastVisibleEntry = visibleEntries[visibleEntries.length - 1];
    if (
      lastVisibleEntry &&
      arePromptHistoryInputsEqual(lastVisibleEntry.input, entry.input)
    ) {
      continue;
    }

    visibleEntries.push(entry);
    if (visibleEntries.length >= limit) {
      break;
    }
  }

  return visibleEntries;
}
