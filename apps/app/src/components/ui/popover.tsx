import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  type ResponsiveOverlayContextValue,
  useResponsiveRoot,
  MobileTrigger,
  stripRadixContentProps,
} from "@/components/ui/responsive-overlay"

// ---------------------------------------------------------------------------
// Context — separate instance from DropdownMenu
// ---------------------------------------------------------------------------

const ResponsivePopoverContext =
  React.createContext<ResponsiveOverlayContextValue>({
    isMobile: false,
    open: false,
    onOpenChange: () => {},
  })

function useResponsivePopover() {
  return React.useContext(ResponsivePopoverContext)
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function Popover({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnChange,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const ctx = useResponsiveRoot(controlledOpen, controlledOnChange)

  if (ctx.isMobile) {
    return (
      <ResponsivePopoverContext.Provider value={ctx}>
        {children}
      </ResponsivePopoverContext.Provider>
    )
  }

  return (
    <PopoverPrimitive.Root
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      {...props}
    >
      <ResponsivePopoverContext.Provider value={ctx}>
        {children}
      </ResponsivePopoverContext.Provider>
    </PopoverPrimitive.Root>
  )
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

const PopoverTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(({ asChild, children, ...props }, ref) => {
  const { isMobile, open, onOpenChange } = useResponsivePopover()

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
    <PopoverPrimitive.Trigger ref={ref} asChild={asChild} {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  )
})
PopoverTrigger.displayName = "PopoverTrigger"

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const PopoverContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    /** Title announced by screen readers when the mobile drawer opens. */
    mobileTitle?: string
    /** Class name applied to the DrawerContent wrapper on mobile. */
    mobileClassName?: string
  }
>(({ className, align = "center", sideOffset = 4, children, mobileTitle, mobileClassName, ...props }, ref) => {
  const { isMobile, open, onOpenChange } = useResponsivePopover()

  if (isMobile) {
    // Forward DOM-level props (event handlers, data-*, aria-*) but strip
    // Radix positioning/behavior props that are meaningless for a Drawer.
    const domProps = stripRadixContentProps(props)

    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className={mobileClassName}>
          <DrawerTitle className="sr-only">
            {mobileTitle ?? "Options"}
          </DrawerTitle>
          <div
            ref={ref}
            className={cn(
              "overflow-y-auto px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]",
            )}
            {...domProps}
          >
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-96 rounded-md border bg-background p-4 text-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
})
PopoverContent.displayName = "PopoverContent"

// ---------------------------------------------------------------------------
// Anchor (desktop-only positioning concept — passthrough on mobile)
// ---------------------------------------------------------------------------

const PopoverAnchor = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Anchor>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Anchor>
>(({ children, ...props }, ref) => {
  const { isMobile } = useResponsivePopover()

  if (isMobile) {
    return <>{children}</>
  }

  return (
    <PopoverPrimitive.Anchor ref={ref} {...props}>
      {children}
    </PopoverPrimitive.Anchor>
  )
})
PopoverAnchor.displayName = "PopoverAnchor"

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
