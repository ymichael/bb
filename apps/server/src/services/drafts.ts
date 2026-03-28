import { promptInputSchema } from "@bb/domain";
import type { PromptInput, ThreadQueuedMessage } from "@bb/domain";
import { z } from "zod";

interface StoredDraftRow {
  content: string;
  createdAt: number;
  id: string;
  model: string | null;
  reasoningLevel: string;
  sandboxMode: string;
  serviceTier: string | null;
  threadId: string;
  updatedAt: number;
}

export function encodeDraftContent(input: PromptInput[]): string {
  return JSON.stringify(input);
}

export function decodeDraftContent(content: string): PromptInput[] {
  const parsed = z.array(promptInputSchema).safeParse(JSON.parse(content));
  return parsed.success ? parsed.data : [];
}

export function toQueuedMessage(row: StoredDraftRow): ThreadQueuedMessage {
  return {
    id: row.id,
    content: decodeDraftContent(row.content),
    model: row.model ?? "gpt-5",
    reasoningLevel:
      row.reasoningLevel === "low" ||
      row.reasoningLevel === "medium" ||
      row.reasoningLevel === "high" ||
      row.reasoningLevel === "xhigh"
        ? row.reasoningLevel
        : "medium",
    sandboxMode:
      row.sandboxMode === "read-only" ||
      row.sandboxMode === "workspace-write" ||
      row.sandboxMode === "danger-full-access"
        ? row.sandboxMode
        : "danger-full-access",
    serviceTier: row.serviceTier === "fast" || row.serviceTier === "flex"
      ? row.serviceTier
      : "flex",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
