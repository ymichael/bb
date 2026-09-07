import { useId, useState } from "react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";

export const PLUGIN_DETAIL_PRIMARY_COLUMN_CLASS = "w-40 md:w-48";

export const PLUGIN_DETAIL_HEADER_CELL_CLASS = "bg-surface-recessed/55";

const DETAIL_ROW_GRID =
  "grid grid-cols-[10rem_minmax(0,1fr)] md:grid-cols-[12rem_minmax(0,1fr)]";

export function PluginDetailTable({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border bg-card align-top">
      <table className="block w-full max-w-full border-collapse text-left">
        <tbody className="block divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

const CELL = "py-1.5 align-top text-sm leading-snug";

export function PluginDetailFieldRow({
  label,
  children,
  labelClassName,
  stackOnNarrow = false,
}: {
  label: ReactNode;
  children: ReactNode;
  labelClassName?: string;
  stackOnNarrow?: boolean;
}) {
  if (stackOnNarrow) {
    return (
      <tr className="grid w-full grid-cols-1 sm:grid-cols-[10rem_minmax(0,1fr)] md:grid-cols-[12rem_minmax(0,1fr)]">
        <th
          scope="row"
          className={cn(
            CELL,
            PLUGIN_DETAIL_HEADER_CELL_CLASS,
            "block w-full border-b border-border px-4 text-left text-xs font-normal text-muted-foreground sm:w-auto sm:border-b-0 sm:border-r sm:pl-4 sm:pr-2",
            labelClassName,
          )}
        >
          {label}
        </th>
        <td className="block min-w-0 w-full px-4 py-3 align-top text-left text-sm leading-snug text-foreground sm:w-auto sm:py-1.5 sm:pl-2 sm:pr-4">
          {children}
        </td>
      </tr>
    );
  }

  return (
    <tr className={DETAIL_ROW_GRID}>
      <th
        scope="row"
        className={cn(
          CELL,
          PLUGIN_DETAIL_HEADER_CELL_CLASS,
          "border-r border-border pl-4 pr-2 text-left text-xs font-normal text-muted-foreground",
          labelClassName,
        )}
      >
        {label}
      </th>
      <td className={cn(CELL, "pl-2 pr-4 text-left text-foreground")}>
        {children}
      </td>
    </tr>
  );
}

export function PluginDetailGlyph({
  icon,
  label,
  className,
}: {
  icon: IconName;
  label: string;
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={label}
            tabIndex={0}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name={icon} className={cn("size-4", className)} aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PluginDetailRow({
  glyph,
  name,
  nameClassName,
  mono = false,
  detail,
}: {
  glyph: ReactNode;
  name: ReactNode;
  nameClassName?: string;
  mono?: boolean;
  detail: ReactNode;
}) {
  const hasDetail = detail !== null && detail !== undefined && detail !== "";
  const detailId = useId();
  const [expanded, setExpanded] = useState(false);
  const isLongDescription = typeof detail === "string" && detail.length > 180;
  return (
    <tr className={hasDetail ? DETAIL_ROW_GRID : "grid grid-cols-1"}>
      <th
        scope="row"
        className={cn(
          CELL,
          PLUGIN_DETAIL_HEADER_CELL_CLASS,
          "flex items-center text-left font-normal",
          hasDetail ? "border-r border-border pl-4 pr-2" : "px-4",
        )}
        colSpan={hasDetail ? undefined : 2}
      >
        <span className="flex min-w-0 items-center gap-2">
          {}
          <span className="flex shrink-0">{glyph}</span>
          <span
            className={cn(
              "min-w-0 break-words text-foreground",
              mono && "font-mono",
              nameClassName,
            )}
          >
            {name}
          </span>
        </span>
      </th>
      {hasDetail ? (
        <td
          id={detailId}
          className={cn(
            CELL,
            "pl-2 pr-4 text-xs leading-normal text-muted-foreground",
          )}
        >
          <div
            className={cn(
              "space-y-2 break-words leading-relaxed",
              isLongDescription && !expanded && "line-clamp-3",
            )}
          >
            {detail}
          </div>
          {isLongDescription ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={detailId}
              className="mt-2 rounded-sm text-xs font-medium text-subtle-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "Show less" : "Show full description"}
            </button>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}
