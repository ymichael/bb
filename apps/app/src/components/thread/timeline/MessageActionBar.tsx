import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { CopyButton } from "../../ui/copy-button.js";
import { Icon } from "@bb/shared-ui/icon";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { preventOverlayTriggerSelection } from "@bb/shared-ui/overlay-trigger";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import type { PromptDraftAttachment } from "@bb/client-core";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { PluginIcon, pluginIconName } from "@/components/plugin/PluginIcon";
import type { ThreadTimelinePluginMessageAction } from "./types.js";

function PluginActionIcon({
  pluginId,
  icon,
  className,
}: {
  pluginId: string | null;
  icon: string | null;
  className?: string;
}) {
  return pluginId === null ? (
    <Icon
      name={pluginIconName(icon)}
      className={cn("size-4 shrink-0", className)}
      aria-hidden="true"
    />
  ) : (
    <PluginIcon pluginId={pluginId} icon={icon} className={className} />
  );
}

interface MessageActionBarProps {
  messageText: string;
  alignment: "start" | "end";
  mobileActionDisplay: "inline" | "overflow";
  addToChatAttachments?: readonly PromptDraftAttachment[];
  copyImageUrl?: string;
  onAddToChat?: (
    text: string,
    attachments?: readonly PromptDraftAttachment[],
  ) => void;
  onEdit?: () => void;
  onFork?: () => void;
  onSendToMain?: () => void;
  disabled?: boolean;
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
}

interface MessageOverflowAction {
  icon: "Copy" | "Edit" | "MessageSquarePlus" | "Fork" | "ArrowTurnBackward";
  plugin?: { pluginId: string | null; icon: string | null };
  key?: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  copyText?: string;
  copyImageUrl?: string;
  kind?: "copy";
}

const DESKTOP_ACTION_WIDTH_PX = 20;
const TOUCH_ACTION_WIDTH_PX = 28;
const ACTION_ROW_GAP_PX = 8;
const OVERFLOW_TRIGGER_GAP_PX = 4;
const OVERFLOW_TRIGGER_TIGHTEN_CLASS = "-ml-1";
const EXPANDED_ROW_COMFORT_PX = 16;

function actionRowWidth(count: number, actionWidth: number): number {
  return count <= 0 ? 0 : count * actionWidth + (count - 1) * ACTION_ROW_GAP_PX;
}

interface MessageActionRowLayout {
  inlineCount: number;
  overflowCount: number;
}

export function computeMessageActionRowLayout({
  actionCount,
  availableWidth,
  actionWidth,
  overflowTriggerWidth,
}: {
  actionCount: number;
  availableWidth: number | undefined;
  actionWidth: number;
  overflowTriggerWidth: number;
}): MessageActionRowLayout {
  if (actionCount <= 0) {
    return { inlineCount: 0, overflowCount: 0 };
  }
  if (availableWidth === undefined) {
    return { inlineCount: actionCount, overflowCount: 0 };
  }
  if (actionRowWidth(actionCount, actionWidth) <= availableWidth) {
    return { inlineCount: actionCount, overflowCount: 0 };
  }
  const inlineCount = Math.max(
    0,
    Math.min(
      actionCount - 1,
      Math.floor(
        (availableWidth -
          overflowTriggerWidth -
          OVERFLOW_TRIGGER_GAP_PX +
          ACTION_ROW_GAP_PX) /
          (actionWidth + ACTION_ROW_GAP_PX),
      ),
    ),
  );
  return { inlineCount, overflowCount: actionCount - inlineCount };
}

export function useMeasuredWidth({
  enabled,
  resolveTarget,
}: {
  enabled: boolean;
  resolveTarget?: (node: HTMLElement) => Element | null;
}): {
  measureRef: (node: HTMLElement | null) => void;
  width: number | undefined;
} {
  const [width, setWidth] = useState<number | undefined>(undefined);
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!enabled || node === null || typeof ResizeObserver === "undefined") {
        return;
      }
      const target = resolveTarget ? resolveTarget(node) : node;
      if (target === null) {
        return;
      }
      const observer = new ResizeObserver(([entry]) => {
        const inlineSize =
          entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        setWidth(Math.floor(inlineSize));
      });
      observer.observe(target);
      observerRef.current = observer;
    },
    [enabled, resolveTarget],
  );
  return { measureRef, width };
}

