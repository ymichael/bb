import {
  createContext,
  useContext,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "../src/components/ui";

const ROW_GRID =
  "grid grid-cols-[var(--story-label-width,210px)_minmax(0,1fr)] gap-x-4";

function labelWidthStyle(
  labelWidth: string | undefined,
): CSSProperties | undefined {
  if (!labelWidth) return undefined;
  return { "--story-label-width": labelWidth } as CSSProperties;
}

const StoryCardContext = createContext({ inGrid: false });

export interface StoryCardProps {
  children: ReactNode;
  className?: string;
  labelWidth?: string;
  /**
   * When provided, lays out children as a column-aligned grid: each StoryRow
   * child fills one column and the labels render as a header row.
   */
  columns?: readonly string[];
}

export function StoryCard({
  children,
  className,
  labelWidth,
  columns,
}: StoryCardProps) {
  if (columns && columns.length > 0) {
    const style: CSSProperties = {
      "--story-label-width": labelWidth ?? "210px",
      gridTemplateColumns: `var(--story-label-width) repeat(${columns.length}, minmax(0, 1fr))`,
    } as CSSProperties;
    return (
      <StoryCardContext.Provider value={{ inGrid: true }}>
        <div
          className={cn(
            "m-6 grid items-center justify-items-start gap-x-4 gap-y-3 rounded-md px-4 py-3",
            className,
          )}
          style={style}
        >
          <span aria-hidden="true" />
          {columns.map((column, index) => (
            <span
              key={index}
              className="text-xs font-medium text-muted-foreground"
            >
              {column}
            </span>
          ))}
          {children}
        </div>
      </StoryCardContext.Provider>
    );
  }
  return (
    <StoryCardContext.Provider value={{ inGrid: false }}>
      <div
        className={cn(
          "m-6 flex flex-col rounded-md",
          className,
        )}
        style={labelWidthStyle(labelWidth)}
      >
        {children}
      </div>
    </StoryCardContext.Provider>
  );
}

export interface StoryRowProps {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function StoryRow({
  label,
  hint,
  children,
  className,
}: StoryRowProps) {
  const { inGrid } = useContext(StoryCardContext);

  const labelEl = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {hint ? (
        <span className="text-xs break-words text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  );

  if (inGrid) {
    return (
      <>
        {labelEl}
        {children}
      </>
    );
  }
  return (
    <div className={cn(ROW_GRID, "items-start px-4 py-3", className)}>
      {labelEl}
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {children}
      </div>
    </div>
  );
}
