import { Toaster, type ToasterProps } from "@/components/ui";
import { usePreferredTheme } from "@/hooks/useTheme";

export function AppToaster(props: ToasterProps) {
  const theme = usePreferredTheme();

  return <Toaster theme={theme} {...props} />;
}
