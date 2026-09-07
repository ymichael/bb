import type { ComponentType } from "react";
import type { InlineCode, Nodes, Parent, PhrasingContent, Text } from "mdast";
import type {} from "mdast-util-to-hast";
import { visit } from "unist-util-visit";
import {
  isRawThreadId,
  RAW_THREAD_ID_PATTERN_SOURCE,
  type PromptTextMention,
} from "@bb/domain";
import type { TimelineTitleLink } from "@bb/thread-view";
import {
  PromptMentionPill,
  resolveThreadMentionResource,
} from "@/components/thread/timeline/ConversationMessageMentions.js";
import {
  isMentionBoundary,
  isMentionEndBoundary,
  isRawThreadIdBoundary,
  isRawThreadIdEndBoundary,
  useRawThreadMentionResource,
  useSidebarThreadMentionResource,
  useThreadMentionResource,
} from "@/components/thread/ThreadTitleMentions.js";
import type { TimelineTitleLinkResolver } from "@/components/thread/timeline/TimelineTitleView.js";

const THREAD_MENTION_PATTERN = new RegExp(
  `@thread:([A-Za-z0-9_-]+)|(${RAW_THREAD_ID_PATTERN_SOURCE})`,
  "gu",
);
const RAW_THREAD_ID_PATTERN = new RegExp(RAW_THREAD_ID_PATTERN_SOURCE, "gu");
const THREAD_MENTION_PREFIX = "@thread";
const THREAD_MENTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

const THREAD_MENTION_HAST_NAME = "bb-thread-mention";
const THREAD_MENTION_THREAD_ID_PROPERTY = "dataThreadId";
const RAW_THREAD_ID_PROPERTY = "dataRawThreadId";
const RAW_THREAD_INLINE_CODE_PROPERTY = "dataRawThreadInlineCode";

function threadMentionNode(
  threadId: string,
  rawThreadId = false,
  rawThreadInlineCode = false,
): Text {
  return {
    type: "text",
    value: "",
    data: {
      hName: THREAD_MENTION_HAST_NAME,
      hProperties: {
        [THREAD_MENTION_THREAD_ID_PROPERTY]: threadId,
        ...(rawThreadId ? { [RAW_THREAD_ID_PROPERTY]: threadId } : {}),
        ...(rawThreadInlineCode
          ? { [RAW_THREAD_INLINE_CODE_PROPERTY]: "true" }
          : {}),
      },
    },
  };
}

interface PhrasingTextContext {
  offset: number;
  text: string;
}

function collectPhrasingTextContexts(
  tree: Nodes,
): WeakMap<object, PhrasingTextContext> {
  const contexts = new WeakMap<object, PhrasingTextContext>();
  visit(tree, (node) => {
    if (
      node.type !== "paragraph" &&
      node.type !== "heading" &&
      node.type !== "tableCell"
    ) {
      return;
    }

    const leaves: Array<{ node: InlineCode | Text; offset: number }> = [];
    let visibleText = "";
    visit(node, (descendant) => {
      if (descendant.type === "text" || descendant.type === "inlineCode") {
        leaves.push({ node: descendant, offset: visibleText.length });
        visibleText += descendant.value;
        return;
      }
      if (descendant.type === "image" || descendant.type === "imageReference") {
        visibleText += descendant.alt ?? "";
        return;
      }
      if (descendant.type === "break") {
        visibleText += "\n";
      }
    });
    for (const leaf of leaves) {
      contexts.set(leaf.node, { offset: leaf.offset, text: visibleText });
    }
  });
  return contexts;
}

