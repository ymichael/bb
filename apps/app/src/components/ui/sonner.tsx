/* shadcn/ui-derived */
import { Toaster as Sonner, type ToasterProps } from "sonner";

export type { ToasterProps } from "sonner";

export function Toaster(props: ToasterProps) {
  return <Sonner {...props} />;
}
