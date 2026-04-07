import type { ReactNode } from "react";
import { Pill, type PillVariant } from "./pill.js";

export type StatusPillVariant = PillVariant;

export interface StatusPillProps {
  variant: StatusPillVariant;
  className?: string;
  children: ReactNode;
}

export function StatusPill({ variant, className, children }: StatusPillProps) {
  return (
    <Pill variant={variant} className={className}>
      {children}
    </Pill>
  );
}
