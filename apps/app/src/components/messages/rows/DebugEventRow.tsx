import { useState } from "react";
import type { UIDebugRawEventMessage } from "@bb/domain";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DEBUG_EVENT_EXPANDED_MAX_LENGTH } from "./shared";

function formatDebugEventData(
  data: unknown,
  {
    maxLength,
    pretty = false,
  }: {
    maxLength: number;
    pretty?: boolean;
  },
): string {
  if (data === undefined) return "(no data)";
  try {
    const serialized = JSON.stringify(data, null, pretty ? 2 : 0);
    if (!serialized) return "(no data)";
    if (serialized.length > maxLength) {
      return `${serialized.slice(0, maxLength)}...`;
    }
    return serialized;
  } catch {
    return "(unserializable data)";
  }
}

export function DebugEventRow({ message }: { message: UIDebugRawEventMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const event = message.rawEvent;
  const expandedContent = formatDebugEventData(event.data, {
    maxLength: DEBUG_EVENT_EXPANDED_MAX_LENGTH,
    pretty: true,
  });

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <button
          type="button"
          onClick={() => setIsExpanded((value) => !value)}
          className="w-full px-1 py-0.5 text-left"
        >
          <p className="flex items-center gap-1.5 font-mono ui-text-xs text-muted-foreground">
            {isExpanded ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            <span className="shrink-0">#{event.seq}</span>
            <span className="shrink-0">{message.rawType}</span>
            <Badge variant="outline" className="h-4 rounded px-1 ui-text-3xs">
              {message.reason}
            </Badge>
          </p>
        </button>
        {isExpanded ? (
          <div className="mt-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1">
            <pre className="whitespace-pre-wrap break-all font-mono ui-text-xs text-muted-foreground/80">
              {expandedContent}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
