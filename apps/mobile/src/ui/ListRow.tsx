import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useTheme } from "@/theme/ThemeProvider";
import { cn } from "./cn";
import { Icon, isIconName, type IconName } from "./Icon";
import { Text } from "./Text";

const IS_IOS = process.env.EXPO_OS === "ios";

export const LIST_ROW_CHEVRON_SIZE = IS_IOS ? 14 : 18;
export const LIST_ROW_ICON_SIZE = 20;

export interface ListRowProps {
  title: string;
  subtitle?: string;
  leading?: IconName | ReactNode;
  leadingTone?: "foreground" | "primary";
  trailing?: "chevron" | ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  titleLines?: number;
  className?: string;
  accessibilityLabel?: string;
  testID?: string;
}

export function SelectedCheck() {
  const { tokens } = useTheme();
  return (
    <Icon name="Check" size={18} weight="semibold" color={tokens.primary} />
  );
}

export function DisclosureChevron() {
  const { tokens } = useTheme();
  return (
    <Icon
      name="ChevronRight"
      size={LIST_ROW_CHEVRON_SIZE}
      weight="semibold"
      color={tokens.subtleForeground}
    />
  );
}

export function ListRow({
  title,
  subtitle,
  leading,
  leadingTone = "foreground",
  trailing,
  onPress,
  onLongPress,
  selected = false,
  destructive = false,
  disabled = false,
  titleLines = 1,
  className,
  accessibilityLabel,
  testID,
}: ListRowProps) {
  const { tokens } = useTheme();
  const interactive = Boolean(onPress || onLongPress);
  const titleColor = destructive ? tokens.destructiveText : tokens.foreground;
  const leadingColor = destructive
    ? tokens.destructiveText
    : leadingTone === "primary"
      ? tokens.primary
      : tokens.foreground;
  const trailingNode =
    trailing === "chevron" ? (
      <DisclosureChevron />
    ) : trailing === undefined || trailing === null ? (
      selected ? (
        <SelectedCheck />
      ) : null
    ) : (
      trailing
    );
  const layoutClassName = cn(
    "min-h-[44px] flex-row items-center gap-3 px-4 py-2",
    disabled && "opacity-50",
    className,
  );
  const content = (
    <>
      {isIconName(leading) ? (
        <Icon name={leading} size={LIST_ROW_ICON_SIZE} color={leadingColor} />
      ) : (
        leading
      )}
      <View className="min-w-0 flex-1">
        <Text
          variant="bodyLarge"
          numberOfLines={titleLines}
          style={{ color: titleColor }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text variant="body" tone="muted" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailingNode}
    </>
  );
  if (!interactive) {
    return (
      <View className={layoutClassName} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      className={cn(
        layoutClassName,
        IS_IOS ? "active:bg-state-active" : "active:bg-state-hover",
      )}
    >
      {content}
    </Pressable>
  );
}
