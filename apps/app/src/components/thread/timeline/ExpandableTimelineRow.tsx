import {
  memo,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { TimelineTitle } from "@bb/thread-view";
import {
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "../../ui/disclosure.js";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { PluginCompactIconMask } from "../../plugin/PluginIcon.js";
import {
  TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME,
  timelineRowHeaderClassName,
  timelineRowHorizontalPaddingClassName,
  type TimelineRowHorizontalPadding,
} from "./TimelineRowHeader.js";
import {
  TimelineTitleView,
  type TimelineTitleActionResolver,
  type TimelineTitleLinkResolver,
} from "./TimelineTitleView.js";

interface ExpandableTimelineRowProps {
  autoExpanded?: boolean;
  forceExpanded?: boolean;
  terminalAutoExpanded?: boolean;
  renderBody: () => ReactNode;
  title: TimelineTitle;
  titleContent?: ReactNode;
  collapsedPreview?: ReactNode;
  expandable?: boolean;
  horizontalPadding?: TimelineRowHorizontalPadding;
  leadingIcon?: IconName;
  leadingIconUrl?: string;
  leadingIconStyle?: CSSProperties;
  summaryClassName?: string;
  onTitleAction?: TimelineTitleActionResolver;
  resolveSegmentLinkHref?: TimelineTitleLinkResolver;
}

type ManualExpansionOverride = boolean | null;
type CollapsedPreviewClickEvent = MouseEvent<HTMLDivElement>;
type CollapsedPreviewFocusEvent = FocusEvent<HTMLDivElement>;
type CollapsedPreviewKeyboardEvent = KeyboardEvent<HTMLDivElement>;

interface InteractivePreviewTargetArgs {
  currentTarget: HTMLDivElement;
  target: EventTarget | null;
}

function headerToneClass(title: TimelineTitle, isExpanded: boolean): string {
  if (title.tone === "summary") {
    return "text-subtle-foreground transition-colors hover:text-muted-foreground focus-visible:text-muted-foreground";
  }
  return getCollapsibleHeaderToneClass(isExpanded);
}

function isInteractivePreviewTarget({
  currentTarget,
  target,
}: InteractivePreviewTargetArgs): boolean {
  if (!(target instanceof Element) || target === currentTarget) {
    return false;
  }
  return target.closest("a,button,input,select,textarea") !== null;
}

function ExpandableTimelineRowComponent({
  autoExpanded = false,
  collapsedPreview,
  expandable = true,
  forceExpanded = false,
  horizontalPadding = "default",
  leadingIcon,
  leadingIconUrl,
  leadingIconStyle,
  onTitleAction,
  renderBody,
  resolveSegmentLinkHref,
  summaryClassName,
  terminalAutoExpanded = false,
  title,
  titleContent,
}: ExpandableTimelineRowProps) {
  const [manualExpansionOverride, setManualExpansionOverride] =
    useState<ManualExpansionOverride>(null);
  const [terminalAutoExpandedLatch, setTerminalAutoExpandedLatch] =
    useState(terminalAutoExpanded);
  const [collapsedPreviewActive, setCollapsedPreviewActive] = useState(false);
  useEffect(() => {
    if (terminalAutoExpanded) {
      setTerminalAutoExpandedLatch(true);
    }
  }, [terminalAutoExpanded]);
  const isExpanded =
    expandable &&
    (forceExpanded ||
      (manualExpansionOverride ??
        (autoExpanded || terminalAutoExpanded || terminalAutoExpandedLatch)));
  useEffect(() => {
    if (isExpanded) {
      setCollapsedPreviewActive(false);
    }
  }, [isExpanded]);
  const horizontalPaddingClass =
    timelineRowHorizontalPaddingClassName(horizontalPadding);
  const handleToggle = useCallback((): void => {
    setManualExpansionOverride(!isExpanded);
  }, [isExpanded]);
  const handleCollapsedPreviewClick = useCallback(
    (event: CollapsedPreviewClickEvent): void => {
      if (
        isInteractivePreviewTarget({
          currentTarget: event.currentTarget,
          target: event.target,
        })
      ) {
        return;
      }
      handleToggle();
    },
    [handleToggle],
  );
  const handleCollapsedPreviewKeyDown = useCallback(
    (event: CollapsedPreviewKeyboardEvent): void => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      handleToggle();
    },
    [handleToggle],
  );
  const handleCollapsedPreviewBlur = useCallback(
    (event: CollapsedPreviewFocusEvent): void => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      setCollapsedPreviewActive(false);
    },
    [],
  );

  return (
    <ExpandablePanel
      isExpanded={isExpanded}
      onToggle={expandable ? handleToggle : undefined}
      headerToneClass={
        expandable
          ? headerToneClass(title, isExpanded)
          : COLLAPSIBLE_HEADER_STATIC_TONE_CLASS
      }
      collapsedContent={
        collapsedPreview ? (
          <div
            className={cn(
              horizontalPaddingClass,
              "pb-1 pt-0.5",
              expandable ? "cursor-pointer focus-visible:outline-none" : null,
            )}
            role={expandable ? "button" : undefined}
            tabIndex={expandable ? 0 : undefined}
            aria-expanded={expandable ? isExpanded : undefined}
            onClick={expandable ? handleCollapsedPreviewClick : undefined}
            onMouseEnter={
              expandable ? () => setCollapsedPreviewActive(true) : undefined
            }
            onMouseLeave={
              expandable ? () => setCollapsedPreviewActive(false) : undefined
            }
            onFocus={
              expandable ? () => setCollapsedPreviewActive(true) : undefined
            }
            onBlur={expandable ? handleCollapsedPreviewBlur : undefined}
            onKeyDown={expandable ? handleCollapsedPreviewKeyDown : undefined}
          >
            {collapsedPreview}
          </div>
        ) : null
      }
      summaryContent={
        <span
          className={cn(
            "inline-flex min-w-0 max-w-full items-center gap-1.5",
            summaryClassName,
          )}
        >
          {leadingIconUrl !== undefined ? (
            <PluginCompactIconMask
              url={leadingIconUrl}
              className="size-3.5 text-muted-foreground"
              style={leadingIconStyle}
            />
          ) : leadingIcon ? (
            <Icon
              name={leadingIcon}
              className="size-3.5 shrink-0 text-muted-foreground"
              style={leadingIconStyle}
              aria-hidden
            />
          ) : null}
          {titleContent ?? (
            <TimelineTitleView
              title={title}
              onTitleAction={onTitleAction}
              resolveSegmentLinkHref={resolveSegmentLinkHref}
            />
          )}
        </span>
      }
      summaryContentClassName={TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME}
      forceHeaderChevronVisible={
        expandable && !isExpanded && collapsedPreviewActive
      }
      className="w-full"
      headerClassName={timelineRowHeaderClassName(horizontalPadding)}
      contentClassName={cn(horizontalPaddingClass, "pb-1 pt-0.5")}
      renderBody={renderBody}
    />
  );
}

export const ExpandableTimelineRow = memo(ExpandableTimelineRowComponent);