function splitTextNodeOnMentions(
  node: Text,
  context: PhrasingTextContext | undefined,
): PhrasingContent[] {
  const { value } = node;
  THREAD_MENTION_PATTERN.lastIndex = 0;
  const replacements: PhrasingContent[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = THREAD_MENTION_PATTERN.exec(value)) !== null) {
    const serializedThreadId = match[1];
    const rawThreadId = match[2];
    const threadId = serializedThreadId ?? rawThreadId;
    const matchEnd = match.index + match[0].length;
    const boundaryText = rawThreadId === undefined ? value : context?.text;
    const boundaryStart =
      rawThreadId === undefined
        ? match.index
        : (context?.offset ?? 0) + match.index;
    const boundaryEnd = boundaryStart + match[0].length;
    if (
      threadId === undefined ||
      !(rawThreadId === undefined
        ? isMentionBoundary(value, match.index)
        : isRawThreadIdBoundary(boundaryText ?? value, boundaryStart)) ||
      !(rawThreadId === undefined
        ? isMentionEndBoundary(value, matchEnd)
        : isRawThreadIdEndBoundary(boundaryText ?? value, boundaryEnd))
    ) {
      continue;
    }
    if (match.index > cursor) {
      replacements.push({
        type: "text",
        value: value.slice(cursor, match.index),
      });
    }
    replacements.push(threadMentionNode(threadId, rawThreadId !== undefined));
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

interface ParsedTextDirective {
  attributes: unknown;
  children: unknown;
  name: string;
  type: "textDirective";
}

function parseTextDirective(node: unknown): ParsedTextDirective | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const candidate = node as {
    attributes?: unknown;
    children?: unknown;
    name?: unknown;
    type?: unknown;
  };
  return candidate.type === "textDirective" &&
    typeof candidate.name === "string"
    ? {
        type: candidate.type,
        name: candidate.name,
        attributes: candidate.attributes,
        children: candidate.children,
      }
    : null;
}

function isUndecoratedTextDirective(directive: ParsedTextDirective): boolean {
  return (
    Array.isArray(directive.children) &&
    directive.children.length === 0 &&
    typeof directive.attributes === "object" &&
    directive.attributes !== null &&
    !Array.isArray(directive.attributes) &&
    Object.keys(directive.attributes).length === 0
  );
}

function collectAuthoredMarkdownLinkNodes(tree: Nodes): WeakSet<object> {
  const linkNodes = new WeakSet<object>();
  visit(tree, (node) => {
    if (node.type !== "link" && node.type !== "linkReference") {
      return;
    }
    visit(node, (descendant) => {
      linkNodes.add(descendant);
    });
  });
  return linkNodes;
}

interface RawThreadIdTextSegment {
  rawThreadId: string | null;
  text: string;
}

export function splitRawThreadIdsInText(
  text: string,
): RawThreadIdTextSegment[] {
  RAW_THREAD_ID_PATTERN.lastIndex = 0;
  const segments: RawThreadIdTextSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = RAW_THREAD_ID_PATTERN.exec(text)) !== null) {
    const matchEnd = match.index + match[0].length;
    if (
      !isRawThreadIdBoundary(text, match.index) ||
      !isRawThreadIdEndBoundary(text, matchEnd)
    ) {
      continue;
    }
    if (match.index > cursor) {
      segments.push({
        rawThreadId: null,
        text: text.slice(cursor, match.index),
      });
    }
    segments.push({ rawThreadId: match[0], text: match[0] });
    cursor = matchEnd;
  }
  if (segments.length === 0) {
    return [{ rawThreadId: null, text }];
  }
  if (cursor < text.length) {
    segments.push({ rawThreadId: null, text: text.slice(cursor) });
  }
  return segments;
}

function isDirectiveMentionEndBoundary(parent: Parent, index: number): boolean {
  const next = parent.children[index + 1];
  return next?.type !== "text" || isMentionEndBoundary(next.value, 0);
}

