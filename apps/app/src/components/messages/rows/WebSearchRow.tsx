import type { UIWebSearchMessage } from "@beanbag/agent-core";
import { COLLAPSIBLE_HEADER_STATIC_TONE_CLASS } from "@beanbag/ui-core";
import { renderShimmeringSummary } from "./shared";

export function WebSearchRow({
  message,
  preferOngoingLabels = false,
}: {
  message: UIWebSearchMessage;
  preferOngoingLabels?: boolean;
}) {
  const isSearching = message.status === "pending" || preferOngoingLabels;
  const summary =
    isSearching
      ? "Searching the web"
      : message.query
        ? `Searched ${message.query}`
        : "Searched the web";

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
          <div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
            {renderShimmeringSummary(summary, isSearching)}
          </div>
        </div>
      </div>
    </div>
  );
}
