import * as React from "react";
import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

type SwitchProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "onChange" | "role"
> & {
  checked: boolean;
  size?: "default" | "sm";
  onCheckedChange?: (checked: boolean) => void;
};

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      className,
      disabled,
      size = "sm",
      onCheckedChange,
      onClick,
      ...props
    },
    ref,
  ) => (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-state={checked ? "checked" : "unchecked"}
      className={cn(
        `peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input shadow-xs ${CONTROL_HOVER_TRANSITION} outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted`,
        size === "default" && "h-5 w-9",
        size === "sm" && "h-4 w-7",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
    >
      <span
        aria-hidden
        data-state={checked ? "checked" : "unchecked"}
        className={cn(
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform data-[state=unchecked]:translate-x-0",
          size === "default" && "size-4 data-[state=checked]:translate-x-4",
          size === "sm" && "size-3 data-[state=checked]:translate-x-3",
        )}
      />
    </button>
  ),
);
Switch.displayName = "Switch";

export { Switch };
