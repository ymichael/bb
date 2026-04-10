import type { ViewWebSearchMessage } from "@bb/domain";
import { cn } from "../../cn.js";
import { COLLAPSIBLE_HEADER_STATIC_TONE_CLASS } from "../../disclosure.js";
import { EventTitle } from "./shared.js";

export function WebSearchRow({
  message,
  preferOngoingLabels = false,
}: {
  message: ViewWebSearchMessage;
  preferOngoingLabels?: boolean;
}) {
  const isSearching = message.status === "pending" || preferOngoingLabels;
  const summary = (
    <EventTitle
      prefix={isSearching ? "Searching" : "Searched"}
      detail={message.query ?? "the web"}
      shimmerPrefix={isSearching}
    />
  );

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
          <div className={cn("py-0.5", COLLAPSIBLE_HEADER_STATIC_TONE_CLASS)}>
            {summary}
          </div>
        </div>
      </div>
    </div>
  );
}
