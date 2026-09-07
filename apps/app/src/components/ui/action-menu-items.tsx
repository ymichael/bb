import type { ReactNode } from "react";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@bb/shared-ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@bb/shared-ui/dropdown-menu";
import { cn } from "@bb/shared-ui/lib/utils";

type ActionMenuSurface = "context" | "dropdown";

interface ActionMenuItemProps {
  children: ReactNode;
  className?: string;
  variant?: "default" | "destructive";
  icon: IconName;
  onSelect?: (event: Event) => void;
  surface: ActionMenuSurface;
}

interface ActionMenuSeparatorProps {
  surface: ActionMenuSurface;
}

export function ActionMenuItem({
  children,
  className,
  variant,
  icon,
  onSelect,
  surface,
}: ActionMenuItemProps) {
  const content = (
    <>
      <Icon name={icon} aria-hidden="true" />
      {children}
    </>
  );

  if (surface === "context") {
    return (
      <ContextMenuItem
        className={cn(
          className,
          variant === "destructive" &&
            "text-destructive focus:bg-destructive/15 focus:text-destructive data-[last-hovered]:bg-destructive/15 data-[last-hovered]:text-destructive",
        )}
        onSelect={onSelect}
      >
        {content}
      </ContextMenuItem>
    );
  }

  return (
    <DropdownMenuItem
      className={className}
      variant={variant}
      onSelect={onSelect}
    >
      {content}
    </DropdownMenuItem>
  );
}

export function ActionMenuSeparator({ surface }: ActionMenuSeparatorProps) {
  return surface === "context" ? (
    <ContextMenuSeparator />
  ) : (
    <DropdownMenuSeparator />
  );
}
