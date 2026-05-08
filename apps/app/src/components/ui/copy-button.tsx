import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

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
        <Check className={cn("size-3", iconClassName)} />
      ) : (
        <Copy className={cn("size-3", iconClassName)} />
      )}
    </button>
  );
}
