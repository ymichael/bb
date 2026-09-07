import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Popover, PopoverAnchor, PopoverContent } from "@bb/shared-ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { appToast, iconForTone } from "@/components/ui/app-toast";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  clearNotifications,
  closeNotificationCenter,
  dismissNotification,
  toggleNotificationCenter,
  useNotificationCenterState,
  useNotifications,
  type AppNotification,
} from "@/lib/notifications/notification-store";

interface NotificationRowProps {
  focused: boolean;
  notification: AppNotification;
  now: number;
}

const ROW_ACTION_CLASS =
  "rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/notification:opacity-100";

function NotificationCopyButton({
  bodyRef,
}: {
  bodyRef: { current: HTMLDivElement | null };
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeoutId = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label="Copy notification"
      className={ROW_ACTION_CLASS}
      onClick={() => {
        const text = bodyRef.current?.textContent ?? "";
        if (text.length === 0) {
          return;
        }
        void copyTextToClipboard(text).then((success) => {
          if (success) {
            setCopied(true);
          }
        });
      }}
    >
      <Icon name={copied ? "Check" : "Copy"} className="size-3.5" />
    </button>
  );
}

function NotificationRow({ focused, notification, now }: NotificationRowProps) {
  const rowRef = useRef<HTMLLIElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focused) {
      return;
    }
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <li
      ref={rowRef}
      data-testid="notification-row"
      data-focused={focused}
      className={cn(
        "group/notification flex items-start gap-2.5 px-3 py-2.5",
        focused && "bg-accent/60",
      )}
    >
      <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-foreground">
        <Icon name={iconForTone(notification.tone)} className="size-4" />
      </div>
      <div ref={bodyRef} className="min-w-0 flex-1">
        <div className="break-words text-sm font-medium leading-5">
          {notification.title}
        </div>
        {notification.description === null ? null : (
          <div className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">
            {notification.description}
          </div>
        )}
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          {formatRelativeTime({ timestamp: notification.createdAt, now })}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <NotificationCopyButton bodyRef={bodyRef} />
        <button
          type="button"
          aria-label="Dismiss notification"
          className={ROW_ACTION_CLASS}
          onClick={() => {
            dismissNotification(notification.id);
          }}
        >
          <Icon name="X" className="size-3.5" />
        </button>
      </div>
    </li>
  );
}

interface HeaderActionProps {
  disabled: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}

function HeaderAction({ disabled, icon, label, onClick }: HeaderActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          onClick={onClick}
        >
          <Icon name={icon} className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export function NotificationCenter() {
  const { open, focusedId } = useNotificationCenterState();
  const notifications = useNotifications();
  const now = Date.now();

  useAppCommandHandler("notifications.open", () => {
    toggleNotificationCenter();
    return true;
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    appToast.dismiss();
  }, [open]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeNotificationCenter();
        }
      }}
    >
      <PopoverAnchor asChild>
        <div
          aria-hidden="true"
          className="pointer-events-none fixed bottom-4 right-4 size-0"
        />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        mobileTitle="Notifications"
        aria-label="Notifications"
        data-testid="notification-center"
        className="w-96 max-w-[calc(100vw-2rem)] p-0"
        mobileClassName="p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="text-sm font-medium leading-5">Notifications</div>
          <TooltipProvider delayDuration={300} disableHoverableContent>
            <div className="flex items-center gap-0.5">
              <HeaderAction
                icon="Trash2"
                label="Clear all"
                disabled={notifications.length === 0}
                onClick={clearNotifications}
              />
              <HeaderAction
                icon="X"
                label="Hide notifications"
                disabled={false}
                onClick={closeNotificationCenter}
              />
            </div>
          </TooltipProvider>
        </div>
        {notifications.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs leading-5 text-muted-foreground">
            No notifications yet.
          </div>
        ) : (
          <ul className="max-h-[min(60vh,26rem)] divide-y divide-border overflow-y-auto">
            {notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                focused={notification.id === focusedId}
                notification={notification}
                now={now}
              />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
