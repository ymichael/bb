import { useMemo } from "react";
import { type DetailScrollSize } from "../../detail-scroll-size.js";
import { cn } from "../../cn.js";
import {
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "../../disclosure.js";
import type { ViewAssistantReasoningMessage } from "@bb/domain";
import { ConversationMarkdown } from "../ConversationMarkdown.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import { ExpandableDetailScrollArea } from "./shared.js";

interface ReasoningRowProps {
  initialExpanded?: boolean;
  message: ViewAssistantReasoningMessage;
}

const REASONING_DETAIL_SIZE: DetailScrollSize = "large";

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

export function ReasoningRow({
  message,
  initialExpanded = false,
}: ReasoningRowProps) {
  const isStreaming = message.status === "streaming";
  const title = useMemo(() => getReasoningTitle(message.text), [message.text]);
  const expandable = useMemo(
    () => isStreaming || isReasoningExpandable(message.text, title),
    [isStreaming, message.text, title],
  );

  const { isExpanded, onToggle } = useLatestInitialExpanded(
    initialExpanded || isStreaming,
  );
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);

  if (!expandable) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <div className="rounded-md px-2 py-1 text-muted-foreground">
            <div
              className={cn(
                "py-0.5 text-sm italic",
                COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
              )}
            >
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
          onToggle={onToggle}
        >
          <ExpandableDetailScrollArea
            className="italic text-muted-foreground"
            size={REASONING_DETAIL_SIZE}
          >
            <ConversationMarkdown
              content={message.text}
              className="italic text-muted-foreground"
            />
          </ExpandableDetailScrollArea>
        </ExpandablePanel>
      </div>
    </div>
  );
}
