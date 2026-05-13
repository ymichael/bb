import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon.js";

interface CopyButtonProps {
  text: string;
  className?: string;
  iconClassName?: string;
  label?: string;
}

export function CopyButton({
  text,
  className,
  iconClassName,
  label = "Copy to clipboard",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const handleCopy = async () => {
    if (!text || copied) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-5 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:opacity-100",
        className,
      )}
      onClick={() => {
        void handleCopy();
      }}
      aria-label={label}
      title={label}
    >
      {copied ? (
        <Icon name="Check" className={cn("size-3", iconClassName)} />
      ) : (
        <Icon name="Copy" className={cn("size-3", iconClassName)} />
      )}
    </button>
  );
}
