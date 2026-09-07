import { Fragment } from "react";
import { Pressable, View } from "react-native";
import { haptic } from "@/lib/haptics";
import { useTheme } from "@/theme/ThemeProvider";
import { cn } from "./cn";
import { GROUPED_CARD_RADIUS } from "./Grouped";
import { Icon, type IconName } from "./Icon";
import { ListRow, LIST_ROW_ICON_SIZE } from "./ListRow";
import { Separator, SEPARATOR_INSET } from "./Separator";
import { Sheet, type SheetController, type SheetProps } from "./Sheet";
import { Text } from "./Text";

const IS_IOS = process.env.EXPO_OS === "ios";

export interface ActionSheetAction {
  key: string;
  label: string;
  subtitle?: string;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onPress: () => void;
}

export interface ActionSheetProps {
  controller: SheetController;
  title?: string;
  message?: string;
  actions: readonly ActionSheetAction[];
  onDismiss?: () => void;
  stackBehavior?: SheetProps["stackBehavior"];
}

const ACTION_SEPARATOR_INSET = SEPARATOR_INSET + LIST_ROW_ICON_SIZE + 12;

export function ActionSheet({
  controller,
  title,
  message,
  actions,
  onDismiss,
  stackBehavior,
}: ActionSheetProps) {
  const { tokens } = useTheme();
  const hasHeader = Boolean(title || message);
  const hasIcons = actions.some((action) => action.icon);
  const card = {
    borderRadius: GROUPED_CARD_RADIUS,
    borderCurve: "continuous" as const,
  };
  return (
    <Sheet
      controller={controller}
      onDismiss={onDismiss}
      stackBehavior={stackBehavior}
      surface="grouped"
    >
      <View className="gap-2 px-4 pt-1">
        <View className="overflow-hidden bg-surface-grouped-cell" style={card}>
          {hasHeader ? (
            <View className="items-center gap-0.5 px-4 pb-3 pt-3">
              {title ? (
                <Text
                  variant="footnote"
                  tone="muted"
                  weight="semibold"
                  numberOfLines={2}
                  className="text-center"
                >
                  {title}
                </Text>
              ) : null}
              {message ? (
                <Text variant="caption" className="text-center">
                  {message}
                </Text>
              ) : null}
            </View>
          ) : null}
          {actions.map((action, index) => (
            <Fragment key={action.key}>
              {index > 0 || hasHeader ? (
                <Separator
                  inset={hasIcons ? ACTION_SEPARATOR_INSET : SEPARATOR_INSET}
                />
              ) : null}
              <ListRow
                title={action.label}
                subtitle={action.subtitle}
                leading={
                  action.icon ? (
                    <Icon
                      name={action.icon}
                      size={LIST_ROW_ICON_SIZE}
                      color={
                        action.destructive
                          ? tokens.destructiveText
                          : tokens.foreground
                      }
                    />
                  ) : undefined
                }
                destructive={action.destructive}
                disabled={action.disabled}
                selected={action.checked === true}
                onPress={() => {
                  if (action.destructive) haptic("warning");
                  controller.dismiss();
                  action.onPress();
                }}
                testID={`action-sheet-${action.key}`}
              />
            </Fragment>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={controller.dismiss}
          className={cn(
            "min-h-[50px] items-center justify-center overflow-hidden bg-surface-grouped-cell px-4",
            IS_IOS ? "active:bg-state-active" : "active:bg-state-hover",
          )}
          style={card}
          testID="action-sheet-cancel"
        >
          <Text variant="bodyLarge" weight="semibold" tone="primary">
            Cancel
          </Text>
        </Pressable>
      </View>
    </Sheet>
  );
}
