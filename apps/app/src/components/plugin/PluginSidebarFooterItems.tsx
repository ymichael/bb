import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "react-router-dom";
import type { ExperimentalSidebarFooterCommandKind } from "@get-bb/plugin-sdk/internal/plugin-app-collector";
import { cn } from "@bb/shared-ui/lib/utils";
import { COARSE_POINTER_CHILD_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar.js";
import { PluginIcon, pluginIconName } from "@/components/plugin/PluginIcon";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  usePluginSlots,
  type PluginSidebarFooterItemSlot,
} from "@/lib/plugin-slots";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";

const SIDEBAR_FOOTER_ACTION_CLASS = cn(
  COARSE_POINTER_CHILD_ICON_BUTTON_CLASS,
  "text-muted-foreground hover:text-sidebar-foreground [&>svg]:opacity-80",
);

function footerItemKey(item: PluginSidebarFooterItemSlot): string {
  return `${item.pluginId}/${item.id}/${item.generation}`;
}

function footerDisclosureId(item: PluginSidebarFooterItemSlot): string {
  return `plugin-sidebar-footer-disclosure-${item.pluginId}-${item.id}-${item.generation}`;
}

function footerTriggerId(item: PluginSidebarFooterItemSlot): string {
  return `plugin-sidebar-footer-trigger-${item.pluginId}-${item.id}-${item.generation}`;
}

