import { cn } from "@bb/shared-ui/lib/utils";
import bbLogoUrl from "../../../../../assets/bb-logo.svg";

export function BbLogo({ className = "size-4" }: { className?: string }) {
  return (
    <img
      src={bbLogoUrl}
      alt=""
      aria-hidden="true"
      className={cn(className, "object-contain dark:invert")}
    />
  );
}
