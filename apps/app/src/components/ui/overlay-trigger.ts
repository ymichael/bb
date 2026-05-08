import { cn } from "@/lib/utils";

const OVERLAY_TRIGGER_CLASS_NAME = "select-none";

type OverlayTriggerClassNameResolver = (className?: string) => string;

export const getOverlayTriggerClassName: OverlayTriggerClassNameResolver = (
  className,
) => cn(OVERLAY_TRIGGER_CLASS_NAME, className);
