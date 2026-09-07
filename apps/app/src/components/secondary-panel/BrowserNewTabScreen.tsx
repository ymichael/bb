import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { getBrowserUrlHost } from "@/lib/browser-url";
import { formatRelativeTime } from "@/lib/relative-time";
import type { BrowserHistoryEntry } from "@/lib/browser-history";
import {
  LAUNCHER_ROW_BASE_CLASS,
  LAUNCHER_ROW_ICON_CLASS,
  LauncherRowTrailing,
  LauncherSectionHeader,
} from "./launcherRow";

interface BrowserNewTabScreenProps {
  onNavigateInput: (rawInput: string) => void;
  recent: readonly BrowserHistoryEntry[];
  onClearRecent: () => void;
}

interface BrowserRecentRowProps {
  entry: BrowserHistoryEntry;
  now: number;
  onNavigate: (url: string) => void;
}

function BrowserRecentRow({ entry, now, onNavigate }: BrowserRecentRowProps) {
  const host = getBrowserUrlHost(entry.url);
  const title = entry.title?.trim();
  const primary = title && title.length > 0 ? title : host;
  const relativeTime = formatRelativeTime({ timestamp: entry.visitedAt, now });

  return (
    <button
      type="button"
      onClick={() => onNavigate(entry.url)}
      title={entry.url}
      className={cn(LAUNCHER_ROW_BASE_CLASS, "hover:bg-state-hover")}
    >
      <span className={LAUNCHER_ROW_ICON_CLASS}>
        <Icon
          name="Browser"
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
          aria-hidden
        />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-foreground">{primary}</span>
        {primary !== host ? (
          <span className="truncate font-mono text-muted-foreground [flex-shrink:9999]">
            {host}
          </span>
        ) : null}
      </span>
      <LauncherRowTrailing idle={relativeTime} isActive={false} />
    </button>
  );
}

export function BrowserNewTabScreen({
  onNavigateInput,
  recent,
  onClearRecent,
}: BrowserNewTabScreenProps) {
  const now = Date.now();

  if (recent.length === 0) {
    return null;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 pb-6 pt-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <section>
          <LauncherSectionHeader
            label="Recently visited"
            count={recent.length}
            action={
              <button
                type="button"
                onClick={onClearRecent}
                aria-label="Clear recently visited"
                className={cn(
                  "rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  COARSE_POINTER_TEXT_SM_CLASS,
                )}
              >
                Clear
              </button>
            }
          />
          <ul aria-label="Recently visited" className="flex flex-col gap-px">
            {recent.map((entry) => (
              <li key={entry.url}>
                <BrowserRecentRow
                  entry={entry}
                  now={now}
                  onNavigate={onNavigateInput}
                />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
