import { Toaster, type ToasterProps } from "@/components/ui/sonner.js";
import { usePreferredTheme } from "@/hooks/useTheme";

export function AppToaster(props: ToasterProps) {
  const theme = usePreferredTheme();

  return <Toaster theme={theme} {...props} />;
}
