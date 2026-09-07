import * as React from "react";

const MENU_NAV_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
]);

export const MENU_ITEM_LAST_HOVERED_CLASS =
  "data-[last-hovered]:bg-state-hover data-[last-hovered]:text-foreground";

interface MenuHoverContextValue {
  lastHoveredId: string | null;
  setLastHovered: (id: string) => void;
  clearLastHovered: () => void;
}

const MenuHoverContext = React.createContext<MenuHoverContextValue>({
  lastHoveredId: null,
  setLastHovered: () => {},
  clearLastHovered: () => {},
});

export function MenuHoverProvider({ children }: { children: React.ReactNode }) {
  const [lastHoveredId, setLastHoveredId] = React.useState<string | null>(null);
  const value = React.useMemo<MenuHoverContextValue>(
    () => ({
      lastHoveredId,
      setLastHovered: setLastHoveredId,
      clearLastHovered: () => setLastHoveredId(null),
    }),
    [lastHoveredId],
  );
  return (
    <MenuHoverContext.Provider value={value}>
      {children}
    </MenuHoverContext.Provider>
  );
}

export interface MenuItemHoverProps {
  "data-last-hovered": "" | undefined;
  onPointerEnter: React.PointerEventHandler;
  onKeyDown: React.KeyboardEventHandler;
}

interface MenuItemHoverHandlers {
  onPointerEnter?: React.PointerEventHandler;
  onKeyDown?: React.KeyboardEventHandler;
}

export function useMenuItemHover(handlers?: MenuItemHoverHandlers): {
  isLastHovered: boolean;
  hoverProps: MenuItemHoverProps;
} {
  const id = React.useId();
  const { lastHoveredId, setLastHovered, clearLastHovered } =
    React.useContext(MenuHoverContext);
  const isLastHovered = lastHoveredId === id;

  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;

  const onPointerEnter = React.useCallback(
    (event: React.PointerEvent) => {
      handlersRef.current?.onPointerEnter?.(event);
      setLastHovered(id);
    },
    [id, setLastHovered],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      handlersRef.current?.onKeyDown?.(event);
      if (MENU_NAV_KEYS.has(event.key)) {
        clearLastHovered();
      }
    },
    [clearLastHovered],
  );

  return {
    isLastHovered,
    hoverProps: {
      "data-last-hovered": isLastHovered ? "" : undefined,
      onPointerEnter,
      onKeyDown,
    },
  };
}
