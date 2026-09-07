import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { useBrowserDimmingModal } from "../../hooks/useBrowserDimmingModal";
import {
  type ResponsiveOverlayContextValue,
  useResponsiveRoot,
  MobileTrigger,
  ResponsiveDrawerShell,
  stripRadixContentProps,
} from "./responsive-overlay.js";
import {
  blurActiveKeyboardInputBeforeOverlayOpen,
  getOverlayTriggerClassName,
  preventOverlayTriggerSelection,
} from "./overlay-trigger.js";
import { Icon } from "../../components/ui/icon.js";

interface ResponsiveDialogContextValue extends ResponsiveOverlayContextValue {
  titleId: string;
  descriptionId: string;
  registerTitleId: (id: string) => () => void;
  registerDescriptionId: (id: string) => () => void;
}

const ResponsiveDialogContext =
  React.createContext<ResponsiveDialogContextValue>({
    isCompactViewport: false,
    open: false,
    onOpenChange: () => {},
    titleId: "",
    descriptionId: "",
    registerTitleId: () => () => {},
    registerDescriptionId: () => () => {},
  });

function useResponsiveDialog() {
  return React.useContext(ResponsiveDialogContext);
}

function Dialog({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const responsiveRoot = useResponsiveRoot(controlledOpen, controlledOnChange);
  const generatedTitleId = React.useId();
  const generatedDescriptionId = React.useId();
  const [titleId, setTitleId] = React.useState(generatedTitleId);
  const [descriptionId, setDescriptionId] = React.useState(
    generatedDescriptionId,
  );
  const registerTitleId = React.useCallback(
    (id: string) => {
      setTitleId(id);
      return () => setTitleId(generatedTitleId);
    },
    [generatedTitleId],
  );
  const registerDescriptionId = React.useCallback(
    (id: string) => {
      setDescriptionId(id);
      return () => setDescriptionId(generatedDescriptionId);
    },
    [generatedDescriptionId],
  );
  const ctx = React.useMemo(
    () => ({
      ...responsiveRoot,
      titleId,
      descriptionId,
      registerTitleId,
      registerDescriptionId,
    }),
    [
      descriptionId,
      registerDescriptionId,
      registerTitleId,
      responsiveRoot,
      titleId,
    ],
  );

  const body = ctx.isCompactViewport ? (
    children
  ) : (
    <DialogPrimitive.Root
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      {...props}
    >
      {children}
    </DialogPrimitive.Root>
  );

  return (
    <ResponsiveDialogContext.Provider value={ctx}>
      {body}
    </ResponsiveDialogContext.Provider>
  );
}

const DialogTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(({ asChild, children, className, ...props }, ref) => {
  const { isCompactViewport, open, onOpenChange } = useResponsiveDialog();

  if (isCompactViewport) {
    return (
      <MobileTrigger
        ref={ref}
        asChild={asChild}
        open={open}
        onOpenChange={onOpenChange}
        haspopup="dialog"
        className={className}
        {...props}
      >
        {children}
      </MobileTrigger>
    );
  }

  return (
    <DialogPrimitive.Trigger
      ref={ref}
      asChild={asChild}
      className={getOverlayTriggerClassName(className)}
      onMouseDown={(event) => {
        if (!open) {
          blurActiveKeyboardInputBeforeOverlayOpen();
        }
        preventOverlayTriggerSelection(event);
      }}
      {...props}
    >
      {children}
    </DialogPrimitive.Trigger>
  );
});
DialogTrigger.displayName = "DialogTrigger";

interface DialogCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

const DialogClose = React.forwardRef<HTMLButtonElement, DialogCloseProps>(
  ({ asChild, onClick, children, ...props }, ref) => {
    const { isCompactViewport, onOpenChange } = useResponsiveDialog();

    if (isCompactViewport) {
      const Comp = asChild ? Slot : "button";
      const handleClick: React.MouseEventHandler<HTMLButtonElement> = (
        event,
      ) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onOpenChange(false);
        }
      };
      return (
        <Comp ref={ref} onClick={handleClick} {...props}>
          {children}
        </Comp>
      );
    }

    return (
      <DialogPrimitive.Close
        ref={ref}
        asChild={asChild}
        onClick={onClick}
        {...props}
      >
        {children}
      </DialogPrimitive.Close>
    );
  },
);
DialogClose.displayName = "DialogClose";

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    {...usePortalScopeProps()}
    className={cn(
      "fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  onAfterCloseAutoFocus?: () => void;
  hideCloseButton?: boolean;
};

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      className,
      children,
      hideCloseButton = false,
      onAfterCloseAutoFocus,
      onCloseAutoFocus,
      ...props
    },
    ref,
  ) => {
    const { isCompactViewport, open, onOpenChange, titleId, descriptionId } =
      useResponsiveDialog();
    useBrowserDimmingModal(open);
    const scopeProps = usePortalScopeProps();

    if (isCompactViewport) {
      const domProps = stripRadixContentProps(props);
      return (
        <ResponsiveDrawerShell
          open={open}
          onOpenChange={onOpenChange}
          onAfterCloseAutoFocus={onAfterCloseAutoFocus}
          labelledBy={titleId}
          describedBy={descriptionId}
        >
          <div
            ref={ref}
            className={cn(
              "grid grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]",
              className,
              "max-w-none",
            )}
            {...domProps}
          >
            {children}
          </div>
        </ResponsiveDrawerShell>
      );
    }

    return (
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          {...scopeProps}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            queueMicrotask(() => onAfterCloseAutoFocus?.());
          }}
          className={cn(
            "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-sm duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
            className,
          )}
          {...props}
        >
          {children}
          {hideCloseButton ? null : (
            <DialogPrimitive.Close className="absolute right-4 top-4 cursor-pointer rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-state-active data-[state=open]:text-foreground">
              <Icon name="X" className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);
DialogContent.displayName = "DialogContent";

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ asChild, className, id, children, ...props }, ref) => {
  const { isCompactViewport, titleId, registerTitleId } = useResponsiveDialog();
  const resolvedId = id ?? titleId;
  React.useLayoutEffect(() => {
    if (!isCompactViewport) {
      return;
    }
    return registerTitleId(resolvedId);
  }, [isCompactViewport, registerTitleId, resolvedId]);

  if (isCompactViewport) {
    const titleProps = {
      id: resolvedId,
      className: cn(
        "text-base font-semibold leading-none tracking-tight",
        className,
      ),
      ...props,
    };
    if (asChild) {
      return (
        <Slot ref={ref} {...titleProps}>
          {children}
        </Slot>
      );
    }
    return (
      <h2 ref={ref} {...titleProps}>
        {children}
      </h2>
    );
  }
  return (
    <DialogPrimitive.Title
      ref={ref}
      asChild={asChild}
      {...(id === undefined ? {} : { id })}
      className={cn(
        "text-base font-semibold leading-none tracking-tight",
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Title>
  );
});
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ asChild, className, id, children, ...props }, ref) => {
  const { isCompactViewport, descriptionId, registerDescriptionId } =
    useResponsiveDialog();
  const resolvedId = id ?? descriptionId;
  React.useLayoutEffect(() => {
    if (!isCompactViewport) {
      return;
    }
    return registerDescriptionId(resolvedId);
  }, [isCompactViewport, registerDescriptionId, resolvedId]);

  if (isCompactViewport) {
    const descriptionProps = {
      id: resolvedId,
      className: cn("text-sm text-muted-foreground", className),
      ...props,
    };
    if (asChild) {
      return (
        <Slot ref={ref} {...descriptionProps}>
          {children}
        </Slot>
      );
    }
    return (
      <p ref={ref} {...descriptionProps}>
        {children}
      </p>
    );
  }
  return (
    <DialogPrimitive.Description
      ref={ref}
      asChild={asChild}
      {...(id === undefined ? {} : { id })}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    >
      {children}
    </DialogPrimitive.Description>
  );
});
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
