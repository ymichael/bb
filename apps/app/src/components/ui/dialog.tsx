import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Slot } from "@radix-ui/react-slot"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Drawer,
  DrawerContent,
  DrawerTitle as DrawerTitlePrimitive,
} from "@/components/ui/drawer"
import {
  type ResponsiveOverlayContextValue,
  useResponsiveRoot,
  MobileTrigger,
} from "@/components/ui/responsive-overlay"

// ---------------------------------------------------------------------------
// Context — separate instance from DropdownMenu / Popover.
// ---------------------------------------------------------------------------

const ResponsiveDialogContext =
  React.createContext<ResponsiveOverlayContextValue>({
    isMobile: false,
    open: false,
    onOpenChange: () => {},
  })

function useResponsiveDialog() {
  return React.useContext(ResponsiveDialogContext)
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function Dialog({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const ctx = useResponsiveRoot(controlledOpen, controlledOnChange)

  if (ctx.isMobile) {
    return (
      <ResponsiveDialogContext.Provider value={ctx}>
        {children}
      </ResponsiveDialogContext.Provider>
    )
  }

  return (
    <DialogPrimitive.Root
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      {...props}
    >
      <ResponsiveDialogContext.Provider value={ctx}>
        {children}
      </ResponsiveDialogContext.Provider>
    </DialogPrimitive.Root>
  )
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

const DialogTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(({ asChild, children, ...props }, ref) => {
  const { isMobile, open, onOpenChange } = useResponsiveDialog()

  if (isMobile) {
    return (
      <MobileTrigger
        ref={ref}
        asChild={asChild}
        open={open}
        onOpenChange={onOpenChange}
        haspopup="dialog"
        {...props}
      >
        {children}
      </MobileTrigger>
    )
  }

  return (
    <DialogPrimitive.Trigger ref={ref} asChild={asChild} {...props}>
      {children}
    </DialogPrimitive.Trigger>
  )
})
DialogTrigger.displayName = "DialogTrigger"

// ---------------------------------------------------------------------------
// Close — closes the dialog/drawer. Works in both modes.
// ---------------------------------------------------------------------------

interface DialogCloseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean
}

const DialogClose = React.forwardRef<HTMLButtonElement, DialogCloseProps>(
  ({ asChild, onClick, children, ...props }, ref) => {
    const { isMobile, onOpenChange } = useResponsiveDialog()

    if (isMobile) {
      const Comp = asChild ? Slot : "button"
      const handleClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
        onClick?.(event)
        if (!event.defaultPrevented) {
          onOpenChange(false)
        }
      }
      return (
        <Comp ref={ref} onClick={handleClick} {...props}>
          {children}
        </Comp>
      )
    }

    return (
      <DialogPrimitive.Close ref={ref} asChild={asChild} onClick={onClick} {...props}>
        {children}
      </DialogPrimitive.Close>
    )
  },
)
DialogClose.displayName = "DialogClose"

// ---------------------------------------------------------------------------
// Overlay — desktop only. Kept for backwards compatibility; the drawer
// provides its own overlay on mobile.
// ---------------------------------------------------------------------------

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const { isMobile, open, onOpenChange } = useResponsiveDialog()

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div
            ref={ref}
            className={cn(
              "grid gap-4 overflow-y-auto px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]",
              className,
            )}
          >
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})
DialogContent.displayName = "DialogContent"

// ---------------------------------------------------------------------------
// Header / Footer — layout primitives, unchanged.
// ---------------------------------------------------------------------------

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className,
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

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
)
DialogFooter.displayName = "DialogFooter"

// ---------------------------------------------------------------------------
// Title / Description — render through the drawer's primitives on mobile so
// Radix Drawer/Vaul announces them to assistive tech.
// ---------------------------------------------------------------------------

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => {
  const { isMobile } = useResponsiveDialog()
  const Comp = isMobile ? DrawerTitlePrimitive : DialogPrimitive.Title
  return (
    <Comp
      ref={ref}
      className={cn("text-lg font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  )
})
DialogTitle.displayName = "DialogTitle"

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

// ---------------------------------------------------------------------------
// Portal — desktop only. Unused externally but kept for parity.
// ---------------------------------------------------------------------------

const DialogPortal = DialogPrimitive.Portal

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
