import { promptInputSchema } from "@bb/domain";
import type { PromptInput, ThreadQueuedMessage } from "@bb/domain";
import { z } from "zod";

interface StoredDraftRow {
  content: string;
  createdAt: number;
  id: string;
  mode: string;
  reasoningLevel: string;
  sandboxMode: string;
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
    mode: row.mode === "start" || row.mode === "steer" ? row.mode : "auto",
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
