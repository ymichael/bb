import { cn } from "./cn.js";

export interface FormErrorProps {
  message?: string | null;
  className?: string;
}

export function FormError({ message, className }: FormErrorProps) {
  if (!message) {
    return null;
  }

  return (
    <p
      className={cn(
        "rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive",
        className,
      )}
    >
      {message}
    </p>
  );
}
