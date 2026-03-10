import { cn } from "@/lib/utils";

interface ConversationStatusIndicatorProps {
  label: string;
  className?: string;
}

export function ConversationStatusIndicator({
  label,
  className,
}: ConversationStatusIndicatorProps) {
  return (
    <div className={cn("px-2 text-sm text-muted-foreground", className)}>
      <span className="animate-shine">{label}</span>
    </div>
  );
}
