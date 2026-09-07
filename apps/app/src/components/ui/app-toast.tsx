import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { toast as sonnerToast, type Action, type ExternalToast } from "sonner";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  openNotificationCenter,
  recordNotification,
} from "@/lib/notifications/notification-store";

export type AppToastTone =
  | "message"
  | "success"
  | "warning"
  | "error"
  | "loading";

type AppToastForwardedOptionKey =
  | "className"
  | "classNames"
  | "dismissible"
  | "duration"
  | "id"
  | "invert"
  | "onAutoClose"
  | "onDismiss"
  | "position"
  | "richColors"
  | "style"
  | "unstyled";

export interface AppToastOptions extends Pick<
  ExternalToast,
  AppToastForwardedOptionKey
> {
  action?: Action;
  cancel?: Action;
  description?: ReactNode;
}

interface AppToastContentProps {
  action?: Action;
  cancel?: Action;
  description?: ReactNode;
  dismissible?: boolean;
  id?: number | string;
  notificationId?: string | null;
  onDismiss?: () => void;
  title: ReactNode;
  tone: AppToastTone;
}

interface AppToastDescriptionProps {
  description: ReactNode;
  notificationId: string | null;
  onShowMore: () => void;
}

interface AppToastOverflowTextProps {
  className?: string;
  content: ReactNode;
  notificationId: string | null;
  onShowMore: () => void;
  testId: string;
}

interface ShowAppToastParams {
  options?: AppToastOptions;
  title: ReactNode;
  tone: AppToastTone;
}

interface AppToastActionButtonProps {
  action: Action;
  id?: number | string;
  priority: "primary" | "secondary";
}

type AppToastMethod = (
  title: ReactNode,
  options?: AppToastOptions,
) => string | number;

const DEFAULT_TOAST_DURATION = 4000;

export function iconForTone(tone: AppToastTone): IconName {
  switch (tone) {
    case "success":
      return "CircleCheck";
    case "warning":
      return "AlertTriangle";
    case "error":
      return "AlertCircle";
    case "loading":
      return "Loading";
    case "message":
      return "Info";
  }
}

function dismissToast(id: number | string | undefined): void {
  if (id === undefined) {
    return;
  }
  sonnerToast.dismiss(id);
}

function AppToastActionButton({
  action,
  id,
  priority,
}: AppToastActionButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    action.onClick(event);
    if (priority === "primary" && event.defaultPrevented) {
      return;
    }
    dismissToast(id);
  };

  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto shrink-0 px-0 py-0 text-xs text-muted-foreground underline underline-offset-4"
      onClick={handleClick}
    >
      {action.label}
    </Button>
  );
}

function AppToastOverflowText({
  className,
  content,
  notificationId,
  onShowMore,
  testId,
}: AppToastOverflowTextProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) {
      return;
    }
    setTruncated(body.scrollWidth - body.clientWidth > 1);
  }, [content]);

  return (
    <>
      <div
        ref={bodyRef}
        data-testid={testId}
        className={cn("min-w-0 flex-1 truncate", className)}
      >
        {content}
      </div>
      {truncated && notificationId !== null ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto shrink-0 px-0 py-0 text-xs text-muted-foreground underline underline-offset-4"
          onClick={onShowMore}
        >
          Show more
        </Button>
      ) : null}
    </>
  );
}

export function AppToastDescription({
  description,
  notificationId,
  onShowMore,
}: AppToastDescriptionProps) {
  return (
    <AppToastOverflowText
      content={description}
      notificationId={notificationId}
      onShowMore={onShowMore}
      testId="app-toast-description"
    />
  );
}

export function AppToastContent({
  action,
  cancel,
  description,
  dismissible = true,
  id,
  notificationId = null,
  onDismiss,
  title,
  tone,
}: AppToastContentProps) {
  const hasActions = action !== undefined || cancel !== undefined;
  const showNotification = () => {
    dismissToast(id);
    openNotificationCenter(notificationId);
  };
  const actions = hasActions ? (
    <>
      {action ? (
        <AppToastActionButton action={action} id={id} priority="primary" />
      ) : null}
      {cancel ? (
        <AppToastActionButton action={cancel} id={id} priority="secondary" />
      ) : null}
    </>
  ) : null;

  return (
    <div className="w-[var(--width,356px)] max-w-[calc(100vw-32px)] shrink-0 rounded-md border border-border bg-popover px-4 py-3 text-popover-foreground shadow-sm max-[600px]:w-[calc(100vw-32px)]">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-foreground">
          <Icon
            name={iconForTone(tone)}
            className={cn("size-4", tone === "loading" && "animate-spin")}
            style={{ margin: 0 }}
            aria-hidden
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {description ? (
              <div className="min-w-0 flex-1 truncate text-sm font-medium leading-5">
                {title}
              </div>
            ) : (
              <AppToastOverflowText
                className="text-sm font-medium leading-5"
                content={title}
                notificationId={notificationId}
                onShowMore={showNotification}
                testId="app-toast-title"
              />
            )}
          </div>
          {description || hasActions ? (
            <div className="mt-0.5 flex min-w-0 flex-nowrap items-center gap-2 text-xs leading-5 text-muted-foreground">
              {description ? (
                <AppToastDescription
                  description={description}
                  notificationId={notificationId}
                  onShowMore={showNotification}
                />
              ) : null}
              {actions}
            </div>
          ) : null}
        </div>
        {dismissible ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mr-1 -mt-1 size-6 shrink-0 text-muted-foreground"
            aria-label="Dismiss notification"
            onClick={() => (onDismiss ? onDismiss() : dismissToast(id))}
          >
            <Icon
              name="X"
              className="size-3.5"
              style={{ margin: 0 }}
              aria-hidden
            />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function showAppToast({
  options,
  title,
  tone,
}: ShowAppToastParams): string | number {
  const {
    action,
    cancel,
    className,
    description,
    dismissible = true,
    duration,
    ...sonnerOptions
  } = options ?? {};
  const nextDuration =
    duration ?? (tone === "loading" ? Infinity : DEFAULT_TOAST_DURATION);
  const notificationId =
    tone === "loading"
      ? null
      : recordNotification({
          toastId: sonnerOptions.id ?? null,
          tone,
          title,
          description: description ?? null,
          createdAt: Date.now(),
        });

  return sonnerToast.custom(
    (id) => (
      <AppToastContent
        action={action}
        cancel={cancel}
        description={description}
        dismissible={dismissible}
        id={id}
        notificationId={notificationId}
        title={title}
        tone={tone}
      />
    ),
    {
      ...sonnerOptions,
      className: cn("bb-app-toast", className),
      dismissible,
      duration: nextDuration,
    },
  );
}

const showMessageToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "message" });

const showSuccessToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "success" });

const showWarningToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "warning" });

const showErrorToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "error" });

const showLoadingToast: AppToastMethod = (title, options) =>
  showAppToast({ options, title, tone: "loading" });

export const appToast = {
  dismiss: sonnerToast.dismiss,
  error: showErrorToast,
  loading: showLoadingToast,
  message: showMessageToast,
  success: showSuccessToast,
  warning: showWarningToast,
};
