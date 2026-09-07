import type { CSSProperties, ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { neutral } from "./showcase-tokens";

export function Bar({
  width,
  strength = 12,
  className,
}: {
  width: string;
  strength?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("h-1.5 rounded-full", className)}
      style={{ width, background: neutral(strength) }}
    />
  );
}

export function SceneCard({
  children,
  className,
  style,
}: {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn("rounded-md border p-1.5", className)}
      style={{
        background: "var(--canvas)",
        borderColor: neutral(11),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SceneLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-2xs font-medium" style={{ color: neutral(52) }}>
      {children}
    </span>
  );
}
