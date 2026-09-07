import {
  Switch as RNSwitch,
  type SwitchProps as RNSwitchProps,
} from "react-native";
import { useTheme } from "@/theme/ThemeProvider";

const IS_IOS = process.env.EXPO_OS === "ios";

export interface SwitchProps extends Omit<
  RNSwitchProps,
  "value" | "onValueChange" | "style"
> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  size?: "default" | "sm";
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  size = "default",
  disabled,
  className,
  ...props
}: SwitchProps) {
  const { tokens, palette } = useTheme();
  const colors = IS_IOS
    ? palette === "default"
      ? {}
      : { trackColor: { true: tokens.primary } }
    : {
        trackColor: { false: tokens.muted, true: tokens.foreground },
        thumbColor: tokens.background,
      };
  return (
    <RNSwitch
      value={checked}
      onValueChange={onCheckedChange}
      disabled={disabled}
      {...colors}
      className={className}
      style={
        !IS_IOS && size === "sm" ? { transform: [{ scale: 0.8 }] } : undefined
      }
      {...props}
    />
  );
}
