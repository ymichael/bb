import { useEffect, useMemo, useState } from "react";
import {
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "@beanbag/ui-core";
import type { UIAssistantReasoningMessage } from "@beanbag/agent-core";
import { ConversationMarkdown } from "../ConversationMarkdown";

function getReasoningTitle(reasoning: string): string {
  const match = reasoning.match(/^\*\*(.*?)\*\*/);
  if (match?.[1]) {
    return match[1].trim() || "Thinking";
  }
  return "Thinking";
}

function normalizeReasoningText(value: string): string {
  return value
    .replaceAll("**", "")
    .replaceAll("__", "")
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isReasoningExpandable(reasoning: string, title: string): boolean {
  const normalizedReasoning = normalizeReasoningText(reasoning);
  const normalizedTitle = normalizeReasoningText(title);
  if (!normalizedReasoning || !normalizedTitle) return true;
  return normalizedReasoning !== normalizedTitle;
}

export function ReasoningRow({ message }: { message: UIAssistantReasoningMessage }) {
  const isStreaming = message.status === "streaming";
  const [isExpanded, setIsExpanded] = useState(isStreaming);
  const title = useMemo(() => getReasoningTitle(message.text), [message.text]);
  const expandable = useMemo(
    () => isStreaming || isReasoningExpandable(message.text, title),
    [isStreaming, message.text, title],
  );
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);

  useEffect(() => {
    if (isStreaming) setIsExpanded(true);
    if (!isStreaming && !expandable) setIsExpanded(false);
  }, [expandable, isStreaming]);

  if (!expandable) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <div className="rounded-md px-2 py-1 text-muted-foreground">
            <div className={`py-0.5 text-sm italic ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
              <span className="truncate">{title}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={isExpanded ? "Thinking..." : title}
          headerToneClass={headerToneClass}
          headerButtonClassName="italic"
          onToggle={() => setIsExpanded((prev) => !prev)}
        >
          <ConversationMarkdown
            content={message.text}
            className="italic text-muted-foreground"
          />
        </ExpandablePanel>
      </div>
    </div>
  );
}
