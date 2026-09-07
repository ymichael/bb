import { useState, type ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";

interface AnimatedBodyProps {
  id: string;
  labelledBy: string;
  isExpanded: boolean;
  collapsedBorder: "reserve" | "none";
  children: ReactNode;
}

export function AnimatedBody({
  id,
  labelledBy,
  isExpanded,
  collapsedBorder,
  children,
}: AnimatedBodyProps) {
  const [hasRealizedBody, setHasRealizedBody] = useState(isExpanded);
  if (isExpanded && !hasRealizedBody) {
    setHasRealizedBody(true);
  }
  const isBodyRealized = hasRealizedBody || isExpanded;

  return (
    <section
      id={id}
      role="region"
      aria-labelledby={labelledBy}
      aria-hidden={!isExpanded}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
        isExpanded
          ? "grid-rows-[1fr] border-t border-border opacity-100"
          : cn(
              "pointer-events-none grid-rows-[0fr] opacity-0",
              collapsedBorder === "reserve" && "border-t border-transparent",
            ),
      )}
    >
      <div className="overflow-hidden bg-popover">
        {isBodyRealized ? children : null}
      </div>
    </section>
  );
}
