import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useTheme } from "@/theme/ThemeProvider";
import { cn } from "./cn";
import { Icon, isIconName, type IconName } from "./Icon";
import {
  DisclosureChevron,
  LIST_ROW_ICON_SIZE,
  SelectedCheck,
} from "./ListRow";
import { Separator } from "./Separator";
import type { SFSymbol } from "./sf-symbol-map";
import { Text } from "./Text";

const IS_IOS = process.env.EXPO_OS === "ios";

export const GROUPED_CARD_RADIUS = 10;
export const GROUPED_ROW_PADDING_X = 16;
const GROUPED_ROW_GAP = 12;
export const ICON_BADGE_SIZE = 29;

export interface IconBadgeProps {
  icon: IconName;
  symbol?: SFSymbol;
  color: string;
  size?: number;
  glyphColor?: string;
  accessibilityLabel?: string;
}

export function IconBadge({
  icon,
  symbol,
  color,
  size = ICON_BADGE_SIZE,
  glyphColor = "#ffffff",
  accessibilityLabel,
}: IconBadgeProps) {
  const scale = size / ICON_BADGE_SIZE;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(7 * scale),
        borderCurve: "continuous",
        backgroundColor: color,
        alignItems: "center",
        justifyContent: "center",
      }}
      accessibilityElementsHidden={accessibilityLabel === undefined}
      importantForAccessibility={
        accessibilityLabel === undefined ? "no-hide-descendants" : "auto"
      }
      accessibilityLabel={accessibilityLabel}
    >
      <Icon
        name={icon}
        symbol={symbol}
        size={Math.round(18 * scale)}
        color={glyphColor}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

export interface GroupedRowProps {
  title: string;
  subtitle?: string;
  value?: string;
  valueTone?: "default" | "warning" | "destructive";
  leading?: IconName | ReactNode;
  leadingTone?: "foreground" | "primary";
  badge?: { icon: IconName; symbol?: SFSymbol; color: string };
  trailing?: "chevron" | "checkmark" | ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  selectable?: boolean;
  titleLines?: number;
  className?: string;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

export function GroupedRow({
  title,
  subtitle,
  value,
  valueTone = "default",
  leading,
  leadingTone = "foreground",
  badge,
  trailing,
  onPress,
  onLongPress,
  destructive = false,
  disabled = false,
  selectable = false,
  titleLines = 1,
  className,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: GroupedRowProps) {
  const { tokens } = useTheme();
  const interactive = Boolean(onPress || onLongPress);
  const titleColor = destructive ? tokens.destructiveText : tokens.foreground;
  const valueColor =
    valueTone === "warning"
      ? tokens.warningText
      : valueTone === "destructive"
        ? tokens.destructiveText
        : tokens.mutedForeground;
  const leadingColor = destructive
    ? tokens.destructiveText
    : leadingTone === "primary"
      ? tokens.primary
      : tokens.foreground;
  const leadingNode = badge ? (
    <IconBadge icon={badge.icon} symbol={badge.symbol} color={badge.color} />
  ) : isIconName(leading) ? (
    <Icon name={leading} size={LIST_ROW_ICON_SIZE} color={leadingColor} />
  ) : (
    leading
  );
  const trailingNode =
    trailing === "chevron" ? (
      <DisclosureChevron />
    ) : trailing === "checkmark" ? (
      <SelectedCheck />
    ) : (
      trailing
    );
  const layoutClassName = cn(
    "min-h-[44px] flex-row items-center gap-3 px-4 py-2.5",
    disabled && "opacity-50",
    className,
  );
  const content = (
    <>
      {leadingNode}
      <View className="min-w-0 flex-1">
        <Text
          variant="bodyLarge"
          numberOfLines={titleLines}
          selectable={selectable}
          style={{ color: titleColor }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" numberOfLines={3} selectable={selectable}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text
          variant="bodyLarge"
          numberOfLines={1}
          selectable={selectable}
          className="max-w-[55%] shrink"
          style={{ color: valueColor }}
        >
          {value}
        </Text>
      ) : null}
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
      accessibilityLabel={
        accessibilityLabel ?? (value ? `${title}: ${value}` : undefined)
      }
      accessibilityHint={accessibilityHint}
      accessibilityState={{
        disabled,
        selected: trailing === "checkmark" ? true : undefined,
      }}
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

export interface GroupedSectionProps {
  title?: string;
  footer?: string | ReactNode;
  action?: ReactNode;
  children: ReactNode;
  separatorInset?: number | "text";
  surface?: GroupedSurface;
  description?: string;
  className?: string;
  testID?: string;
}

export type GroupedSurface = "grouped" | "raised";

function rowTextInset(child: ReactNode): number {
  if (!isValidElement<{ badge?: unknown; leading?: unknown }>(child)) {
    return GROUPED_ROW_PADDING_X;
  }
  if (child.props.badge) {
    return GROUPED_ROW_PADDING_X + ICON_BADGE_SIZE + GROUPED_ROW_GAP;
  }
  if (child.props.leading !== undefined && child.props.leading !== null) {
    return GROUPED_ROW_PADDING_X + LIST_ROW_ICON_SIZE + GROUPED_ROW_GAP;
  }
  return GROUPED_ROW_PADDING_X;
}

export function GroupedSection({
  title,
  footer,
  action,
  children,
  separatorInset = "text",
  surface = "grouped",
  description,
  className,
  testID,
}: GroupedSectionProps) {
  const { tokens, mode } = useTheme();
  const cardColor =
    surface === "raised" && mode === "dark"
      ? tokens.surfaceRaised
      : tokens.surfaceGroupedCell;
  const rows = Children.toArray(children);
  return (
    <View className={cn("gap-2", className)} testID={testID}>
      {title || action ? (
        <View className="flex-row items-end justify-between gap-3 px-4">
          {title ? (
            <Text variant="sectionLabel" numberOfLines={1} className="shrink">
              {title}
            </Text>
          ) : (
            <View />
          )}
          {action}
        </View>
      ) : null}
      {description ? (
        <Text variant="caption" className="px-4">
          {description}
        </Text>
      ) : null}
      <View
        className="overflow-hidden"
        style={{
          borderRadius: GROUPED_CARD_RADIUS,
          borderCurve: "continuous",
          backgroundColor: cardColor,
        }}
      >
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <Separator
                inset={
                  separatorInset === "text" ? rowTextInset(row) : separatorInset
                }
              />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? (
        typeof footer === "string" ? (
          <Text variant="footnote" tone="muted" className="px-4">
            {footer}
          </Text>
        ) : (
          <View className="px-4">{footer}</View>
        )
      ) : null}
    </View>
  );
}