export function usePluginSidebarFooterDisclosure() {
  const { sidebarFooterItems } = usePluginSlots();
  const disclosures = useMemo(
    () => sidebarFooterItems.filter((item) => item.kind === "disclosure"),
    [sidebarFooterItems],
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [suppressedTooltipKey, setSuppressedTooltipKey] = useState<
    string | null
  >(null);
  const lastProgrammaticCommand = useRef(0);
  const activeItem = useMemo(
    () => disclosures.find((item) => footerItemKey(item) === activeKey) ?? null,
    [activeKey, disclosures],
  );
  const suppressedTooltipItem = useMemo(
    () =>
      disclosures.find(
        (item) => footerItemKey(item) === suppressedTooltipKey,
      ) ?? null,
    [disclosures, suppressedTooltipKey],
  );

  const handleCommand = useCallback(
    (
      itemKey: string,
      command: ExperimentalSidebarFooterCommandKind,
      sequence?: number,
    ) => {
      if (sequence !== undefined) {
        if (sequence <= lastProgrammaticCommand.current) return;
        lastProgrammaticCommand.current = sequence;
      }
      const isClosing =
        (command === "close" && activeKey === itemKey) ||
        (command === "toggle" && activeKey === itemKey);
      setSuppressedTooltipKey(isClosing ? itemKey : null);
      setActiveKey((current) => {
        if (command === "open") return itemKey;
        if (command === "close") return current === itemKey ? null : current;
        return current === itemKey ? null : itemKey;
      });
    },
    [activeKey],
  );

  const dismiss = useCallback(() => {
    if (activeItem !== null) {
      setSuppressedTooltipKey(footerItemKey(activeItem));
    }
    setActiveKey(null);
  }, [activeItem]);

  useLayoutEffect(() => {
    if (suppressedTooltipItem === null || activeItem !== null) return;
    document
      .getElementById(footerTriggerId(suppressedTooltipItem))
      ?.focus({ preventScroll: true });
  }, [activeItem, suppressedTooltipItem]);

  const clearTooltipSuppression = useCallback((itemKey: string) => {
    setSuppressedTooltipKey((current) =>
      current === itemKey ? null : current,
    );
  }, []);

  useEffect(() => {
    if (activeItem === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeItem, dismiss]);

  return {
    activeItem,
    activeKey: activeItem === null ? null : activeKey,
    suppressedTooltipKey,
    clearTooltipSuppression,
    dismiss,
    handleCommand,
  };
}

export function PluginSidebarFooterDisclosure({
  item,
  onDismiss,
}: {
  item: PluginSidebarFooterItemSlot | null;
  onDismiss: () => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const measure = () =>
      setContentHeight(content.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [item]);

  if (item === null || item.kind !== "disclosure") return null;
  const Component = item.component;
  return (
    <section
      id={footerDisclosureId(item)}
      aria-label={item.label}
      data-testid={`plugin-sidebar-footer-disclosure-${item.pluginId}-${item.id}`}
      className="overflow-hidden rounded-lg border border-sidebar-border bg-sidebar-accent/50 transition-[height] duration-200 ease-out motion-reduce:transition-none group-data-[collapsible=icon]:hidden"
      style={{ height: contentHeight ?? undefined }}
    >
      <div ref={contentRef} className="max-h-80 overflow-auto">
        <PluginSlotMount
          pluginId={item.pluginId}
          slotKind="experimental_sidebarFooter"
          slotId={item.id}
        >
          <Component dismiss={onDismiss} />
        </PluginSlotMount>
      </div>
    </section>
  );
}

export function PluginSidebarFooterItems({
  activeDisclosureKey,
  suppressedTooltipKey,
  onTooltipSuppressionEnd,
  onDisclosureCommand,
  onNavigate,
}: {
  activeDisclosureKey: string | null;
  suppressedTooltipKey: string | null;
  onTooltipSuppressionEnd: (itemKey: string) => void;
  onDisclosureCommand: (
    itemKey: string,
    command: ExperimentalSidebarFooterCommandKind,
    sequence?: number,
  ) => void;
  onNavigate?: () => void;
}) {
  const { sidebarFooterItems } = usePluginSlots();
  if (sidebarFooterItems.length === 0) return null;
  return (
    <>
      {sidebarFooterItems.map((item) => (
        <SidebarFooterItemButton
          key={footerItemKey(item)}
          item={item}
          isActive={footerItemKey(item) === activeDisclosureKey}
          isTooltipSuppressed={footerItemKey(item) === suppressedTooltipKey}
          onTooltipSuppressionEnd={onTooltipSuppressionEnd}
          onDisclosureCommand={onDisclosureCommand}
          onNavigate={onNavigate}
        />
      ))}
    </>
  );
}

function SidebarFooterItemButton({
  item,
  isActive,
  isTooltipSuppressed,
  onTooltipSuppressionEnd,
  onDisclosureCommand,
  onNavigate,
}: {
  item: PluginSidebarFooterItemSlot;
  isActive: boolean;
  isTooltipSuppressed: boolean;
  onTooltipSuppressionEnd: (itemKey: string) => void;
  onDisclosureCommand: (
    itemKey: string,
    command: ExperimentalSidebarFooterCommandKind,
    sequence?: number,
  ) => void;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const snapshot = useSyncExternalStore(
    item.runtime.subscribe,
    item.runtime.getSnapshot,
    item.runtime.getSnapshot,
  );
  const command = snapshot.command;
  const itemKey = footerItemKey(item);

  useEffect(() => {
    if (command === null || item.kind !== "disclosure") return;
    onDisclosureCommand(itemKey, command.kind, command.sequence);
    item.runtime.acknowledgeCommand(command.sequence);
  }, [command, item, itemKey, onDisclosureCommand]);

  return (
    <SidebarMenuItem className="min-w-0">
      <SidebarMenuButton
        id={footerTriggerId(item)}
        type="button"
        aria-label={item.label}
        tooltip={{
          children: item.label,
          hidden: isTooltipSuppressed,
          side: "top",
        }}
        className={cn(
          SIDEBAR_FOOTER_ACTION_CLASS,
          isActive &&
            "bg-sidebar-accent text-sidebar-accent-foreground [&>svg]:opacity-100",
        )}
        data-testid={
          item.source === "sidebarFooterAction"
            ? `plugin-sidebar-footer-action-${item.pluginId}-${item.id}`
            : `plugin-sidebar-footer-item-${item.pluginId}-${item.id}`
        }
        onBlur={() => onTooltipSuppressionEnd(itemKey)}
        onPointerLeave={() => onTooltipSuppressionEnd(itemKey)}
        {...(item.kind === "disclosure"
          ? {
              "aria-expanded": isActive,
              "aria-controls": footerDisclosureId(item),
            }
          : {})}
        onClick={() => {
          if (item.kind === "disclosure") {
            onDisclosureCommand(itemKey, "toggle");
            return;
          }
          onNavigate?.();
          runContainedFooterCallback(
            item.pluginId,
            item.source === "sidebarFooterAction"
              ? `sidebarFooterAction "${item.id}"`
              : `experimental_sidebarFooter item "${item.id}"`,
            () =>
              item.onActivate({
                openPluginDetails: () => {
                  void navigate(
                    getPluginConfigurationRoutePath({
                      pluginId: item.pluginId,
                    }),
                  );
                },
              }),
          );
        }}
      >
        {item.source === "sidebarFooterAction" ? (
          <PluginIcon pluginId={item.pluginId} icon={item.icon} />
        ) : (
          <Icon
            name={pluginIconName(item.icon)}
            className="size-4 shrink-0"
            aria-hidden="true"
          />
        )}
        <span className="sr-only">{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function runContainedFooterCallback(
  pluginId: string,
  label: string,
  callback: () => void | Promise<void>,
): void {
  const warn = (error: unknown) => {
    console.warn(
      `[plugin:${pluginId}] ${label} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };
  try {
    const result = callback();
    if (result instanceof Promise) result.catch(warn);
  } catch (error) {
    warn(error);
  }
}