export function remarkThreadMentions() {
  return (tree: Nodes): void => {
    const authoredMarkdownLinkNodes = collectAuthoredMarkdownLinkNodes(tree);
    const phrasingTextContexts = collectPhrasingTextContexts(tree);
    visit(
      tree,
      "inlineCode",
      (node: InlineCode, index, parent: Parent | undefined) => {
        if (
          parent === undefined ||
          index === undefined ||
          authoredMarkdownLinkNodes.has(node) ||
          !isRawThreadId(node.value) ||
          !isRawThreadIdBoundary(
            phrasingTextContexts.get(node)?.text ?? node.value,
            phrasingTextContexts.get(node)?.offset ?? 0,
          ) ||
          !isRawThreadIdEndBoundary(
            phrasingTextContexts.get(node)?.text ?? node.value,
            (phrasingTextContexts.get(node)?.offset ?? 0) + node.value.length,
          )
        ) {
          return;
        }
        parent.children.splice(
          index,
          1,
          threadMentionNode(node.value, true, true),
        );
        return index + 1;
      },
    );
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (
        parent === undefined ||
        index === undefined ||
        authoredMarkdownLinkNodes.has(node)
      ) {
        return;
      }
      const replacements = splitTextNodeOnMentions(
        node,
        phrasingTextContexts.get(node),
      );
      if (replacements.length === 1 && replacements[0] === node) {
        return;
      }
      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
    visit(tree, (node, index, parent: Parent | undefined) => {
      const directive = parseTextDirective(node);
      if (
        directive === null ||
        index === undefined ||
        index === 0 ||
        parent === undefined ||
        !isUndecoratedTextDirective(directive) ||
        !THREAD_MENTION_ID_PATTERN.test(directive.name)
      ) {
        return;
      }
      const previous = parent.children[index - 1];
      if (previous?.type !== "text") {
        return;
      }
      const prefixStart = previous.value.length - THREAD_MENTION_PREFIX.length;
      if (prefixStart < 0 || !previous.value.endsWith(THREAD_MENTION_PREFIX)) {
        return;
      }
      if (
        !isMentionBoundary(previous.value, prefixStart) ||
        !isDirectiveMentionEndBoundary(parent, index) ||
        authoredMarkdownLinkNodes.has(node)
      ) {
        const leadingText = previous.value.slice(0, prefixStart);
        const mentionText: Text = {
          type: "text",
          value: `${THREAD_MENTION_PREFIX}:${directive.name}`,
        };
        if (leadingText.length === 0) {
          parent.children.splice(index - 1, 2, mentionText);
          return index;
        }
        previous.value = leadingText;
        parent.children.splice(index, 1, mentionText);
        return index + 1;
      }
      previous.value = previous.value.slice(0, prefixStart);
      parent.children.splice(index, 1, threadMentionNode(directive.name));
      return index + 1;
    });
  };
}

interface BuildThreadMentionComponentArgs {
  mentions: readonly PromptTextMention[];
  resolveSegmentLinkHref?: TimelineTitleLinkResolver;
}

interface ThreadMentionElementProps {
  "data-raw-thread-id"?: string;
  "data-raw-thread-inline-code"?: string;
  "data-thread-id"?: string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "bb-thread-mention": ThreadMentionElementProps;
    }
  }
}

function resolveThreadMentionHref(
  threadId: string,
  resolveSegmentLinkHref: TimelineTitleLinkResolver | undefined,
): string | undefined {
  if (!resolveSegmentLinkHref) {
    return undefined;
  }
  const link: TimelineTitleLink = { kind: "thread", threadId };
  return resolveSegmentLinkHref(link) ?? undefined;
}

export function buildThreadMentionComponent({
  mentions,
  resolveSegmentLinkHref,
}: BuildThreadMentionComponentArgs): ComponentType<ThreadMentionElementProps> {
  function RawThreadMentionPillWithQuery({
    inlineCode,
    threadId,
  }: {
    inlineCode: boolean;
    threadId: string;
  }) {
    const resource = useRawThreadMentionResource(threadId);
    if (resource === null) {
      return inlineCode ? (
        <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs">
          {threadId}
        </code>
      ) : (
        threadId
      );
    }
    return <PromptMentionPill resource={resource} serializedText={threadId} />;
  }

  function ThreadMentionPillWithQuery({ threadId }: { threadId: string }) {
    const liveResource = useThreadMentionResource(threadId);
    const resource =
      liveResource ?? resolveThreadMentionResource(mentions, threadId);
    return (
      <PromptMentionPill
        resource={resource}
        serializedText={`@thread:${threadId}`}
        linkHref={resolveThreadMentionHref(threadId, resolveSegmentLinkHref)}
      />
    );
  }

  function ThreadMentionElement(props: ThreadMentionElementProps) {
    const threadId = props["data-thread-id"] ?? "";
    const rawThreadId = props["data-raw-thread-id"];
    const sidebarResource = useSidebarThreadMentionResource(threadId);
    if (threadId.length === 0) {
      return null;
    }
    if (rawThreadId !== undefined) {
      return (
        <RawThreadMentionPillWithQuery
          inlineCode={props["data-raw-thread-inline-code"] !== undefined}
          threadId={threadId}
        />
      );
    }
    const persistedResource = mentions.find(
      (mention) =>
        mention.resource.kind === "thread" &&
        mention.resource.threadId === threadId,
    )?.resource;
    const resource = sidebarResource ?? persistedResource;
    if (resource === undefined) {
      return <ThreadMentionPillWithQuery threadId={threadId} />;
    }
    return (
      <PromptMentionPill
        resource={resource}
        serializedText={`@thread:${threadId}`}
        linkHref={resolveThreadMentionHref(threadId, resolveSegmentLinkHref)}
      />
    );
  }

  return ThreadMentionElement;
}
