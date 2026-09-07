import type { ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "@/theme/ThemeProvider";
import { cn } from "./cn";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

export interface EmptyStateProps {
  message: string;
  icon?: IconName;
  className?: string;
}

export function EmptyState({ message, icon, className }: EmptyStateProps) {
  const { tokens } = useTheme();
  return (
    <View className={cn("flex-row items-center gap-2", className)}>
      {icon ? (
        <Icon name={icon} size={16} color={tokens.subtleForeground} />
      ) : null}
      <Text className="shrink text-xs text-muted-foreground">{message}</Text>
    </View>
  );
}

export interface EmptyStatePanelProps {
  children: ReactNode;
  className?: string;
}

export function EmptyStatePanel({ children, className }: EmptyStatePanelProps) {
  return (
    <View
      className={cn(
        "items-center rounded-md border border-dashed border-border px-3 py-6",
        className,
      )}
    >
      {typeof children === "string" ? (
        <Text className="text-center text-sm text-muted-foreground">
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}
