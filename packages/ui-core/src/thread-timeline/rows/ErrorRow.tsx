import {
  CollapsibleHeader,
  ExpandablePanel,
} from "../../disclosure.js";
import { EventCodeBlock } from "../../event-content.js";
import type { ViewErrorMessage } from "@bb/domain";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import {
  EVENT_LARGE_DETAIL_MAX_HEIGHT_CLASS,
} from "./shared.js";

function normalizeErrorMessageText(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n");
  if (normalized.includes("\n")) return normalized;
  if (!normalized.includes("\\n") && !normalized.includes("\\r\\n")) return normalized;
  if (/[A-Za-z]:\\\\/.test(normalized)) return normalized;
  return normalized.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
}

function isThreadProvisioningFailureTitle(value: string): boolean {
  return /^Thread provisioning failed for project\s+.+$/i.test(value.trim());
}

function normalizeProvisioningErrorDetail(detail: string): string {
  let normalized = normalizeErrorMessageText(detail).trim();
  if (!normalized) return normalized;
  if (
    !normalized.startsWith(".bb-env-setup.sh failed:")
    && !normalized.startsWith(".bb-env-setup.ts failed:")
  ) {
    return normalized;
  }

  normalized = normalized.replace(
    /^(\.bb-env-setup\.(?:sh|ts) failed:)\s*•\s*/i,
    "$1\n• ",
  );
  return normalized.replace(/\s+•\s+/g, "\n• ");
}

function normalizeErrorDetailForDisplay(title: string, detail?: string): string | undefined {
  const normalized = detail?.trim();
  if (!normalized) return undefined;
  if (title === "Thread provisioning failed") {
    return normalizeProvisioningErrorDetail(normalized);
  }
  return normalizeErrorMessageText(normalized).trim();
}

function parseErrorDisplay(message: ViewErrorMessage): {
  title: string;
  detail?: string;
  hint?: string;
} {
  const trimmed = normalizeErrorMessageText(message.message).trim();
  if (!trimmed) {
    return { title: "Error event" };
  }

  const [titleCandidate, ...detailParts] = trimmed.split(" - ");
  const detailFromDelimiter = normalizeErrorMessageText(detailParts.join(" - ")).trim();
  const titleFromDelimiter = titleCandidate?.trim();

  if (message.rawType === "system/error" && trimmed.startsWith("Project folder not found")) {
    const missingPathMatch = trimmed.match(/^Project folder not found:\s*(.+?)(?:\s+-\s+.*)?$/);
    const missingPath = missingPathMatch?.[1]?.trim();
    const detail = missingPath
      ? `Project folder not found: ${missingPath}. Please update the project path and try again.`
      : "Project folder not found. Please update the project path and try again.";
    return {
      title: "Project folder is missing",
      detail,
    };
  }

  if (titleFromDelimiter && isThreadProvisioningFailureTitle(titleFromDelimiter)) {
    return {
      title: "Thread provisioning failed",
      detail: detailFromDelimiter
        ? normalizeProvisioningErrorDetail(detailFromDelimiter)
        : undefined,
    };
  }

  if (isThreadProvisioningFailureTitle(trimmed)) {
    return { title: "Thread provisioning failed" };
  }

  if (titleFromDelimiter && detailFromDelimiter && titleFromDelimiter.length <= 96) {
    return {
      title: titleFromDelimiter,
      detail: detailFromDelimiter,
    };
  }

  return { title: trimmed };
}

export function ErrorRow({
  message,
  initialExpanded = false,
}: {
  message: ViewErrorMessage;
  initialExpanded?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const display = parseErrorDisplay(message);
  const isExpandable = Boolean(display.detail?.trim() || display.hint?.trim());
  const headerToneClass = isExpanded
    ? "text-destructive"
    : isExpandable
      ? "text-destructive/90 transition-colors group-hover:text-destructive group-focus-within:text-destructive"
      : "text-destructive/90";
  const summaryContent = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-destructive/85">Error:</span>
      <span className="truncate font-semibold text-destructive">
        {display.title}
      </span>
    </span>
  );
  const detailText = normalizeErrorDetailForDisplay(display.title, display.detail);
  const hasMultilineDetail = Boolean(detailText?.includes("\n"));

  if (!isExpandable) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full rounded-md px-2 py-1 text-muted-foreground">
          <CollapsibleHeader
            toneClassName={headerToneClass}
            summaryClassName="min-w-0"
            summaryContent={summaryContent}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          summaryContentClassName="min-w-0"
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <div className="space-y-1 rounded-md border border-destructive/25 bg-destructive/[0.06] px-2 py-1.5 ui-text-sm text-destructive/90">
            {detailText ? (
              hasMultilineDetail ? (
                <EventCodeBlock
                  className="px-1 py-0.5"
                  maxHeightClassName={EVENT_LARGE_DETAIL_MAX_HEIGHT_CLASS}
                  tone="danger"
                >
                  {detailText}
                </EventCodeBlock>
              ) : (
                <p className="whitespace-pre-wrap break-words">
                  {detailText}
                </p>
              )
            ) : null}
            {display.hint ? <p>{display.hint}</p> : null}
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}
