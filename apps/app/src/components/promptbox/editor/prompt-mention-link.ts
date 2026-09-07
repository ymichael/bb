import { createContext } from "react";
import type { PromptMentionResource } from "@bb/domain";

export type PromptMentionLinkResolver = (
  resource: PromptMentionResource,
) => (() => void) | null;

export const PromptMentionLinkContext =
  createContext<PromptMentionLinkResolver | null>(null);
