import { normalizePromptTextMentions } from "@bb/client-core";
import type { ComponentType } from "react";
import type { Nodes, Parent, PhrasingContent, Text } from "mdast";
import type {} from "mdast-util-to-hast";
import { visit } from "unist-util-visit";
import type { PromptTextMention } from "@bb/domain";
import { PromptMentionPill } from "@/components/thread/timeline/ConversationMessageMentions.js";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { TimelineTitleLinkResolver } from "@/components/thread/timeline/TimelineTitleView.js";

const SENTINEL_OPEN = String.fromCharCode(0xe000);
const SENTINEL_CLOSE = String.fromCharCode(0xe001);
const PROMPT_MENTION_PATTERN = new RegExp(
  `${SENTINEL_OPEN}(\\d+)${SENTINEL_CLOSE}`,
  "gu",
);

const PROMPT_MENTION_HAST_NAME = "bb-prompt-mention";
const PROMPT_MENTION_INDEX_PROPERTY = "dataMentionIndex";

function promptMentionSentinel(index: number): string {
  return `${SENTINEL_OPEN}${index}${SENTINEL_CLOSE}`;
}

export interface IndexedPromptMention {
  resource: PromptTextMention["resource"];
  serializedText: string;
}

interface SubstitutePromptMentionsResult {
  content: string;
  mentions: IndexedPromptMention[];
}

export function substitutePromptMentions(
  text: string,
  mentions: readonly PromptTextMention[],
): SubstitutePromptMentionsResult {
  const normalized = normalizePromptTextMentions(mentions, text.length);
  if (normalized.length === 0) {
    return { content: text, mentions: [] };
  }

  const indexed: IndexedPromptMention[] = [];
  let content = "";
  let cursor = 0;
  for (const mention of normalized) {
    if (mention.start < cursor) {
      continue;
    }
    content += text.slice(cursor, mention.start);
    content += promptMentionSentinel(indexed.length);
    indexed.push({
      resource: mention.resource,
      serializedText: text.slice(mention.start, mention.end),
    });
    cursor = mention.end;
  }
  content += text.slice(cursor);
  return { content, mentions: indexed };
}

function promptMentionNode(index: number): Text {
  return {
    type: "text",
    value: "",
    data: {
      hName: PROMPT_MENTION_HAST_NAME,
      hProperties: { [PROMPT_MENTION_INDEX_PROPERTY]: index },
    },
  };
}

function splitTextNodeOnMentions(node: Text): PhrasingContent[] {
  const { value } = node;
  PROMPT_MENTION_PATTERN.lastIndex = 0;
  const replacements: PhrasingContent[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = PROMPT_MENTION_PATTERN.exec(value)) !== null) {
    const index = match[1] === undefined ? Number.NaN : Number(match[1]);
    if (!Number.isInteger(index)) {
      continue;
    }
    if (match.index > cursor) {
      replacements.push({
        type: "text",
        value: value.slice(cursor, match.index),
      });
    }
    replacements.push(promptMentionNode(index));
    cursor = match.index + match[0].length;
  }
  if (replacements.length === 0) {
    return [node];
  }
  if (cursor < value.length) {
    replacements.push({ type: "text", value: value.slice(cursor) });
  }
  return replacements;
}

export function remarkPromptMentions() {
  return (tree: Nodes): void => {
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (parent === undefined || index === undefined) {
        return;
      }
      const replacements = splitTextNodeOnMentions(node);
      if (replacements.length === 1 && replacements[0] === node) {
        return;
      }
      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
  };
}

export interface MarkdownPromptMentions {
  mentions: readonly PromptTextMention[];
  resolveLinkHref?: TimelineTitleLinkResolver;
  resolveMentionLink?: PromptMentionLinkResolver;
}

interface BuildPromptMentionComponentArgs {
  mentions: readonly IndexedPromptMention[];
  resolveLinkHref?: TimelineTitleLinkResolver;
  resolveMentionLink?: PromptMentionLinkResolver;
}

interface PromptMentionElementProps {
  "data-mention-index"?: string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "bb-prompt-mention": PromptMentionElementProps;
    }
  }
}

function resolveThreadMentionHref(
  resource: PromptTextMention["resource"],
  resolveLinkHref: TimelineTitleLinkResolver | undefined,
): string | undefined {
  if (resource.kind !== "thread" || !resolveLinkHref) {
    return undefined;
  }
  return (
    resolveLinkHref({ kind: "thread", threadId: resource.threadId }) ??
    undefined
  );
}

export function buildPromptMentionComponent({
  mentions,
  resolveLinkHref,
  resolveMentionLink,
}: BuildPromptMentionComponentArgs): ComponentType<PromptMentionElementProps> {
  function PromptMentionElement(props: PromptMentionElementProps) {
    const rawIndex = props["data-mention-index"];
    if (rawIndex === undefined) {
      return null;
    }
    const mention = mentions[Number(rawIndex)];
    if (mention === undefined) {
      return null;
    }
    return (
      <PromptMentionPill
        resource={mention.resource}
        resolveMentionLink={resolveMentionLink}
        serializedText={mention.serializedText}
        linkHref={resolveThreadMentionHref(mention.resource, resolveLinkHref)}
      />
    );
  }

  return PromptMentionElement;
}