export interface SharedMessageColumnWidth {
  width: number | undefined;
}

export const MessageColumnWidthContext =
  createContext<SharedMessageColumnWidth | null>(null);

const resolveMessageColumn = (node: HTMLElement): Element | null =>
  node.closest("[data-message-column]");

interface MobileMessageOverflowPopoverProps {
  actions: readonly MessageOverflowAction[];
  alignment: MessageActionBarProps["alignment"];
  triggerClassName?: string;
}

function MobileMessageOverflowPopover({
  actions,
  alignment,
  triggerClassName,
}: MobileMessageOverflowPopoverProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const portalScopeProps = usePortalScopeProps();
  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);
  const selectAction = useCallback((action: MessageOverflowAction) => {
    flushSync(() => setOpen(false));
    action.onSelect();
  }, []);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(MOBILE_OVERFLOW_TRIGGER_CLASS, triggerClassName)}
          aria-label="Message actions"
          data-no-sidebar-swipe=""
          onMouseDown={preventOverlayTriggerSelection}
        >
          <Icon
            name={copied ? "Check" : "MoreHorizontal"}
            className={cn(
              "size-3",
              copied && "animate-in zoom-in-50 duration-150",
            )}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...portalScopeProps}
          side="top"
          align={alignment === "end" ? "end" : "start"}
          sideOffset={6}
          collisionPadding={8}
          className={MOBILE_OVERFLOW_CONTENT_CLASS}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {actions.map((action) => (
            <button
              key={action.key ?? action.label}
              type="button"
              className={MOBILE_OVERFLOW_ITEM_CLASS}
              disabled={action.disabled}
              onClick={() => {
                if (action.kind === "copy") {
                  void copyToClipboardWithToast(action.copyText ?? "", {
                    successMessage: null,
                    errorMessage: "Failed to copy",
                  }).then((didCopy) => {
                    if (!didCopy) return;
                    setCopied(true);
                    flushSync(() => setOpen(false));
                  });
                  return;
                }
                selectAction(action);
              }}
            >
              {action.plugin ? (
                <PluginActionIcon
                  pluginId={action.plugin.pluginId}
                  icon={action.plugin.icon}
                  className="size-3.5"
                />
              ) : (
                <Icon name={action.icon} className="size-3.5 shrink-0" />
              )}
              {action.label}
            </button>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

const ACTION_BUTTON_CLASS =
  "inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
const HOVER_REVEAL_CLASS =
  "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100";
const MOBILE_INLINE_ACTION_CLASS =
  "max-md:pointer-coarse:size-7 max-md:pointer-coarse:opacity-100 max-md:pointer-coarse:disabled:opacity-40 max-md:pointer-coarse:[&_svg]:size-4";
const MOBILE_OVERFLOW_ACTION_CLASS = "max-md:pointer-coarse:hidden";
const MOBILE_OVERFLOW_TRIGGER_CLASS =
  "hidden size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground max-md:pointer-coarse:inline-flex max-md:pointer-coarse:[&_svg]:size-4";
const ACTION_TOOLTIP_SIDE = "bottom";
const MENU_CONTENT_WIDTH_CLASS = "max-w-[min(16rem,calc(100vw-1rem))]";
const MOBILE_OVERFLOW_CONTENT_CLASS =
  "z-50 flex max-h-[50dvh] w-max min-w-32 max-w-[min(15rem,calc(100vw-1.5rem))] flex-col gap-0.5 overflow-y-auto rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";
const MOBILE_OVERFLOW_ITEM_CLASS =
  "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-state-active disabled:pointer-events-none disabled:opacity-40 select-none";

const ACTION_ROW_CLASS =
  "absolute top-0 flex max-w-full items-center gap-2 overflow-hidden has-[[data-state=open]]:[&_button]:opacity-100";
const ACTION_ROW_EXPANDED_CLASS = "absolute top-0 z-10 flex items-center gap-2";

const BUBBLE_ALIGN_INSET_CLASS = "pr-[13px] max-md:pointer-coarse:pr-[11px]";
const BUBBLE_ALIGN_OFFSET_CLASS =
  "right-[13px] max-md:pointer-coarse:right-[11px]";
const PROSE_ALIGN_INSET_CLASS = "-ml-1 max-md:pointer-coarse:-ml-1.5";
export const PROSE_COLUMN_INSET_CLASS = "px-2";
const PROSE_COLUMN_INSET_PX = 16;

export function findMessageActionTooltipCollisionBoundary(
  node: HTMLElement | null,
): HTMLElement | undefined {
  return node?.closest<HTMLElement>("[data-thread-window]") ?? undefined;
}

function DesktopMessageAction({
  action,
  className,
  collisionBoundary,
}: {
  action: MessageOverflowAction;
  className: string;
  collisionBoundary: HTMLElement | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {action.kind === "copy" ? (
          <CopyButton
            text={action.copyText ?? ""}
            imageUrl={action.copyImageUrl}
            label={action.label}
            className={className}
          />
        ) : (
          <button
            type="button"
            className={cn(ACTION_BUTTON_CLASS, className)}
            onClick={action.onSelect}
            disabled={action.disabled}
            aria-label={action.label}
          >
            {action.plugin ? (
              <PluginActionIcon
                pluginId={action.plugin.pluginId}
                icon={action.plugin.icon}
                className="size-3"
              />
            ) : (
              <Icon name={action.icon} className="size-3" />
            )}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent
        side={ACTION_TOOLTIP_SIDE}
        collisionBoundary={collisionBoundary}
      >
        {action.label}
      </TooltipContent>
    </Tooltip>
  );
}

function MessageActionMenuItems({
  actions,
}: {
  actions: readonly MessageOverflowAction[];
}) {
  return actions.map((action) => (
    <DropdownMenuItem
      key={action.key ?? action.label}
      disabled={action.disabled}
      onSelect={action.onSelect}
      textValue={action.label}
    >
      {action.plugin ? (
        <PluginActionIcon
          pluginId={action.plugin.pluginId}
          icon={action.plugin.icon}
        />
      ) : (
        <Icon name={action.icon} aria-hidden="true" />
      )}
      {action.label}
    </DropdownMenuItem>
  ));
}

export function MessageActionBar({
  messageText,
  alignment,
  mobileActionDisplay,
  addToChatAttachments = [],
  copyImageUrl,
  onAddToChat,
  onEdit,
  onFork,
  onSendToMain,
  disabled,
  pluginActions = [],
}: MessageActionBarProps) {
  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();
  const hasCopy = messageText.length > 0 || copyImageUrl !== undefined;
  const hasAddToChat =
    (hasCopy || addToChatAttachments.length > 0) && onAddToChat !== undefined;
  const [collisionBoundary, setCollisionBoundary] = useState<
    HTMLElement | undefined
  >();
  const useMobileOverflowPopover = isCompactViewport && isPointerCoarse;
  const { measureRef, width: availableWidth } = useMeasuredWidth({
    enabled: !(useMobileOverflowPopover && mobileActionDisplay === "overflow"),
  });
  const sharedColumnWidth = useContext(MessageColumnWidthContext);
  const { measureRef: measureColumnRef, width: ownColumnWidth } =
    useMeasuredWidth({
      enabled: sharedColumnWidth === null,
      resolveTarget: resolveMessageColumn,
    });
  const columnWidth =
    sharedColumnWidth === null
      ? ownColumnWidth
      : sharedColumnWidth.width === undefined
        ? undefined
        : sharedColumnWidth.width -
          (alignment === "start" ? PROSE_COLUMN_INSET_PX : 0);
  const [expanded, setExpanded] = useState(false);
  const expandedRowRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useCallback(
    (node: HTMLDivElement | null) => {
      measureRef(node);
      measureColumnRef(node);
    },
    [measureRef, measureColumnRef],
  );
  const desktopSlotRef = useCallback(
    (node: HTMLDivElement | null) => {
      slotRef(node);
      setCollisionBoundary(findMessageActionTooltipCollisionBoundary(node));
    },
    [slotRef],
  );
  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: PointerEvent) => {
      const row = expandedRowRef.current;
      if (row && event.target instanceof Node && row.contains(event.target)) {
        return;
      }
      setExpanded(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [expanded]);
  const handleExpandedRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement | null)?.closest("button")) {
      setExpanded(false);
    }
  };
  const [copiedFromRow, setCopiedFromRow] = useState(false);
  useEffect(() => {
    if (!copiedFromRow) return;
    const timeoutId = window.setTimeout(() => setCopiedFromRow(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copiedFromRow]);
  const mobileDirectActionClass =
    mobileActionDisplay === "inline"
      ? MOBILE_INLINE_ACTION_CLASS
      : MOBILE_OVERFLOW_ACTION_CLASS;
  const handleAddToChat = useCallback(() => {
    if (!onAddToChat) return;
    if (addToChatAttachments.length > 0) {
      onAddToChat(messageText, addToChatAttachments);
      return;
    }
    onAddToChat(messageText);
  }, [addToChatAttachments, messageText, onAddToChat]);
  const actions: MessageOverflowAction[] = [
    ...(hasCopy
      ? [
          {
            icon: "Copy" as const,
            label: "Copy message",
            onSelect: () => {
              void copyToClipboardWithToast(messageText, {
                errorMessage: "Failed to copy",
                imageUrl: copyImageUrl,
              });
            },
            copyText: messageText,
            copyImageUrl,
            kind: "copy" as const,
          },
        ]
      : []),
    ...(onEdit
      ? [
          {
            icon: "Edit" as const,
            label: "Edit message",
            onSelect: onEdit,
          },
        ]
      : []),
    ...(hasAddToChat
      ? [
          {
            icon: "MessageSquarePlus" as const,
            label: "Add to chat",
            onSelect: handleAddToChat,
          },
        ]
      : []),
    ...(onSendToMain
      ? [
          {
            icon: "ArrowTurnBackward" as const,
            label: "Send to main thread",
            onSelect: onSendToMain,
          },
        ]
      : []),
    ...(onFork
      ? [
          {
            icon: "Fork" as const,
            label: "Fork into new thread",
            onSelect: onFork,
            disabled,
          },
        ]
      : []),
    ...pluginActions.map((action) => ({
      icon: "Copy" as const,
      plugin: { pluginId: action.pluginId, icon: action.icon },
      key: action.key,
      label: action.label,
      onSelect: action.onSelect,
    })),
  ];

  if (actions.length === 0) {
    return null;
  }

  const rowClass = cn(
    ACTION_ROW_CLASS,
    alignment === "end"
      ? BUBBLE_ALIGN_OFFSET_CLASS
      : cn("left-0", PROSE_ALIGN_INSET_CLASS),
  );
  const slotClass = cn(
    "relative w-full",
    alignment === "end" && BUBBLE_ALIGN_INSET_CLASS,
  );

  if (useMobileOverflowPopover) {
    const layout =
      mobileActionDisplay === "overflow"
        ? { inlineCount: 0, overflowCount: actions.length }
        : computeMessageActionRowLayout({
            actionCount: actions.length,
            availableWidth,
            actionWidth: TOUCH_ACTION_WIDTH_PX,
            overflowTriggerWidth: TOUCH_ACTION_WIDTH_PX,
          });
    const canExpandInline =
      columnWidth !== undefined &&
      actionRowWidth(actions.length, TOUCH_ACTION_WIDTH_PX) <=
        columnWidth - EXPANDED_ROW_COMFORT_PX;
    if (expanded && canExpandInline) {
      return (
        <div ref={slotRef} className={cn(slotClass, "h-7")}>
          <div
            ref={expandedRowRef}
            className={cn(
              ACTION_ROW_EXPANDED_CLASS,
              alignment === "end"
                ? BUBBLE_ALIGN_OFFSET_CLASS
                : cn("left-0", PROSE_ALIGN_INSET_CLASS),
            )}
            onClick={handleExpandedRowClick}
          >
            <MobileInlineActions
              actions={actions}
              onCopied={() => setCopiedFromRow(true)}
            />
          </div>
        </div>
      );
    }
    return (
      <div ref={slotRef} className={cn(slotClass, "h-7")}>
        <div className={rowClass}>
          {layout.inlineCount > 0 ? (
            <MobileInlineActions
              actions={actions.slice(0, layout.inlineCount)}
            />
          ) : null}
          {layout.overflowCount > 0 ? (
            canExpandInline ? (
              <button
                type="button"
                className={cn(
                  MOBILE_OVERFLOW_TRIGGER_CLASS,
                  layout.inlineCount > 0 && OVERFLOW_TRIGGER_TIGHTEN_CLASS,
                )}
                aria-label="Message actions"
                aria-expanded={false}
                data-no-sidebar-swipe=""
                onClick={() => setExpanded(true)}
              >
                <Icon
                  name={copiedFromRow ? "Check" : "MoreHorizontal"}
                  className={cn(
                    "size-3",
                    copiedFromRow && "animate-in zoom-in-50 duration-150",
                  )}
                />
              </button>
            ) : (
              <MobileMessageOverflowPopover
                actions={actions.slice(layout.inlineCount)}
                alignment={alignment}
                triggerClassName={
                  layout.inlineCount > 0
                    ? OVERFLOW_TRIGGER_TIGHTEN_CLASS
                    : undefined
                }
              />
            )
          ) : null}
        </div>
      </div>
    );
  }

  const layout = computeMessageActionRowLayout({
    actionCount: actions.length,
    availableWidth,
    actionWidth: DESKTOP_ACTION_WIDTH_PX,
    overflowTriggerWidth: DESKTOP_ACTION_WIDTH_PX,
  });

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={desktopSlotRef}
        className={cn(slotClass, "h-5 max-md:pointer-coarse:h-7")}
      >
        <div className={rowClass}>
          {actions.slice(0, layout.inlineCount).map((action) => (
            <DesktopMessageAction
              key={action.key ?? action.label}
              action={action}
              className={cn(HOVER_REVEAL_CLASS, mobileDirectActionClass)}
              collisionBoundary={collisionBoundary}
            />
          ))}
          {layout.overflowCount > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    ACTION_BUTTON_CLASS,
                    HOVER_REVEAL_CLASS,
                    mobileDirectActionClass,
                    layout.inlineCount > 0 && OVERFLOW_TRIGGER_TIGHTEN_CLASS,
                    "data-[state=open]:text-foreground data-[state=open]:opacity-100",
                  )}
                  aria-label="More actions"
                >
                  <Icon name="MoreHorizontal" className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align={alignment === "end" ? "end" : "start"}
                mobileTitle="Message actions"
                className={MENU_CONTENT_WIDTH_CLASS}
              >
                <MessageActionMenuItems
                  actions={actions.slice(layout.inlineCount)}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {mobileActionDisplay === "overflow" ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={MOBILE_OVERFLOW_TRIGGER_CLASS}
                  aria-label="Message actions"
                  data-no-sidebar-swipe=""
                >
                  <Icon name="MoreHorizontal" className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align={alignment === "end" ? "end" : "start"}
                mobileTitle="Message actions"
                className={MENU_CONTENT_WIDTH_CLASS}
              >
                <MessageActionMenuItems actions={actions} />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}

function MobileInlineActions({
  actions,
  onCopied,
}: {
  actions: readonly MessageOverflowAction[];
  onCopied?: () => void;
}) {
  return actions.map((action) =>
    action.kind === "copy" ? (
      onCopied ? (
        <button
          key={action.key ?? action.label}
          type="button"
          className={cn(
            ACTION_BUTTON_CLASS,
            HOVER_REVEAL_CLASS,
            MOBILE_INLINE_ACTION_CLASS,
          )}
          onClick={() => {
            void copyToClipboardWithToast(action.copyText ?? "", {
              successMessage: null,
              errorMessage: "Failed to copy",
              imageUrl: action.copyImageUrl,
            }).then((didCopy) => {
              if (didCopy) onCopied();
            });
          }}
          aria-label={action.label}
        >
          <Icon name="Copy" className="size-3" />
        </button>
      ) : (
        <CopyButton
          key={action.key ?? action.label}
          text={action.copyText ?? ""}
          imageUrl={action.copyImageUrl}
          label={action.label}
          className={cn(HOVER_REVEAL_CLASS, MOBILE_INLINE_ACTION_CLASS)}
        />
      )
    ) : (
      <button
        key={action.key ?? action.label}
        type="button"
        className={cn(
          ACTION_BUTTON_CLASS,
          HOVER_REVEAL_CLASS,
          MOBILE_INLINE_ACTION_CLASS,
        )}
        onClick={action.onSelect}
        disabled={action.disabled}
        aria-label={action.label}
      >
        {action.plugin ? (
          <PluginActionIcon
            pluginId={action.plugin.pluginId}
            icon={action.plugin.icon}
            className="size-3"
          />
        ) : (
          <Icon name={action.icon} className="size-3" />
        )}
      </button>
    ),
  );
}
